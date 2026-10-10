import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Basic from '@deepseek-ai/dsh-compaction-basic'
import Engine from '../src/engine.js'
import { mountCompactionOwner } from '../src/compaction-owner.js'
import { markerFromSummary } from '../src/marker.js'
import { prepareAsyncRegion, summarizeAsyncRegion, commitAsyncRegion } from '../src/async-region.js'
import { controlsConfig } from '../src/controls-config.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(run, response = async () => 'Current task and exact facts retained.', ownerConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-native-owner-')), ctx = new Context(), calls = [], warnings = []
  const file = join(dir, 'controls.json')
  const config = controlsConfig({budgetMode:'tokens',auto:false,summarizationProvider:'plugin-provider',summarizationModel:'plugin-model',summaryAdapter:null})
  const publish = (revision, next = {}) => writeFileSync(file,JSON.stringify({format:1,revision,config:{...config,...next}}))
  publish('off-boot')
  ctx.logger.warn = message => warnings.push(message)
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    ctx.reflect.provide('llm', {async *stream(options) {
      calls.push(options); const text = await response(options)
      yield {type:'text-delta',index:0,text:'# '+text}
      yield {type:'finish',reason:{kind:'stop'}}
    }, resolveModelInfo:async()=>({context:{contextWindow:262144},defaultMaxTokens:65536}), imageRequestPricing() {}, fileRequestText() {}})
    new TokenMeter(ctx)
    const owner = await mountCompactionOwner(ctx,{controlFile:file,archiveHome:dir,...ownerConfig})
    const session = ctx.sessions.create('native-restoration'), signal = new AbortController().signal
    session.append('turn/start',{turn:'native-owner-turn'})
    session.append('request/header',{header:{config:{provider:'chat-provider',model:'chat-model'}},reason:'initial'})
    const agent = {session,options:{provider:'fallback-provider',model:'fallback-model'},runMaintenance:async fn=>fn(signal)}
    const append = text => session.append('user/message',createUserMessage({content:[{type:'text',text}]}),{surfaceOp:'append'})
    await run({ctx,owner,session,agent,signal,append,publish,config,calls,warnings})
  } finally {await ctx.fiber.dispose()}
}

test('off at boot mounts native pressure and overflow protection using the conversation model', async()=>{
  await fixture(async({ctx,owner,session,agent,signal,append,calls})=>{
    assert.equal(owner.mode,'dsh-native');assert.ok(ctx.compaction instanceof Basic);assert.ok(!(ctx.compaction instanceof Engine))
    for(let i=0;i<8;i++) append('Exact source facts. '.repeat(20000)+i)
    const before=ctx.tokenMeter.measure(session).totalTokens
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    assert.ok(calls.length>0);assert.equal(calls[0].provider,'chat-provider');assert.equal(calls[0].model,'chat-model')
    assert.ok(ctx.tokenMeter.measure(session).totalTokens<before)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/end').length,1)
    append('New exact facts '.repeat(10000))
    const result=await ctx.waterfall('agent/request-error',{agent,signal,failure:{code:CONTEXT_WINDOW_EXCEEDED_CODE}},()=>({kind:'unhandled'}))
    assert.equal(result.kind,'retry');assert.equal(calls.at(-1).model,'chat-model')
    const repeated=await ctx.waterfall('agent/request-error',{agent,signal,failure:{code:CONTEXT_WINDOW_EXCEEDED_CODE}},()=>({kind:'unhandled'}))
    assert.equal(repeated.kind,'unhandled','native retry budget is enforced')
  })
})

test('manual compaction in archive-only mode ignores the configured SuperLcm summary model',async()=>{
  await fixture(async({ctx,session,agent,signal,append,calls})=>{
    append('Verbatim source '.repeat(6000)); append('Recent facts '.repeat(1000))
    session.append('turn/end',{turn:'native-owner-turn'})
    const result=await ctx.compaction.compactNow(agent,signal)
    assert.ok(result);assert.equal(calls.length,1);assert.equal(calls[0].model,'chat-model')
    assert.equal(calls[0].purpose,'compaction')
  })
})

test('native policy does not inherit incompatible SuperLcm retention and survives repeated revisions',async()=>{
  await fixture(async({ctx,owner,agent,signal,append,publish,warnings,calls})=>{
    publish('large-plugin-retention',{minRetainTokens:150000,softActiveTokens:160000,hardActiveTokens:220000})
    await owner.reload()
    assert.equal(ctx.compaction.config.retainTokens,undefined)
    for(let i=0;i<4;i++){publish('off-'+i);await owner.reload()}
    for(let i=0;i<8;i++)append('source '.repeat(50000))
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    assert.equal(calls.length,1,'no duplicate listeners after reloads')
    assert.ok(!warnings.some(w=>/retainTokens|pressure budget/.test(w)))
  })
})

test('switch cancels a native request even when the adapter ignores abort; late output never commits',async()=>{
  let release, started
  const gate=new Promise(resolve=>{release=resolve}), entered=new Promise(resolve=>{started=resolve})
  await fixture(async({ctx,owner,session,agent,signal,append,publish})=>{
    append('old exact source '.repeat(10000));const before=[...session.surface.nodes]
    const running=ctx.compaction.compactRegion(before[0],before.at(-1),agent,signal)
    const rejected=assert.rejects(running,/切换/)
    await Promise.race([entered, running.then(() => { throw Error('native request completed before its fixture gate') })])
    publish('off-updated')
    await owner.reload()
    await rejected
    assert.equal(owner.mode,'dsh-native');assert.deepEqual(session.surface.nodes,before)
    release('Late cancelled summary');await tick();await tick()
    assert.deepEqual(session.surface.nodes,before)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,0)
  },async()=>{started();return gate})
})

test('a pre-step entering during an owner switch is handled by the new native owner',async()=>{
  await fixture(async({ctx,owner,agent,signal,append,publish,calls})=>{
    publish('next-off');const switching=owner.reload()
    for(let i=0;i<8;i++)append('facts '.repeat(50000))
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    await switching
    assert.equal(calls.length,1);assert.equal(calls[0].model,'chat-model')
  })
})

const adapter = {plugin:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{'plugin-provider':{api:'openai-responses',baseURL:'http://127.0.0.1:9/v1',models:[{id:'plugin-model',contextWindow:262144}]}}}}
test('off/on/off switches real owners and managed summaries keep their fourth-argument source metadata',async()=>{
  await fixture(async({ctx,owner,session,agent,signal,append,publish,calls})=>{
    publish('takeover',{auto:true,summaryAdapter:adapter})
    await owner.reload();assert.equal(owner.mode,'superlcm');assert.ok(ctx.compaction instanceof Engine)
    const engine=ctx.compaction, directives=[]
    engine.summaryContext.llm.stream=async function*(options){directives.push(options.messages.at(-1).content[0].text);yield{type:'text-delta',index:0,text:'# Historical facts and exact decision.'};yield{type:'finish',reason:{kind:'stop'}}}
    const raw=append('earlier facts '.repeat(20000))
    const prepared=prepareAsyncRegion(engine,agent,{start:raw.seq,end:raw.seq})
    prepared.trustedChildNodeIds=['known-child']
    prepared.summaryDepth=1
    const summary=await summarizeAsyncRegion(engine,agent,prepared,signal)
    assert.deepEqual(markerFromSummary(summary.summary).children,['known-child'])
    assert.match(directives[0],/semantic depth=1/)
    publish('native-again');await owner.reload()
    assert.equal(owner.mode,'dsh-native');assert.ok(!(ctx.compaction instanceof Engine))
    for(let i=0;i<8;i++)append('facts '.repeat(50000))
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    assert.equal(calls.length,1);assert.equal(calls[0].model,'chat-model')
  })
})

test('invalid takeover initialization leaves native protection available and does not acknowledge takeover',async()=>{
  await fixture(async({ctx,owner,agent,signal,append,publish,calls,warnings})=>{
    publish('bad-takeover',{auto:true,summaryAdapter:{plugin:'unsupported'}})
    await owner.reload();assert.equal(owner.mode,'dsh-native');assert.ok(!(ctx.compaction instanceof Engine))
    for(let i=0;i<8;i++)append('facts '.repeat(50000))
    await ctx.waterfall('agent/pre-step',{agent,signal},()=>{})
    assert.equal(calls.length,1);assert.match(warnings.join('\n'),/恢复 DSH 原生/)
    append('new facts '.repeat(10000))
    const payload={agent,signal,failure:{code:CONTEXT_WINDOW_EXCEEDED_CODE}}
    assert.equal((await ctx.waterfall('agent/request-error',payload,()=>({kind:'unhandled'}))).kind,'retry')
    assert.equal((await ctx.waterfall('agent/request-error',payload,()=>({kind:'unhandled'}))).kind,'unhandled')
    assert.equal(calls.length,2,'a failed document cannot reset the native overflow budget')
  })
})

test('disabling takeover drains a cancelled pending draft without waiting for a non-cooperative adapter',async()=>{
  await fixture(async({ctx,owner,session,agent,append,publish})=>{
    publish('on-pending',{auto:true,summaryAdapter:adapter});await owner.reload()
    const engine=ctx.compaction
    let entered,release
    const started=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
    engine.summaryContext.llm.stream=async function*(){entered();await gate;yield{type:'text-delta',index:0,text:'Late old facts'};yield{type:'finish',reason:{kind:'stop'}}}
    const raw=append('old exact facts '.repeat(20000)),before=[...session.surface.nodes]
    engine.startBackgroundFold(agent,{start:raw.seq,end:raw.seq,activeTokens:200000,eligibleEnd:raw.seq})
    await started
    publish('off-cancelled');await owner.reload()
    assert.equal(owner.mode,'dsh-native');assert.deepEqual(session.surface.nodes,before)
    release();await tick();await tick()
    assert.deepEqual(session.surface.nodes,before)
    assert.equal(session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,0)
  })
})

test('native owner restores captured policy and model route after optional takeover',async()=>{
  await fixture(async({ctx,owner,publish})=>{
    assert.equal(ctx.compaction.config.thresholdRatio,0.72);assert.equal(ctx.compaction.config.retainTokens,24000)
    assert.equal(ctx.compaction.config.summarizationModel,'native-model')
    publish('takeover-policy',{auto:true,summaryAdapter:adapter});await owner.reload();assert.equal(owner.mode,'superlcm')
    publish('restore-policy');await owner.reload();assert.equal(owner.mode,'dsh-native')
    assert.equal(ctx.compaction.config.thresholdRatio,0.72);assert.equal(ctx.compaction.config.retainTokens,24000)
    assert.equal(ctx.compaction.config.summarizationModel,'native-model')
  },undefined,{archiveOnly:false,nativeConfigs:{undefined:{auto:true,thresholdRatio:0.72,retainTokens:24000,summarizationProvider:'native-provider',summarizationModel:'native-model'}}})
})

test('malformed controls at boot or reload retain native protection without acknowledging takeover',async()=>{
  await fixture(async({ctx,owner,publish,warnings})=>{
    publish('on-before-corruption',{auto:true,summaryAdapter:adapter});await owner.reload();assert.equal(owner.mode,'superlcm')
    publish('invalid',{softActiveTokens:-1});await owner.reload();assert.equal(owner.mode,'dsh-native');assert.ok(ctx.compaction instanceof Basic)
    assert.match(warnings.join('\n'),/读取失败/)
    publish('good-off');await owner.reload();assert.equal(owner.mode,'dsh-native')
  })
  const dir=mkdtempSync(join(tmpdir(),'slcm-corrupt-owner-')),ctx=new Context(),file=join(dir,'invalid.json')
  writeFileSync(file,'{broken json')
  try {
    new SessionStore(ctx);new SessionProjections(ctx);ctx.reflect.provide('llm',{stream:async function*(){},resolveModelInfo:async()=>({context:{contextWindow:262144}}) });new TokenMeter(ctx)
    const owner=await mountCompactionOwner(ctx,{controlFile:file,archiveHome:dir,nativeConfigs:{undefined:{retainTokens:24000}}})
    assert.equal(owner.mode,'dsh-native');assert.ok(ctx.compaction instanceof Basic);assert.equal(ctx.compaction.config.retainTokens,24000)
    assert.notEqual(ctx.compaction.compressionReporter?.revision,'invalid-controls')
  }finally{await ctx.fiber.dispose()}
})

test('DSH takeover retries wrong language once without editing the summarized input',async()=>{
 await fixture(async({ctx,owner,session,agent,signal,append,publish})=>{
  publish('takeover',{auto:true,summaryAdapter:adapter});await owner.reload()
  const engine=ctx.compaction,seen=[]
  engine.summaryContext.llm.stream=async function*(options){seen.push(options);yield {type:'text-delta',index:0,text:seen.length===1?'# 状态\n当前项目还没有部署，原始文件保持不变。'.repeat(5):'# Current state\nThe original project remains unchanged. Deployment remains unauthorized and verification is pending.'};yield{type:'finish',reason:{kind:'stop'}}}
  const raw=append('Please check the files and preserve the project. We should not deploy the changes yet. '.repeat(300))
  const prepared=prepareAsyncRegion(engine,agent,{start:raw.seq,end:raw.seq}),before=structuredClone(prepared.input),surface=[...session.surface.nodes]
  const result=await summarizeAsyncRegion(engine,agent,prepared,signal)
  assert.equal(seen.length,2);assert.deepEqual(prepared.input,before);assert.deepEqual(session.surface.nodes,surface)
  assert.match(result.summary[0].text,/Current state/);assert.match(seen[1].messages.at(-1).content[0].text,/previous response failed/)
 })
})

for (const kind of ['missing','unknown','max-tokens','tool-calls','error','aborted','duplicate','after-finish','tool-start','tool-output']) {
 test(`malformed ${kind} model stream cannot replace the DSH surface`,async()=>{
  await fixture(async({ctx,owner,session,agent,publish})=>{
   publish("on-wire-failure",{auto:true,summaryAdapter:adapter});await owner.reload();const engine=ctx.compaction
   const body={type:'text-delta',index:0,text:'# Current state\nThe original files remain unchanged. Deployment has not been authorized.'},stop={type:'finish',reason:{kind:'stop'}}
   const chunks=kind==='missing'?[body]:kind==='duplicate'?[body,stop,stop]:kind==='after-finish'?[body,stop,body]:kind==='tool-start'?[body,{type:'block-start',index:1,blockType:'tool-call'},stop]:kind==='tool-output'?[body,{type:'block-end',index:1,block:{type:'tool-call',id:'fake',name:'execute',arguments:'{}'}},stop]:[body,{type:'finish',reason:{kind}}]
   let paidCalls=0;engine.summaryContext.llm.stream=async function*(){paidCalls++;for(const chunk of chunks)yield chunk}
   const raw=session.append('user/message',createUserMessage({content:[{type:'text',text:'Please preserve the original files. Deployment is not approved. '.repeat(100)}]}),{surfaceOp:'append'})
   const surface=[...session.surface.nodes],before=session.snapshotEvents(),prepared=prepareAsyncRegion(engine,agent,{start:raw.seq,end:raw.seq})
   await assert.rejects(async()=>{const result=await summarizeAsyncRegion(engine,agent,prepared,new AbortController().signal);commitAsyncRegion(engine,agent,result)},/incomplete/)
   assert.equal(paidCalls,1);assert.deepEqual(session.surface.nodes,surface);assert.deepEqual(session.snapshotEvents(),before)
   assert.equal(engine.superLcmStore.listNodes(session.id,{status:'ready'}).length,0)
  })
 })
}
