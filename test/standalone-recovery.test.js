import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {zstdCompressSync} from 'node:zlib'
import {decodeLegacyBytes} from '../src/legacy-archive.js'
import {readRawDshSession} from '../src/raw-session.js'
import {ArchiveDatabase} from '../src/archive-db.js'
import {ArchiveService} from '../src/archive-service.js'
import {defaults,settingsDocument} from '../src/settings.js'
const header={type:'session',version:0,id:'overlap',createdAt:1,cwd:process.platform==='win32'?'C:\\project':'/project',delegationDepth:0}
const event=(seq,title)=>({type:'session/title',seq,time:seq+1,data:{title}})
const rows=[event(0,'first'),event(1,'fork'),event(1,'different'),event(4,'interleaved'),event(2,'continued')]
const bytes=(values=rows)=>zstdCompressSync(Buffer.from([header,...values].map(x=>JSON.stringify(x)).join('\n')+'\n'))
async function fixture(t,values=rows){const dir=mkdtempSync(join(tmpdir(),'sl-recovery-')),blob=bytes(values),path=join(dir,'session.jsonl.zstd');writeFileSync(path,blob)
 const raw=await decodeLegacyBytes(blob,true,{recoverSequence:true}),source={version:0,bytes:blob,sha256:createHash('sha256').update(blob).digest('hex')},db=new ArchiveDatabase(join(dir,'lcm.sqlite'));t.after(()=>db.close())
 return {dir,blob,path,raw,source,db}
}
test('sequence recovery preserves conflicting originals and physical order, rather than dropping or renumbering their source sequences',async t=>{
 const {raw,db,source}=await fixture(t);assert.equal(raw.recovery.discontinuities,3);assert.deepEqual(raw.recovery.entries.map(x=>x.event),rows)
 db.captureRecovered(raw.header,raw.recovery,source)
 const value=db.events('overlap',1,3);assert.equal(value.sequenceMode,'physical-order');assert.deepEqual(value.items.map(x=>x.sourceSeq),[1,1,4]);assert.deepEqual(value.items.map(x=>x.seq),[1,2,3]);assert.deepEqual(value.items.map(x=>x.sourceRow),[2,3,4]);assert.equal(value.next,4)
 assert.deepEqual(value.items.map(x=>JSON.parse(x.text)),rows.slice(1,4));assert.equal(db.sessions().items[0].eventCount,5)
 assert.equal(db.find({query:'different'}).items[0].sourceSeq,1)
 assert.deepEqual(Buffer.from(db.db.prepare('SELECT bytes FROM sl_legacy_sources').get().bytes),source.bytes)
})
test('packed chunks keep their original numbering and values when an interleaved row reuses a source sequence',async()=>{
 const packed={type:'text-chunks',seq0:0,time0:1,data:{turn:0,step:0,index:0,dt:[1],texts:['a','b']}}
 const raw=await decodeLegacyBytes(bytes([packed,packed]),true,{recoverSequence:true})
 assert.deepEqual(raw.events.map(x=>x.seq),[0,1,0,1]);assert.deepEqual(raw.events.slice(0,2),raw.events.slice(2));assert.deepEqual(raw.recovery.entries.map(x=>x.sourceRow),[1,1,2,2])
})
test('recovery validates every row, frame and source sequence, including rows beyond the first discontinuity',async()=>{
 await assert.rejects(()=>decodeLegacyBytes(bytes(),true),/seq gap/)
 await assert.rejects(()=>decodeLegacyBytes(bytes([...rows,{type:'text-chunks',seq0:9,time0:1,data:{texts:['missing required chunk fields']}}]),true,{recoverSequence:true}))
 await assert.rejects(()=>decodeLegacyBytes(bytes([...rows,event(-1,'bad')]),true,{recoverSequence:true}),/序号无效/)
 await assert.rejects(()=>decodeLegacyBytes(bytes().subarray(0,-1),true,{recoverSequence:true}),/不完整/)
 const healthy=await decodeLegacyBytes(bytes([event(0,'healthy')]),true,{recoverSequence:true});assert.equal(healthy.recovery,undefined)
})
test('recovery verifies an existing canonical prefix and commits all evidence atomically',async t=>{
 const {raw,db,source}=await fixture(t);db.capture(raw.header,[rows[0],rows[1]]);db.captureRecovered(raw.header,raw.recovery,source);db.captureRecovered(raw.header,raw.recovery,source)
 assert.equal(db.cursor('overlap'),5);assert.equal(db.events('overlap').items.length,5)
 const wrong={...raw.recovery,entries:raw.recovery.entries.map((x,i)=>i===4?{...x,event:event(2,'mutated')}:x)}
 assert.throws(()=>db.captureRecovered(raw.header,wrong,source),/原文已改变/);assert.deepEqual(JSON.parse(db.events('overlap',4,1).items[0].text),rows[4])
})
test('conflicting saved prefix or physical blob rejects recovery without partial rows or false success markers',async t=>{
 const f=await fixture(t);f.db.capture(f.raw.header,[event(0,'wrong')]);assert.throws(()=>f.db.captureRecovered(f.raw.header,f.raw.recovery,f.source),/原文已改变/)
 assert.equal(f.db.recovery('overlap'),undefined);assert.equal(f.db.legacySource('overlap'),undefined);assert.equal(f.db.db.prepare('SELECT COUNT(*) count FROM sl_recovered_events').get().count,0)
 const g=await fixture(t);assert.throws(()=>g.db.captureRecovered(g.raw.header,g.raw.recovery,{...g.source,sha256:'wrong'}),/校验失败/)
 assert.equal(g.db.cursor('overlap'),0);assert.equal(g.db.sessions().items.length,0)
})
test('only retained old sources can recover a host corruption error; a current artifact still blocks stale fallback',async t=>{
 const f=await fixture(t),persistence={async open(){throw Object.assign(Error('old overlap'),{name:'SessionPersistenceCorruptionError'})},locate:()=>({kind:'jsonl',path:join(f.dir,'session.v4.jsonl.zstd')})}
 const ctx={sessionPersistence:persistence,sessionQuery:{listSessions:async()=>[{header:f.raw.header}]}}
 const recovered=await readRawDshSession(ctx,'overlap',2);assert.deepEqual(recovered.recovery.entries.map(x=>x.event),rows);assert.deepEqual(recovered.events,rows.slice(2))
 assert.deepEqual(readFileSync(f.path),f.blob)
 writeFileSync(join(f.dir,'session.v4.jsonl.zstd'),f.blob);await assert.rejects(()=>readRawDshSession(ctx,'overlap'),/当前会话文件已存在/)
})
test('archive service clears the resolved capture failure only after complete recovery, and recovered data never enters summary or native compaction',async t=>{
 const f=await fixture(t),file=join(f.dir,'settings.json');writeFileSync(file,JSON.stringify(settingsDocument({...defaults,summaryEnabled:true,summaryProvider:'local',summaryModel:'local'},'one')))
 const ctx={sessionPersistence:{open:async()=>{throw Object.assign(Error('overlap'),{name:'SessionPersistenceCorruptionError'})},locate:()=>({kind:'jsonl',path:join(f.dir,'session.v4.jsonl.zstd')})},sessionQuery:{listSessions:async()=>[{header:f.raw.header}]},on(){},effect(){},tools:{register(){}},sessions:{get(){}},llm:{stream(){throw Error('no paid model calls')}}}
 const archive=new ArchiveService(ctx,{path:join(f.dir,'service.sqlite'),listNodes(){throw Error('no compaction reconstruction')}},file);t.after(()=>archive.close())
 archive.failed(Object.assign(Error('bad source'),{name:'SessionPersistenceCorruptionError'}),'overlap','capture');archive.dirty.add('overlap');archive.jobs.add('overlap');await archive.drain()
 assert.equal(archive.lastDiagnostic,undefined);assert.equal(archive.db.cursor('overlap'),5);assert.equal(await archive.summarize('overlap'),'legacy');assert.equal(archive.outline('overlap').sequenceMode,'physical-order')
 archive.dirty.add('overlap');await archive.drain();assert.equal(archive.db.cursor('overlap'),5);assert.equal(archive.lastDiagnostic,undefined)
 assert.deepEqual(readFileSync(f.path),f.blob)
})

test('original reference bounds and range expansion survive forward numbering and overlapping rows',async()=>{
 const values=[event(0,'first'),{...event(9,'forward'),sourceEventSeqs:[[0,3]]},{...event(1,'overlap'),sourceEventSeqs:[0]}]
 const raw=await decodeLegacyBytes(bytes(values),true,{recoverSequence:true})
 assert.deepEqual(raw.events[1],{...values[1],sourceEventSeqs:[0,1,2,3]});assert.deepEqual(raw.events[2],values[2])
})
test('archive ordinals cannot widen the source-reference bound on an overlapping original',async()=>{
 const values=[event(0,'a'),event(1,'b'),event(2,'c'),{...event(1,'invalid references'),sourceEventSeqs:[0,1]}]
 await assert.rejects(()=>decodeLegacyBytes(bytes(values),true,{recoverSequence:true}),/sourceEventSeqs/)
})

test('oversized compressed reference ranges are rejected before allocating expanded arrays',async()=>{
 await assert.rejects(()=>decodeLegacyBytes(bytes([{...event(2000000,'oversized'),sourceEventSeqs:[[0,1500000]]}]),true,{recoverSequence:true}),/引用数量过大/)
})
test('accepted live originals are archived before the persistence writer flushes them',async()=>{
 const value=event(0,'accepted live'),ctx={sessions:{get:()=>({header:{version:4,id:'live'},snapshotEvents:()=>[value]})},sessionPersistence:{open(){throw Error('unflushed persistence must not be used')}}}
 assert.deepEqual((await readRawDshSession(ctx,'live')).events,[value])
})
test('an unsupported migration which wraps a sequence gap still recovers every physical row',async t=>{
 const f=await fixture(t),ctx={sessionPersistence:{open:async()=>{throw Object.assign(Error('released sequence migration refused'),{name:'SessionFormatUnsupportedError'})},locate:()=>({kind:'jsonl',path:join(f.dir,'session.v4.jsonl.zstd')})},sessionQuery:{listSessions:async()=>[{header:f.raw.header}]}}
 const raw=await readRawDshSession(ctx,'overlap');assert.deepEqual(raw.recovery.entries.map(x=>x.event),rows)
})
test('a directly exposed released-format sequence error is handled without accepting unrelated format errors',async t=>{
 const f=await fixture(t),ctx={sessionPersistence:{open:async()=>{throw Object.assign(Error('released Session row 2 has seq gap (expected 2, got 1)'),{name:'SessionFormatError'})},locate:()=>({kind:'jsonl',path:join(f.dir,'session.v4.jsonl.zstd')})},sessionQuery:{listSessions:async()=>[{header:f.raw.header}]}}
 assert.deepEqual((await readRawDshSession(ctx,'overlap')).recovery.entries.map(x=>x.event),rows)
 ctx.sessionPersistence.open=async()=>{throw Object.assign(Error('other malformed source'),{name:'SessionFormatError'})};await assert.rejects(()=>readRawDshSession(ctx,'overlap'),/other malformed/)
})
