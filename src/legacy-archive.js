import {readFile,stat} from 'node:fs/promises'
import {dirname,join,basename} from 'node:path'
import {zstdDecompressSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {TextDecoder} from 'node:util'
const MAX_BYTES=128*1024*1024,MAX_DECODED=256*1024*1024
// Locate standard Zstandard frames. Decoding each frame separately matters:
// node:zlib's single-shot decoder reads only the first concatenated frame.
// This scanner rejects torn bytes instead of accepting a partial archive.
export function zstdFrames(buffer){
 const frames=[];let offset=0
 const need=n=>{if(offset+n>buffer.length)throw Error('旧会话压缩文件不完整，拒绝部分归档')}
 while(offset<buffer.length){const start=offset;need(5)
  if(buffer.readUInt32LE(offset)!==0xfd2fb528)throw Error('旧会话压缩格式无效');offset+=4
  const d=buffer[offset++];if(d&24)throw Error('旧会话压缩格式无效')
  const sizeFlag=d>>>6,single=!!(d&32),dict=d&3,header=(single?0:1)+(dict===3?4:dict)+(sizeFlag===0?(single?1:0):1<<sizeFlag)
  need(header);offset+=header
  for(;;){need(3);const block=buffer.readUIntLE(offset,3);offset+=3;const kind=(block>>>1)&3
   if(kind===3)throw Error('旧会话压缩格式无效');const size=kind===1?1:block>>>3;need(size);offset+=size;if(block&1)break}
  if(d&4){need(4);offset+=4}frames.push([start,offset])
 }return frames
}
export async function legacyCodec(version){
 if(version===0||version===1){const m=await import('@deepseek-ai/dsh-session-format-v0-to-v1');return version===0?m.releasedV0SessionFormatCodec:m.releasedV1SessionFormatCodec}
 if(version===2)return (await import('@deepseek-ai/dsh-session-format-v1-to-v2')).releasedV2SessionFormatCodec
 if(version===3)return (await import('@deepseek-ai/dsh-session-format-v2-to-v3')).releasedV3SessionFormatCodec
 throw Error('旧会话格式不受支持')
}
export async function decodeLegacyBytes(bytes,compressed=true,{recoverSequence=false}={}){
 const pieces=[];let decoded=0
 for(const [a,b] of compressed?zstdFrames(bytes):[[0,bytes.length]]){
  const piece=compressed?zstdDecompressSync(bytes.subarray(a,b),{maxOutputLength:32*1024*1024}):bytes
  decoded+=piece.length;if(decoded>MAX_DECODED)throw Error('旧会话解码内容过大');pieces.push(piece)
 }
 const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces))
 if(!text.endsWith('\n'))throw Error('旧会话最后一条记录不完整')
 const lines=text.slice(0,-1).split('\n'),physical=JSON.parse(lines.shift()),codec=await legacyCodec(physical.version)
 const rows=lines.map(line=>JSON.parse(line))
 // Bound expansion before invoking the released decoder: a tiny physical row
 // can otherwise request an enormous source-reference range.
 for(const row of rows)if(Array.isArray(row.sourceEventSeqs)){
  let count=0
  for(const value of row.sourceEventSeqs){count+=Array.isArray(value)&&value.length===2?Math.max(0,value[1]-value[0]+1):1
   if(count>1000000)throw Error('旧会话引用数量过大')}
 }

 const strict=()=>{
  const decoder=codec.createDecoder(physical,'strict'),events=[]
  const emitEvent=event=>{if(event.seq!==events.length)throw Error('原文序号不连续，拒绝遗漏归档');events.push(event)}
  const collector={emitEvent,emitRun:run=>{for(const event of run.expand())emitEvent(event)}}
  for(const row of rows)decoder.decodeRow(row,collector)
  const inheritedEventCount=decoder.finish(collector)
  return {header:decoder.header,events,inheritedEventCount}
 }
 try{return strict()}catch(error){if(!recoverSequence||!/has seq gap/.test(error.message))throw error}
 // Recovery is an evidence archive, NOT a repaired DSH session. Several writers
 // can interleave conflicting sequences. Validate every physical row with the
 // released codec, retain its original event sequence and all duplicate records,
 // and expose a separate physical-order ordinal for recall. Never feed this to
 // current-format reconstruction, summarization or compaction.
 const decoder=codec.createDecoder(physical,'strict'),entries=[];let rowIndex=0,sourceSeq=0,rowStart=0,discontinuities=0,expected=0,sourceEventSeqs
 const emitEvent=event=>{
  if(entries.length>=1000000)throw Error('旧会话事件数量过大')
  const seq=sourceSeq+event.seq-rowStart
  if(!Number.isSafeInteger(seq)||seq<0)throw Error('原文序号无效')
  entries.push({ordinal:entries.length,sourceRow:rowIndex,event:{...event,seq,...(sourceEventSeqs===undefined?{}:{sourceEventSeqs})}})
 }
 const collector={emitEvent,emitRun:run=>{for(const event of run.expand())emitEvent(event)}}
 for(const [i,row] of rows.entries()){
  rowIndex=i+1;const key=Object.hasOwn(row,'seq0')?'seq0':'seq';sourceSeq=row[key];rowStart=entries.length
  if(!Number.isSafeInteger(sourceSeq)||sourceSeq<0)throw Error('原文序号无效')
  if(sourceSeq!==expected)discontinuities++
  // Source references are validated against the ORIGINAL sequence bound. Using
  // the archive ordinal here could accept invalid references or reject a valid
  // forward-numbered row. The validator parses before checking continuity.
  const validator=codec.createDecoder(physical,'strict')
  try{validator.decodeRow(row,{emitEvent(){},emitRun(){}})}catch(error){if(!/has seq gap/.test(error.message))throw error}
  sourceEventSeqs=row.sourceEventSeqs===undefined?undefined:row.sourceEventSeqs.flatMap(x=>Array.isArray(x)?Array.from({length:x[1]-x[0]+1},(_,i)=>x[0]+i):[x])
  const normalized={...row,[key]:rowStart};delete normalized.sourceEventSeqs
  decoder.decodeRow(normalized,collector)
  expected=sourceSeq+entries.length-rowStart
 }
 const inheritedEventCount=decoder.finish(collector)
 return {header:decoder.header,events:entries.map(x=>x.event),inheritedEventCount,recovery:{mode:'physical-order',discontinuities,physicalRows:rows.length,entries}}

}
export async function readLegacyArchive(ctx,persistence,id,from=0,{recoverSequence=false}={}){
 const row=(await ctx.sessionQuery.listSessions()).find(row=>row.header.id===id)
 if(!row)throw Error('旧会话来源未找到')
 const location=persistence.locate?.(row.header)
 if(location?.kind!=='jsonl'||!/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(basename(location.path)))throw Error('旧会话原始文件位置不可用')
 const compressed=location.path.endsWith('.zstd'),suffix=compressed?'.zstd':''
 // The host selected the newest generation. Never bypass an existing current
 // artifact, even if its validation fails. Only retained historical files qualify.
 try{await stat(location.path);throw Error('当前会话文件已存在，拒绝回读过期记录')}catch(e){if(e.code!=='ENOENT')throw e}
 let source
 for(const name of ['session.v3.jsonl','session.v2.jsonl','session.v1.jsonl','session.jsonl']){
  const path=join(dirname(location.path),name+suffix)
  try{const metadata=await stat(path,{bigint:true});source={path,metadata};break}catch(e){if(e.code!=='ENOENT')throw e}
 }
 if(!source||source.metadata.size>BigInt(MAX_BYTES))throw Error('旧会话文件不可用或过大')
 const bytes=await readFile(source.path),after=await stat(source.path,{bigint:true})
 if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>source.metadata[k]!==after[k])||BigInt(bytes.length)!==after.size)throw Error('旧会话读取期间发生变化')
 const raw=await decodeLegacyBytes(bytes,compressed,{recoverSequence})
 const expectedVersion=Number(basename(source.path).match(/^session(?:\.v(\d+))?\.jsonl/)?.[1]??0)
 if(raw.header.version!==expectedVersion)throw Error('旧会话格式版本与文件名不匹配')
 for(const key of ['id','createdAt','cwd','parentSession','origin','isSeeded','delegationDepth','agentPreset']){
  if((raw.header[key]??(key==='delegationDepth'?0:undefined))!==(row.header[key]??(key==='delegationDepth'?0:undefined)))throw Error('会话来源身份改变，原记录保留')
 }
 if(raw.header.id!==id)throw Error('会话来源身份改变，原记录保留')
 // A concurrent publication can happen while a large historical file decodes.
 try{await stat(location.path);throw Error('当前会话文件已存在，拒绝回读过期记录')}catch(e){if(e.code!=='ENOENT')throw e}
 return {...raw,legacyEvents:raw.events,events:raw.recovery?raw.recovery.entries.slice(from).map(x=>x.event):raw.events.filter(e=>e.seq>=from),legacy:true,legacySource:{version:raw.header.version,sha256:createHash('sha256').update(bytes).digest('hex'),bytes},close(){}}
}
