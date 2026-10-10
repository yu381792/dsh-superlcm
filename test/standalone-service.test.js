import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore} from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {ArchiveService} from '../src/archive-service.js'
import {SuperLcmStore} from '../src/store.js'
import {defaults,settingsDocument} from '../src/settings.js'
const tick=()=>new Promise(r=>setImmediate(r))
async function fixture(run,enabled=true,respond=async()=> 'Source facts with exact references'){
 const dir=mkdtempSync(join(tmpdir(),'standalone-service-')),file=join(dir,'settings.json'),native=new SuperLcmStore(join(dir,'lcm.sqlite')),ctx=new Context(),calls=[],tools=[]
 const doc=settingsDocument({...defaults,summaryEnabled:enabled,summaryProvider:'local',summaryModel:'summary',chunkTokens:1000},'one');writeFileSync(file,JSON.stringify(doc))
 new SessionStore(ctx);new SessionProjections(ctx)
 ctx.reflect.provide('tools',{register:tool=>tools.push(tool)})
 ctx.reflect.provide('llm',{async *stream(options){calls.push(options);const text=await respond(options);yield {type:'text-delta',index:0,text:text.startsWith('<fake_tool_call>')?text:'# '+text};yield {type:'finish',reason:{kind:'stop'}}}})
 ctx.reflect.provide('sessionQuery',{observeSession:async id=>{const s=ctx.sessions.get(id);return {source:'live',header:s.header,events:s.snapshotEvents(),[Symbol.dispose](){}}},listSessions:async()=>[]})
 const archive=new ArchiveService(ctx,native,file),session=ctx.sessions.create('standalone-service',{meta:{cwd:'/project'}})
 const append=text=>session.append('user/message',createUserMessage({content:[{type:'text',text}]}),{surfaceOp:'append'})
 try{await run({ctx,session,archive,append,file,doc,calls,tools,native})}finally{await ctx.fiber.dispose();await archive.close();native.close()}
}
test('archive-only summaries use the selected host model and never replace the conversation',async()=>{
 await fixture(async({session,archive,append,calls,tools})=>{
  append('Original source facts '.repeat(500));append('Next original source facts '.repeat(500));append('Recent tail')
  const surface=[...session.surface.nodes];archive.schedule(session.id);await archive.drain()
  assert.ok(calls.length);assert.equal(calls[0].provider,'local');assert.equal(calls[0].model,'summary');assert.notEqual(calls[0].sessionId,session.id)
  assert.deepEqual(session.surface.nodes,surface);assert.equal(session.snapshotEvents().some(e=>e.type==='compaction/summary'),false)
  assert.ok(archive.outline(session.id).nodes.length);assert.ok(tools.some(t=>t.name==='lcm_read'))
 })
})
test('paid archive summaries stop on disable and late model output is discarded',async()=>{
 let finish,started;const begun=new Promise(r=>started=r),answer=new Promise(r=>finish=r)
 await fixture(async({session,archive,append,file,doc,calls})=>{
  append('Original source facts '.repeat(500));append('Next original source facts '.repeat(500))
  archive.schedule(session.id);await begun
  writeFileSync(file,JSON.stringify(settingsDocument({...doc.settings,summaryEnabled:false},'two')));archive.changed();finish('Late summary facts');await archive.drain()
  assert.equal(calls.length,1);assert.equal(archive.db.nodes(session.id).length,0)
  assert.ok(archive.db.events(session.id).items.length)
  assert.equal(archive.lastError,undefined)
 },true,async()=>{started();return answer})
})

test('a failed archive shows a safe cause and clears only after that session recovers',async()=>{
 await fixture(async({session,archive,append})=>{
  append('Original facts');await archive.drain()
  const capture=archive.capture.bind(archive)
  archive.capture=async()=>{throw Error('会话来源身份改变，原记录保留')}
  archive.dirty.add(session.id);await archive.drain()
  assert.equal(archive.lastDiagnostic.stage,'capture');assert.equal(archive.lastDiagnostic.code,'HEADER_IDENTITY')
  assert.match(archive.lastError,/来源信息冲突/)
  archive.capture=capture;archive.dirty.add('other-failed-session')
  archive.failed(Error('原文序号不连续'),'other-failed-session','capture')
  archive.dirty.delete('other-failed-session');archive.dirty.add(session.id);await archive.drain()
  assert.equal(archive.lastDiagnostic.session,'other-failed-session')
  archive.recovered('other-failed-session','capture');assert.equal(archive.lastError,undefined)
 },false)
})

test('a failed summary remains visible through the retry cooldown and clears on a completed retry',async()=>{
 let incomplete=true
 await fixture(async({session,archive,append,calls})=>{
  append('Original source facts '.repeat(500));append('Next source facts '.repeat(500))
  archive.schedule(session.id);await archive.drain()
  assert.equal(archive.lastDiagnostic.stage,'summary');assert.equal(archive.lastDiagnostic.code,'SUMMARY_TOO_LONG')
  const count=calls.length;archive.schedule(session.id);await archive.drain()
  assert.equal(calls.length,count);assert.ok(archive.lastError)
  incomplete=false;archive.db.db.prepare('UPDATE sl_jobs SET retry=0 WHERE session=?').run(session.id)
  archive.schedule(session.id);await archive.drain();assert.equal(archive.lastError,undefined)
 },true,async()=>incomplete?'source facts '.repeat(1000):'Complete source-grounded summary')
})

test('cancelling a summary retry does not erase an unresolved earlier failure',async()=>{
 let attempt=0,finish,started;const begun=new Promise(r=>started=r),late=new Promise(r=>finish=r)
 await fixture(async({session,archive,append,file,doc})=>{
  append('Original source facts '.repeat(500));append('Next source facts '.repeat(500))
  archive.schedule(session.id);await archive.drain();assert.equal(archive.lastDiagnostic.code,'SUMMARY_TOO_LONG')
  archive.db.db.prepare('UPDATE sl_jobs SET retry=0 WHERE session=?').run(session.id)
  archive.schedule(session.id);await begun
  writeFileSync(file,JSON.stringify(settingsDocument({...doc.settings,summaryEnabled:false},'two')))
  archive.changed();finish('A late result');await archive.drain()
  assert.equal(archive.lastDiagnostic.code,'SUMMARY_TOO_LONG');assert.equal(archive.db.nodes(session.id).length,0)
 },true,async()=>{if(attempt++===0)return 'source facts '.repeat(1000);started();return late})
})
test('history archiving and native mode make no auxiliary model calls when summaries are off',async()=>{
 await fixture(async({session,archive,append,calls})=>{
  append('Long original source '.repeat(2000));await archive.drain();await archive.import();await archive.drain()
  assert.equal(calls.length,0);assert.ok(archive.db.events(session.id).items.length);assert.throws(()=>archive.schedule(session.id),/开启/)
 },false)
})

test('native committed checkpoints appear at the real summary depth without assembly wrappers',async()=>{
 await fixture(async({session,archive,append,native})=>{
  append('First exact source');append('Second exact source');await archive.drain()
  const seqs=session.snapshotEvents().filter(e=>e.type==='user/message').map(e=>e.seq)
  const a=[{type:'text',text:'Summary A'}],b=[{type:'text',text:'Summary B'}]
  native.upsertNode({sessionId:session.id,nodeId:'a',summary:a,summaryText:'Summary A',sourceSeqs:[seqs[0]],status:'ready',kind:'leaf'})
  native.upsertNode({sessionId:session.id,nodeId:'b',summary:b,summaryText:'Summary B',sourceSeqs:[seqs[1]],status:'ready',kind:'leaf'})
  native.upsertNode({sessionId:session.id,nodeId:'wrapper',summary:[...a,...b],summaryText:'Summary A Summary B',childIds:['a','b'],sourceSeqs:seqs,status:'ready',kind:'assembled'})
  const outline=archive.outline(session.id);assert.equal(outline.nodes.length,2);assert.ok(outline.nodes.every(n=>n.level===0));assert.equal(outline.uncovered,0);assert.equal(archive.sessions().items[0].summaryCount,2)
 },false)
})

test('archive retries a wrong language once, saves only the valid summary and keeps surface intact',async()=>{
 let attempt=0
 await fixture(async({session,archive,append,calls})=>{
  append('Please check the original project and keep the files. We should not deploy yet. '.repeat(500));append('Please preserve the files. '.repeat(500))
  await archive.drain();const surface=[...session.surface.nodes];await archive.capture(session.id)
  assert.equal(await archive.summarize(session.id),'complete')
  const nodes=archive.db.nodes(session.id);assert.ok(nodes.length);assert.equal(calls.length,nodes.length+1)
  assert.ok(nodes.every(n=>n.summary.startsWith('# Current state')))
  assert.deepEqual(session.surface.nodes,surface)
 },true,async()=>attempt++===0?'当前项目还没有部署，原始文件保持不变。'.repeat(5):'Current state\nThe original project remains unchanged. Deployment has not been authorized and testing is pending.')
})
test('a repeated role-play reply is refused after one retry and no summary is saved',async()=>{
 await fixture(async({session,archive,append,calls})=>{
  append('Please check the current project and keep all original files. '.repeat(500));append('Please preserve the files. '.repeat(500));await archive.drain();await archive.capture(session.id)
  await assert.rejects(archive.summarize(session.id),/section heading/)
  assert.equal(calls.length,2);assert.equal(archive.db.nodes(session.id).length,0)
 },true,async()=>'<fake_tool_call>Do the work now.</fake_tool_call>')
})
