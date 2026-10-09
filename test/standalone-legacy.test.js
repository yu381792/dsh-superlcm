import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {zstdCompressSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {decodeLegacyBytes,readLegacyArchive,zstdFrames} from '../src/legacy-archive.js'
import {readRawDshSession} from '../src/raw-session.js'
import {ArchiveDatabase} from '../src/archive-db.js'
import {ArchiveService} from '../src/archive-service.js'
import {defaults,settingsDocument} from '../src/settings.js'
const physical={type:'session',version:0,id:'old',createdAt:1,cwd:'/project',delegationDepth:0}
const event=seq=>({type:'session/title',seq,time:seq+1,data:{title:'Historical title'}})
const plain=(rows=[event(0),event(1)])=>Buffer.from([physical,...rows].map(x=>JSON.stringify(x)).join('\n')+'\n')
const packed=(rows=[event(0),event(1)])=>Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(physical)+'\n')),zstdCompressSync(Buffer.from(rows.map(x=>JSON.stringify(x)).join('\n')+'\n'))])
const header={version:4,id:'old',createdAt:1,cwd:'/project',isSeeded:false,delegationDepth:0}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'sl-legacy-')),path=join(dir,'session.jsonl.zstd'),bytes=packed();writeFileSync(path,bytes)
 const persistence={async open(){throw Object.assign(Error('host migration rejected'),{name:'SessionFormatUnsupportedError'})},locate:()=>({kind:'jsonl',path:join(dir,'session.v4.jsonl.zstd')})}
 const ctx={sessionPersistence:persistence,sessionQuery:{listSessions:async()=>[{header}]}}
 return {dir,path,bytes,persistence,ctx}
}
test('all concatenated Zstandard frames are decoded; historical events retain source sequence and values',async()=>{
 const raw=await decodeLegacyBytes(packed());assert.equal(raw.events.length,2);assert.deepEqual(raw.events,[event(0),event(1)]);assert.equal(raw.header.version,0)
 assert.equal(zstdFrames(packed()).length,2)
 const uncompressed=await decodeLegacyBytes(plain(),false);assert.deepEqual(uncompressed.events,raw.events)
})
test('released formats one through three decode without running current-format migrations',async()=>{
 for(const version of [1,2,3]){
  const h={...physical,version,...(version>=2?{isSeeded:false}:{})},bytes=Buffer.from([h,event(0)].map(x=>JSON.stringify(x)).join('\n')+'\n')
  const raw=await decodeLegacyBytes(bytes,false);assert.equal(raw.header.version,version);assert.deepEqual(raw.events,[event(0)])
 }
})
test('torn frames, bad compressed bytes, event gaps and a torn JSON row never enter the archive',async()=>{
 await assert.rejects(()=>decodeLegacyBytes(packed().subarray(0,-1)),/不完整/)
 await assert.rejects(()=>decodeLegacyBytes(Buffer.from('wrong')),/格式无效/)
 await assert.rejects(()=>decodeLegacyBytes(packed([event(0),event(2)])),/seq gap|序号不连续/)
 await assert.rejects(()=>decodeLegacyBytes(plain().subarray(0,-1),false),/记录不完整/)
})
test('unsupported migration falls back to archive-only data, with incremental reads and exact physical evidence',async t=>{
 const f=fixture(t),raw=await readRawDshSession(f.ctx,'old',1)
 assert.equal(raw.legacy,true);assert.deepEqual(raw.events,[event(1)]);assert.deepEqual(raw.legacySource.bytes,f.bytes)
 assert.equal(raw.legacySource.sha256,createHash('sha256').update(f.bytes).digest('hex'))
 assert.deepEqual(readFileSync(f.path),f.bytes)
 const db=new ArchiveDatabase(join(f.dir,'lcm.sqlite'));t.after(()=>db.close());db.saveLegacySource('old',raw.legacySource)
 assert.deepEqual(Buffer.from(db.db.prepare('SELECT bytes FROM sl_legacy_sources WHERE session=?').get('old').bytes),f.bytes)
 assert.throws(()=>db.saveLegacySource('old',{...raw.legacySource,bytes:Buffer.from('changed')}),/校验失败/)
 const changed=Buffer.from('changed');assert.throws(()=>db.saveLegacySource('old',{version:0,bytes:changed,sha256:createHash('sha256').update(changed).digest('hex')}),/原文已改变/)
})
test('a current artifact or provenance mismatch prevents stale-source fallback',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'session.v4.jsonl.zstd'),packed());await assert.rejects(()=>readLegacyArchive(f.ctx,f.persistence,'old'),/当前会话文件已存在/)
 const g=fixture(t);g.ctx.sessionQuery.listSessions=async()=>[{header:{...header,createdAt:99}}];await assert.rejects(()=>readLegacyArchive(g.ctx,g.persistence,'old'),/来源身份改变/)
 const ctx={sessionPersistence:{async open(){throw Object.assign(Error('broken source'),{name:'SessionPersistenceCorruptionError'})}}};await assert.rejects(()=>readRawDshSession(ctx,'old'),/broken source/)
})
test('legacy capture does not rebuild compaction nodes, invoke summary models or modify the original source',async t=>{
 const f=fixture(t),file=join(f.dir,'settings.json');writeFileSync(file,JSON.stringify(settingsDocument({...defaults,summaryEnabled:true,summaryProvider:'local',summaryModel:'local'},'one')))
 const native={path:join(f.dir,'lcm.sqlite'),listNodes:()=>[]},ctx={...f.ctx,on(){},effect(){},tools:{register(){}},sessions:{get(){}},llm:{stream(){throw Error('must not call model')}}}
 const archive=new ArchiveService(ctx,native,file);t.after(()=>archive.close())
 archive.dirty.add('old');archive.jobs.add('old');await archive.drain()
 assert.equal(archive.lastError,undefined);assert.equal(archive.db.cursor('old'),2);assert.equal(archive.db.legacySource('old').version,0)
 assert.equal(await archive.summarize('old'),'legacy');assert.deepEqual(readFileSync(f.path),f.bytes)
 assert.deepEqual(archive.db.events('old').items.map(x=>JSON.parse(x.text)),[event(0),event(1)])
 ctx.sessions.get=()=>({header,seq:3,eventAt:seq=>event(seq)})
 archive.dirty.add('old');await archive.drain();assert.equal(archive.lastDiagnostic.code,'LEGACY_FORMAT_CHANGED');assert.equal(archive.db.cursor('old'),2)
})
test('legacy fallback verifies an existing prefix and a rejected archive creates no source marker',async t=>{
 const f=fixture(t),file=join(f.dir,'settings.json');writeFileSync(file,JSON.stringify(settingsDocument(defaults,'one')))
 const ctx={...f.ctx,on(){},effect(){},tools:{register(){}},sessions:{get(){}}},archive=new ArchiveService(ctx,{path:join(f.dir,'lcm.sqlite')},file);t.after(()=>archive.close())
 archive.db.capture(header,[{...event(0),data:{title:'different original'}}]);archive.dirty.add('old');await archive.drain()
 assert.equal(archive.lastDiagnostic.code,'SOURCE_CHANGED');assert.equal(archive.db.cursor('old'),1);assert.equal(archive.db.legacySource('old'),undefined)
 assert.equal(JSON.parse(archive.db.events('old').items[0].text).data.title,'different original')
})
test('header mismatch rolls back events and physical source evidence together',async t=>{
 const f=fixture(t),raw=await readLegacyArchive(f.ctx,f.persistence,'old'),db=new ArchiveDatabase(join(f.dir,'lcm.sqlite'));t.after(()=>db.close())
 db.capture({...header,cwd:'/other'},[event(0)])
 assert.throws(()=>db.capture(raw.header,raw.events,{legacySource:raw.legacySource,legacyEvents:raw.legacyEvents}),/来源身份改变/)
 assert.equal(db.cursor('old'),1);assert.equal(db.legacySource('old'),undefined)
})
