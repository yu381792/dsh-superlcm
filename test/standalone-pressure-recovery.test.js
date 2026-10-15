import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../src/engine.js'
import {resolvePolicy,pressureStep} from '../src/ratio-runtime.js'
import {assembleTree,draftNode,draftTokens} from '../src/draft-tree.js'
import {saveDraft} from '../src/draft-persistence.js'
import {reindexSession,doctorSession} from '../src/core.js'
import {SuperLcmStore} from '../src/store.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const append=(session,text)=>session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
async function host(run,{db=join(mkdtempSync(join(tmpdir(),'superlcm-pressure-')),'lcm.sqlite'),seed,reply=async()=> 'Saved historical facts.'}={}) {
  const ctx=new Context(),calls=[],warnings=[]
  ctx.logger.warn=message=>warnings.push(message)
  try {
    new SessionStore(ctx);new SessionProjections(ctx)
    const stream=async function* (options) {calls.push(options);yield {type:'text-delta',index:0,text:'# '+await reply(options)};yield {type:'finish',reason:{kind:'stop'}}}
    ctx.reflect.provide('llm',{stream,prepareCall:async config=>({config,context:{contextWindow:100000},stream}),resolveModelInfo:async()=>({context:{contextWindow:100000},defaultMaxTokens:0}),imageRequestPricing(){},fileRequestText(){}})
    new TokenMeter(ctx)
    const engine=new Engine(ctx,{auto:false,budgetMode:'ratio',databasePath:db,archiveHome:join(db,'..'),summarizationProvider:'local',summarizationModel:'summary'})
    const session=ctx.sessions.create('pressure-recovery',{meta:{id:'pressure-recovery',version:4,createdAt:1,isSeeded:false,cwd:'/fixture'},...(seed?{seed,eventState:'detached'}:{})})
    const agent={session,options:{provider:'local',model:'main'}}
    await tick()
    await run({ctx,engine,session,agent,calls,warnings,db})
  }finally{await ctx.fiber.dispose()}
}
async function readyPrefix(h,{first=120000,tail=260000,fixed=0}={}) {
  if(fixed)h.session.append('system/message',{message:{...createUserMessage({source:{kind:'system-prompt'},content:[{type:'text',text:'s'.repeat(fixed)}]}),role:'system'}},{surfaceOp:'append'})
  const raw=append(h.session,'a'.repeat(first)),rest=append(h.session,'b'.repeat(tail)),current=append(h.session,'Continue the existing task.')
  const policy=await resolvePolicy(h.engine,h.agent,new AbortController().signal)
  const activeTokens=h.ctx.tokenMeter.measure(h.session).totalTokens
  const selection={start:raw.seq,end:raw.seq,activeTokens,eligibleEnd:rest.seq}
  const prepared=h.engine.prepareBackgroundSelection(h.agent,selection)
  const leaf=await h.engine.summarizeBackgroundSelection(h.agent,prepared,new AbortController().signal)
  leaf.depth=1
  const state={status:'ready',generation:h.engine.runtimeGeneration,signature:policy.signature,revision:h.engine.controlRevision,selection,cutoffEnd:rest.seq,parts:[leaf],frontier:[leaf],tree:[draftNode(leaf)],summarized:assembleTree(h.engine,[leaf],[draftNode(leaf)],1)}
  h.engine.backgroundFolds.set(h.agent,state);saveDraft(h.engine,h.agent,state)
  return {raw,rest,current,state,policy}
}
function assertRetained(h,original) {
  for(const event of original)assert.deepEqual(h.session.eventAt(event.seq),event,'all original events remain exact')
}

test('hard pressure commits a ready prefix after a later batch fails, keeping the remainder and current input',async()=>host(async h=>{
  const {raw,rest,current}=await readyPrefix(h)
  let secondCalls=0
  h.engine.summarizeBackgroundSelection=async()=>{secondCalls++;throw Error('offline later batch failed')}
  assert.ok(h.engine.startBackgroundFold(h.agent,h.engine.planRolling(h.agent)))
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(secondCalls,1);assert.equal(h.engine.backgroundFolds.get(h.agent).status,'ready')
  const original=h.session.snapshotEvents(),generation=h.session.surface.replaceGeneration
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens<80000)
  assert.ok(h.session.surface.nodes.includes(rest.seq));assert.ok(h.session.surface.nodes.includes(current.seq));assert.ok(!h.session.surface.nodes.includes(raw.seq))
  assertRetained(h,original)
  assert.equal(h.session.snapshotEvents().filter(e=>e.type==='compaction/summary').length,1)
}))

test('restored single-root stream draft commits with strict native JSON and reconstructible tree',async()=>{
  let seed,db,original
  await host(async h=>{await readyPrefix(h);seed=h.session.snapshotEvents();original=structuredClone(seed);db=h.db;assert.equal(h.engine.backgroundFolds.get(h.agent).summarized.llmStreamCall,true)})
  await host(async h=>{
    await resolvePolicy(h.engine,h.agent,new AbortController().signal)
    assert.equal(h.engine.restoreDraft(h.agent),true)
    const restored=h.engine.backgroundFolds.get(h.agent).summarized
    assert.equal(restored.rawOutput,undefined);assert.equal(restored.llmStreamCall,true)
    const result=h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true});assert.ok(result)
    assert.equal(h.calls.length,0,'restoring and submitting buys no new summary')
    const event=h.session.eventAt(result.summarySeq)
    assert.ok(!Object.hasOwn(event.data,'rawOutput'));assert.ok(!Object.hasOwn(event.data,'llmStreamCall'))
    assertRetained(h,original)
    const rebuilt=new SuperLcmStore(join(h.db,'..','rebuilt.sqlite'))
    try {assert.deepEqual(reindexSession(rebuilt,h.session).errors,[]);assert.equal(doctorSession(rebuilt,h.session).ok,true)}finally{rebuilt.close()}
  },{db,seed})
})

test('large fixed prompts keep a usable checkpoint budget and release emergency pressure',async()=>host(async h=>{
  const {policy}=await readyPrefix(h,{first:120000,tail:60000,fixed:200000})
  assert.equal(policy.summaryPrefixTargetTokens,6000)
  assert.ok(draftTokens(h.engine,h.agent,h.engine.backgroundFolds.get(h.agent).frontier)>1024)
  assert.ok(draftTokens(h.engine,h.agent,h.engine.backgroundFolds.get(h.agent).frontier)<policy.summaryPrefixTargetTokens)
  const result=h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true});assert.ok(result)
  assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens<policy.softActiveTokens)
},{reply:async()=> 'Preserved historical facts and evidence. '.repeat(120)}))

test('high fixed costs advance an insufficient ready prefix instead of repeatedly condensing it',async()=>host(async h=>{
  const {raw,rest,current,policy,state}=await readyPrefix(h,{first:32000,tail:160000,fixed:200000})
  const before=h.ctx.tokenMeter.measure(h.session).totalTokens
  assert.ok(before>=policy.hardActiveTokens)
  const checkpoint=draftTokens(h.engine,h.agent,state.frontier)
  assert.ok(checkpoint>1024&&checkpoint<policy.summaryPrefixTargetTokens)
  assert.ok(before-state.summarized.shadowedRouteTokenCount+checkpoint>=policy.softActiveTokens,'the prefix alone cannot admit the request')
  const next=h.engine.planRolling(h.agent)
  assert.equal(next.treeOnly,undefined);assert.equal(next.start,rest.seq)
  const original=structuredClone(h.session.snapshotEvents()),generation=h.session.surface.replaceGeneration
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens<policy.softActiveTokens)
  assert.ok(!h.session.surface.nodes.includes(raw.seq));assert.ok(!h.session.surface.nodes.includes(rest.seq))
  assert.ok(h.session.surface.nodes.includes(current.seq));assertRetained(h,original)
  assert.equal(h.calls.length,2,'reuse the ready prefix and summarize only the remaining raw block')
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.equal(h.calls.length,2)
},{reply:async()=> 'Preserved historical facts and evidence. '.repeat(120)}))

test('preparation below emergency pressure still waits for the frozen range',async()=>host(async h=>{
  await readyPrefix(h,{tail:200000})
  const original=h.session.snapshotEvents()
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true}),null)
  assert.deepEqual(h.session.snapshotEvents(),original)
}))

test('emergency reuses the previous ready prefix while the next raw batch is still generating',async()=>host(async h=>{
  const {raw,rest,current,state}=await readyPrefix(h)
  let release,entered
  const started=new Promise(resolve=>{entered=resolve})
  h.engine.summarizeBackgroundSelection=async()=>{entered();return await new Promise(resolve=>{release=resolve})}
  const original=structuredClone(h.session.snapshotEvents()),generation=h.session.surface.replaceGeneration
  assert.ok(h.engine.startBackgroundFold(h.agent,h.engine.planRolling(h.agent)))
  await started
  const pending=h.engine.backgroundFolds.get(h.agent)
  assert.equal(pending.recoveryReady,state)
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.ok(pending.controller.signal.aborted)
  assert.ok(h.session.surface.nodes.includes(rest.seq));assert.ok(h.session.surface.nodes.includes(current.seq))
  assert.ok(!h.session.surface.nodes.includes(raw.seq));assertRetained(h,original)
  release(state.summarized);await pending.promise
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.notEqual(h.engine.backgroundFolds.get(h.agent),pending,'late output cannot restore the cancelled successor')
}))

test('emergency commits the first sufficient completed batch without waiting for its blocked successor',async()=>{
  let release,started,count=0
  const blocked=new Promise(resolve=>{started=resolve})
  await host(async h=>{
    for(let i=0;i<5;i++)append(h.session,'x'.repeat(76000))
    const current=append(h.session,'Current protected request.')
    await resolvePolicy(h.engine,h.agent,new AbortController().signal)
    const original=structuredClone(h.session.snapshotEvents()),generation=h.session.surface.replaceGeneration
    const done=pressureStep(h.engine,h.agent,new AbortController().signal)
    await blocked
    await done
    assert.equal(h.session.surface.replaceGeneration,generation+1)
    assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens<80000)
    assert.ok(h.session.surface.nodes.includes(current.seq));assertRetained(h,original)
    release('Late successor facts.')
    await tick();await tick()
    assert.equal(h.session.surface.replaceGeneration,generation+1)
    assert.equal(h.engine.backgroundFolds.has(h.agent),false)
  },{reply:async()=>++count===1?'Preserved historical facts.':await new Promise(resolve=>{release=resolve;started()})})
})

test('emergency progress shares one total deadline across successive healthy batches',async()=>host(async h=>{
  h.engine.rollingConfig.summaryTimeoutMs=90
  for(let i=0;i<12;i++)append(h.session,'x'.repeat(38000))
  append(h.session,'Current protected request.')
  const original=structuredClone(h.session.snapshotEvents()),generation=h.session.surface.replaceGeneration
  const controller=new AbortController(),start=Date.now()
  try {
    await assert.rejects(pressureStep(h.engine,h.agent,controller.signal),/后台摘要尚未就绪/)
    assert.ok(Date.now()-start<400,'new batches cannot renew admission indefinitely')
    assert.ok(h.calls.length>=2,'the first healthy batch completed before the shared deadline')
    assert.equal(h.session.surface.replaceGeneration,generation);assertRetained(h,original)
  } finally {controller.abort(Error('Stop the preserved test request'));await h.engine.settleBackgroundFold(h.agent)}
},{reply:async()=>{await new Promise(resolve=>setTimeout(resolve,55));return 'Preserved historical facts.'}}))

test('an insufficient prefix cannot unlock a still oversized main request',async()=>host(async h=>{
  await readyPrefix(h,{tail:360000})
  const original=h.session.snapshotEvents()
  h.engine.summaryGuards.failedSession(h.agent,h.engine.summaryRouteFingerprint(),300000)
  await assert.rejects(pressureStep(h.engine,h.agent,new AbortController().signal),/占用过多空间/)
  assert.deepEqual(h.session.snapshotEvents(),original)
}))

test('emergency recovery rejects a changed source and protects the latest real input',async()=>host(async h=>{
  const {state,raw}=await readyPrefix(h)
  const original=h.session.snapshotEvents()
  const fingerprint=state.summarized.sourceFingerprints[0][1]
  state.summarized.sourceFingerprints[0][1]='changed'
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true}),null)
  assert.deepEqual(h.session.snapshotEvents(),original)
  h.engine.backgroundFolds.set(h.agent,state)
  const derive=h.session.eventAt.bind(h.session)
  h.session.eventAt=seq=>seq===raw.seq?derive(seq):derive(seq).type==='user/message'?{...derive(seq),data:{...derive(seq).data,source:{kind:'runtime-context'}}}:derive(seq)
  state.summarized.sourceFingerprints[0][1]=fingerprint
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true}),null)
  assert.deepEqual(h.session.snapshotEvents(),original)
}))

test('changing the main route invalidates emergency recovery before any replacement',async()=>host(async h=>{
  await readyPrefix(h)
  const original=h.session.snapshotEvents()
  h.agent.options.model='different-context-model'
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true}),null)
  assert.deepEqual(h.session.snapshotEvents(),original)
}))

test('emergency commits a recovery prefix while a successor merge is pending; late output cannot resurrect it',async()=>{
  let finish
  let number=0
  await host(async h=>{
    const {state}=await readyPrefix(h,{first:120000,tail:60000,fixed:200000})
    // Retain the existing recovery regression for an explicitly constrained
    // draft budget; automatic ratio budgets no longer create this tiny budget.
    h.engine.resolvedPolicies.get(h.agent).summaryPrefixTargetTokens=1024
    assert.ok(h.engine.startBackgroundFold(h.agent,{...state.selection,treeOnly:true}))
    await tick()
    const pending=h.engine.backgroundFolds.get(h.agent)
    assert.equal(pending.status,'summarizing');assert.ok(pending.recoveryReady)
    const result=h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true});assert.ok(result)
    assert.equal(pending.controller.signal.aborted,true)
    const generation=h.session.surface.replaceGeneration
    finish('Late merged facts.')
    await pending.promise
    assert.equal(h.session.surface.replaceGeneration,generation)
    assert.equal(h.engine.backgroundFolds.has(h.agent),false)
    assert.equal(h.engine.superLcmStore.loadDraft(h.session.id),null)
    assert.ok(!h.warnings.some(message=>/background summary failed/.test(message)))
  },{reply:async()=>++number===1?'Preserved historical facts and evidence. '.repeat(120):await new Promise(resolve=>{finish=resolve})})
})

for(const failCode of ['SUPERLCM_SUMMARY_NO_PROGRESS','TRANSPORT'])test('frozen small final leaf '+failCode+' preserves originals and only narrows no-progress range',async()=>host(async h=>{
  const {raw,rest,state,policy}=await readyPrefix(h,{first:40000,tail:2400,fixed:200000})
  const current=append(h.session,'Current protected request '+'c'.repeat(140000))
  assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens>=policy.hardActiveTokens)
  const original=structuredClone(h.session.snapshotEvents()),generation=h.session.surface.replaceGeneration
  const readyCalls=h.calls.length
  h.engine.summarizeBackgroundSelection=async()=>{const error=Error('synthetic final leaf failure');error.code=failCode;throw error}
  const selection=h.engine.planRolling(h.agent)
  assert.equal(selection.start,rest.seq);assert.equal(selection.end,rest.seq)
  assert.ok(selection.foldTokens<policy.foldBatchTokens)
  assert.ok(h.engine.startBackgroundFold(h.agent,selection))
  await h.engine.settleBackgroundFold(h.agent)
  const restored=h.engine.backgroundFolds.get(h.agent)
  assert.equal(restored.cutoffEnd,failCode==='SUPERLCM_SUMMARY_NO_PROGRESS'?state.summarized.end:rest.seq)
  if(failCode==='TRANSPORT')return
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
  assert.ok(h.ctx.tokenMeter.measure(h.session).totalTokens<policy.hardActiveTokens)
  assert.ok(h.session.surface.nodes.includes(rest.seq));assert.ok(h.session.surface.nodes.includes(current.seq));assert.ok(!h.session.surface.nodes.includes(raw.seq))
  assertRetained(h,original);assert.equal(h.calls.length,readyCalls,'reuse completed prefix with no new summary purchases')
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.session.surface.replaceGeneration,generation+1)
}))

test('real no-progress final leaf persists narrowed range and survives a fresh host without re-purchasing',async()=>{
  let seed,db,original,currentSeq,tailSeq
  let calls=0
  await host(async h=>{
    const {rest,state}=await readyPrefix(h,{first:40000,tail:2400,fixed:200000})
    const current=append(h.session,'Current exact request '+'c'.repeat(140000))
    const selection=h.engine.planRolling(h.agent)
    assert.ok(h.engine.startBackgroundFold(h.agent,selection));await h.engine.settleBackgroundFold(h.agent)
    assert.ok(h.warnings.some(message=>/summary is not smaller/.test(message)))
    assert.equal(h.engine.backgroundFolds.get(h.agent).cutoffEnd,state.summarized.end)
    assert.equal(JSON.parse(h.engine.superLcmStore.loadDraft(h.session.id).data).cutoffEnd,state.summarized.end)
    seed=h.session.snapshotEvents();original=structuredClone(seed);db=h.db;currentSeq=current.seq;tailSeq=rest.seq
    assert.equal(h.session.surface.replaceGeneration,0)
  },{reply:async()=>++calls===1?'Preserved historical facts.':'Preserved historical facts. '.repeat(250)})
  await host(async h=>{
    await pressureStep(h.engine,h.agent,new AbortController().signal)
    assert.equal(h.calls.length,0)
    assert.equal(h.session.surface.replaceGeneration,1)
    assert.ok(h.session.surface.nodes.includes(currentSeq));assert.ok(h.session.surface.nodes.includes(tailSeq));assertRetained(h,original)
    const rebuilt=new SuperLcmStore(join(h.db,'..','rebuilt-tail.sqlite'))
    try{assert.deepEqual(reindexSession(rebuilt,h.session).errors,[]);assert.equal(doctorSession(rebuilt,h.session).ok,true)}finally{rebuilt.close()}
  },{db,seed})
})
