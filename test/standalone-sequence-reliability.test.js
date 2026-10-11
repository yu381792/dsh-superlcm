// Whole DSH lifecycles with an offline adapter. The provider never leaves this
// process; input admission, request rebuilds and session JSON use the real SDK.
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
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
import {reindexSession,doctorSession} from '../src/core.js'
import {SuperLcmStore} from '../src/store.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const append=(session,text)=>session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'})
const summary='Preserved exact facts, current decisions and pending work.'
const settings={auto:true,budgetMode:'ratio',foldBatchTokens:20000,summarizationProvider:'local',summarizationModel:'summary'}

async function host(run,{config={},reply=async()=>summary,dir=mkdtempSync(join(tmpdir(),'superlcm-sequences-'))}={}) {
  const ctx=new Context(),calls=[],warnings=[]
  ctx.logger.warn=message=>warnings.push(message)
  const capacity=model=>model==='small'?64000:model==='large'?1000000:100000
  try {
    new SessionStore(ctx);new SessionProjections(ctx)
    const adapter=async function*(options) {
      calls.push({model:options.model,sessionId:options.sessionId,inputTokens:Math.ceil(JSON.stringify(options.messages).length/4)})
      const result=await reply(options)
      if(Array.isArray(result))yield*result
      else {yield {type:'text-delta',index:0,text:'# '+result};yield {type:'finish',reason:{kind:'stop'}}}
    }
    ctx.reflect.provide('llm',{
      stream:options=>ctx.waterfall('llm/stream',options,()=>adapter(options)),
      prepareCall:async config=>({config,context:{contextWindow:capacity(config.model)},stream:options=>ctx.llm.stream(options)}),
      resolveModelInfo:async(_provider,model)=>({context:{contextWindow:capacity(model)},defaultMaxTokens:0}),
      imageRequestPricing(){},fileRequestText(){},
    })
    new TokenMeter(ctx)
    const engine=new Engine(ctx,{...settings,archiveHome:dir,...config})
    await tick()
    await run({ctx,engine,calls,warnings,dir,capacity})
  }finally{await ctx.fiber.dispose()}
}

async function loop(ctx,id='sequence-real-loop',model='main') {
  const [{default:Agents},{default:SystemPrompt},{default:Tools},{default:AgentLoop}]=await Promise.all([
    import('@deepseek-ai/dsh-agent'),import('@deepseek-ai/dsh-system-prompt'),import('@deepseek-ai/dsh-tools'),import('@deepseek-ai/dsh-agent-loop')])
  new Agents(ctx);new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new Tools(ctx)
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:10})
  return ctx.agentLoop.create(id,{provider:'local',model},{cwd:'/fixture'})
}

async function send(ctx,agent,text) {
  const errors=[]
  let status,error,timer
  try {
    await new Promise((resolve,reject)=>{
      error=ctx.on('agent/error',payload=>{if(payload.agent===agent)errors.push(payload.error)})
      status=ctx.on('agent/status',payload=>{if(payload.agent===agent&&payload.status==='idle')resolve()})
      timer=setTimeout(()=>reject(Error('offline Agent.send did not settle')),10000)
      agent.send(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),'next-turn',true)
    })
  }finally{status?.();error?.();clearTimeout(timer)}
  return errors
}

function sessionAgent(h,{seed,meta}={}) {
  const id='sequence-restart'
  const session=h.ctx.sessions.create(id,{meta:meta??{id,version:4,createdAt:1,isSeeded:false,cwd:'/fixture'},...(seed?{seed,eventState:'detached'}:{})})
  return {session,options:{provider:'local',model:'main'}}
}

function recordOriginals(session,known=new Map()) {
  for(const [seq,sha] of known)assert.equal(digest(session.eventAt(seq)),sha,`original event ${seq} must remain exact`)
  for(const event of session.snapshotEvents())known.set(event.seq,digest(event))
  return known
}

function verifyTree(h,session,name='rebuild') {
  const reconstructed=new SuperLcmStore(join(h.dir,name+'.sqlite'))
  try {
    assert.equal(reindexSession(reconstructed,session).errors.length,0)
    assert.equal(doctorSession(reconstructed,session).ok,true)
    assert.deepEqual(h.engine.superLcmStore.stats(session.id).missingChildren,[])
  }finally{reconstructed.close()}
}

for(const model of ['small','main','large'])test(`64 real admitted turns on ${model} cross several compression cycles without oversized dispatch or lost originals`,async()=>host(async h=>{
  const agent=await loop(h.ctx,'sequence-real-loop',model),originals=new Map()
  for(let i=0;i<64;i++) {
    const input=`Turn ${i}, authorized task and exact record. `+'x'.repeat(h.capacity(model)*.24)
    assert.equal((await send(h.ctx,agent,input)).length,0)
    await h.engine.settleBackgroundFold(agent)
    recordOriginals(agent.session,originals)
    const latest=h.calls.filter(call=>call.sessionId===agent.session.id).at(-1)
    assert.ok(latest.inputTokens<h.capacity(model)*.9,'the actual adapter sees a request below emergency pressure')
    assert.ok(agent.session.surface.nodes.some(seq=>agent.session.eventAt(seq).data?.content?.some(block=>block.text===input)),'current real input remains verbatim')
  }
  const events=agent.session.snapshotEvents(),starts=events.filter(event=>event.type==='compaction/start'),ends=events.filter(event=>event.type==='compaction/end')
  assert.ok(starts.length>=3,'several complete cycles must run in this fixture')
  assert.equal(starts.length,ends.length)
  assert.equal(new Set(starts.map(event=>event.data.compactionId)).size,starts.length)
  assert.equal(h.calls.filter(call=>call.sessionId===agent.session.id).length,64,'request rebuilds never dispatch the stale request')
  verifyTree(h,agent.session)
}))

for(const fault of ['transport','truncated'])test(`real sends recover after ${fault} summary failure and the cooldown`,async()=>{
  let fail=true,summaryCalls=0
  await host(async h=>{
    const agent=await loop(h.ctx),session=agent.session,originals=new Map()
    let clock=0;h.engine.summaryGuards.clock=()=>clock
    for(let i=0;i<3;i++)append(session,'old authorized facts '+String(i)+'x'.repeat(96000))
    assert.equal((await send(h.ctx,agent,'prepare historical facts')).length,0)
    await h.engine.settleBackgroundFold(agent)
    recordOriginals(session,originals)
    assert.equal(summaryCalls,1)
    const beforeMain=h.calls.filter(call=>call.sessionId===session.id).length
    const errors=await send(h.ctx,agent,'new admitted work '+'y'.repeat(100000))
    assert.ok(errors.length>0,'a temporarily full request is rejected before the adapter')
    assert.equal(h.calls.filter(call=>call.sessionId===session.id).length,beforeMain)
    assert.equal(summaryCalls,1,'the cooldown prevents buying the same failed summary on every input')
    recordOriginals(session,originals)
    fail=false;clock+=300001
    assert.equal((await send(h.ctx,agent,'Continue the retained request.')).length,0)
    await h.engine.settleBackgroundFold(agent)
    recordOriginals(session,originals)
    assert.ok(summaryCalls>1)
    assert.ok(h.ctx.tokenMeter.measure(session).totalTokens<80000)
    assert.ok(h.calls.filter(call=>call.sessionId===session.id).every(call=>call.inputTokens<90000))
    verifyTree(h,session)
  },{reply:async options=>{
    if(options.model!=='summary')return 'Main task response.'
    summaryCalls++
    if(fail&&fault==='transport')throw Error('offline temporary connection error')
    if(fail)return [{type:'text-delta',index:0,text:'# Incomplete historical facts.'},{type:'finish',reason:{kind:'max-tokens'}}]
    return summary
  }})
})

test('a durable ready cycle survives rebuilding the native session and is committed without another model call',async()=>{
  let seed,meta,dir,originals
  await host(async h=>{
    const agent=sessionAgent(h),session=agent.session
    for(let i=0;i<4;i++)append(session,'x'.repeat(90000)+i)
    append(session,'Keep the pending task.')
    await resolvePolicy(h.engine,agent,new AbortController().signal)
    assert.ok(h.engine.startBackgroundFold(agent,h.engine.planRolling(agent)))
    await h.engine.settleBackgroundFold(agent)
    assert.equal(h.engine.backgroundFolds.get(agent).status,'ready')
    assert.equal(session.surface.replaceGeneration,0)
    seed=session.snapshotEvents();meta=session.header;dir=h.dir;originals=recordOriginals(session)
  },{config:{auto:false}})
  await host(async h=>{
    const agent=sessionAgent(h,{seed,meta})
    await pressureStep(h.engine,agent,new AbortController().signal)
    assert.equal(h.calls.length,0)
    assert.equal(agent.session.surface.replaceGeneration,1)
    recordOriginals(agent.session,originals)
    verifyTree(h,agent.session)
  },{dir,config:{auto:false}})
})

test('late output after a policy revision cannot publish; a later legitimate input prepares a fresh cycle',async()=>{
  let release,entered
  const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve})
  let gated=true
  await host(async h=>{
    const agent=sessionAgent(h)
    for(let i=0;i<3;i++)append(agent.session,'x'.repeat(96000)+i)
    append(agent.session,'Current task')
    await resolvePolicy(h.engine,agent,new AbortController().signal)
    h.engine.startBackgroundFold(agent,h.engine.planRolling(agent))
    await started
    const before=recordOriginals(agent.session),pending=h.engine.backgroundFolds.get(agent)
    h.engine.applyRuntimeConfig({...settings,auto:false,summarizationModel:'new-summary',switchRatio:.85})
    release(summary);await pending.promise
    assert.equal(agent.session.surface.replaceGeneration,0)
    assert.equal(h.engine.backgroundFolds.has(agent),false)
    recordOriginals(agent.session,before)
    gated=false
    append(agent.session,'Continue '+'y'.repeat(60000));append(agent.session,'Keep the newest request.')
    await pressureStep(h.engine,agent,new AbortController().signal)
    await h.engine.settleBackgroundFold(agent)
    assert.ok(h.engine.tryCommitBackgroundFold(agent,{allowPressure:true}))
    assert.equal(agent.session.surface.replaceGeneration,1)
    assert.ok(h.calls.some(call=>call.model==='new-summary'))
    verifyTree(h,agent.session)
  },{config:{auto:false},reply:async()=>{if(gated){entered();return gate}return summary}})
})

test('a draft prepared for a large main model is discarded after switching to a smaller model, then rebuilt safely',async()=>host(async h=>{
  const agent=sessionAgent(h);agent.options.model='large'
  for(let i=0;i<3;i++)append(agent.session,'x'.repeat(96000)+i)
  append(agent.session,'Current task')
  await resolvePolicy(h.engine,agent,new AbortController().signal)
  h.engine.startBackgroundFold(agent,h.engine.planRolling(agent))
  await h.engine.settleBackgroundFold(agent)
  const old=h.engine.backgroundFolds.get(agent)
  assert.equal(old.status,'ready')
  agent.options.model='small'
  await resolvePolicy(h.engine,agent,new AbortController().signal)
  assert.equal(h.engine.backgroundFolds.has(agent),false)
  assert.equal(h.engine.restoreDraft(agent),false)
  await pressureStep(h.engine,agent,new AbortController().signal)
  assert.equal(agent.session.surface.replaceGeneration,1)
  assert.ok(h.ctx.tokenMeter.measure(agent.session).totalTokens<64000*.8)
  verifyTree(h,agent.session)
},{config:{auto:false}}))

test('temporary draft persistence failure retains completed work and recovers on the next request',async()=>host(async h=>{
  const agent=sessionAgent(h)
  for(let i=0;i<4;i++)append(agent.session,'x'.repeat(90000)+i)
  append(agent.session,'Current task retained.')
  const originals=recordOriginals(agent.session),store=h.engine.superLcmStore,save=store.saveDraft.bind(store)
  let once=true
  store.saveDraft=(...args)=>{if(once){once=false;throw Error('offline temporary draft write failure')}return save(...args)}
  await resolvePolicy(h.engine,agent,new AbortController().signal)
  h.engine.startBackgroundFold(agent,h.engine.planRolling(agent))
  await h.engine.settleBackgroundFold(agent)
  assert.equal(agent.session.surface.replaceGeneration,0)
  assert.equal(h.engine.backgroundFolds.get(agent).status,'ready')
  await pressureStep(h.engine,agent,new AbortController().signal)
  assert.equal(agent.session.surface.replaceGeneration,1)
  recordOriginals(agent.session,originals)
  verifyTree(h,agent.session)
},{config:{auto:false}}))

test('a real request cancelled while waiting for a summary is retained and the next real send can recover',async()=>{
  let release,entered,first=true
  const gate=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve})
  await host(async h=>{
    const agent=await loop(h.ctx),session=agent.session
    for(let i=0;i<4;i++)append(session,'x'.repeat(90000)+i)
    const running=send(h.ctx,agent,'Keep this admitted task and wait for historical context.')
    await started
    agent.cancel({kind:'user'},{keepInbox:true})
    await running
    const originals=recordOriginals(session)
    assert.equal(h.calls.filter(call=>call.sessionId===session.id).length,0)
    assert.equal(session.surface.replaceGeneration,0)
    release(summary)
    await h.engine.settleBackgroundFold(agent)
    assert.equal(session.surface.replaceGeneration,0,'a late summary remains a private draft after the stopped turn')
    assert.equal((await send(h.ctx,agent,'Continue the retained task.')).length,0)
    recordOriginals(session,originals)
    assert.equal(session.surface.replaceGeneration,1)
    assert.equal(h.calls.filter(call=>call.sessionId===session.id).length,1)
    verifyTree(h,session)
  },{reply:async options=>{
    if(options.model==='summary'&&first){first=false;entered();return gate}
    return summary
  }})
})
