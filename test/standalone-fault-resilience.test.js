// Faults pass through real DSH adapter normalization, planning and Agent.send.
// All originals, sessions and providers in this suite are synthetic and local.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import Llm,{LlmAdapter,createUserMessage,LlmError} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Agents from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Engine from '../src/engine.js'
import {pressureStep} from '../src/ratio-runtime.js'
import {reindexSession,doctorSession} from '../src/core.js'
import {SuperLcmStore} from '../src/store.js'
import {controlsConfig} from '../src/controls-config.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const message=text=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
const configuration={auto:true,budgetMode:'ratio',maxTokens:1024,foldBatchTokens:20000,summaryTimeoutMs:60,summaryRetryCooldownMs:10,summarizationProvider:'offline',summarizationModel:'summary',fallbackSummarizationProvider:'backup',fallbackSummarizationModel:'fallback'}
async function host(run,{mode='success',dir=mkdtempSync(join(tmpdir(),'sl-faults-')),seed,historyCount=4}={}) {
  const ctx=new Context(),h={ctx,dir,mode,calls:[],requests:[],gates:[]}
  ctx.logger.warn=()=>{}
  class Offline extends LlmAdapter {
    async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:model==='main'?100000:1000000},defaultMaxTokens:1024}}
    async *stream(options){
      h.calls.push(options.model)
      h.requests.push(options)
      if(['final-quota','partial-final','final-cancel'].includes(h.mode)) {
        const first=h.mode==='partial-final'&&options.model==='summary'&&h.calls.filter(model=>model==='summary').length===1
        if(options.model!=='main'&&!first)throw new LlmError('Synthetic exhausted summary route','QUOTA')
        if(h.mode==='final-cancel'&&options.model==='main'&&options.purpose==='compaction')await new Promise(resolve=>h.gates.push(resolve))
      }
      if(h.mode==='both-fail'||options.model==='summary') {
        if(['ACCOUNT_QUOTA','ACCOUNT_SIGN_IN_REQUIRED','ACCOUNT_TOKEN_INVALID','MISSING_CREDENTIAL','INVALID_CREDENTIAL'].includes(h.mode))throw new LlmError('Synthetic route failure with private diagnostics withheld',h.mode)
        if(h.mode==='both-fail'||h.mode==='quota')throw new LlmError('Synthetic quota exhausted','QUOTA')
        if(h.mode==='auth')throw new LlmError('Synthetic authentication failure','AUTH')
        if(h.mode==='rate')throw new LlmError('Synthetic rate limit','RATE_LIMIT')
        if(h.mode==='aware')await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))
        if(['ignored','cancel'].includes(h.mode))await new Promise(resolve=>h.gates.push(resolve))
        if(h.mode==='cutoff'){yield {type:'text-delta',index:0,text:'# Partial'};return}
        if(h.mode==='length'){yield {type:'finish',reason:{kind:'max-tokens'}};return}
      }
      yield {type:'text-delta',index:0,text:'# Preserved historical facts and pending work.'}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  try {
    new SessionStore(ctx);new SessionProjections(ctx);new Llm(ctx);ctx.llm.registerAdapter(['offline','backup'],new Offline());new TokenMeter(ctx)
    h.engine=new Engine(ctx,{...configuration,archiveHome:dir})
    await tick()
    if(seed){h.agent={session:ctx.sessions.create('fault-test',{meta:{id:'fault-test',version:4,createdAt:1,isSeeded:false,cwd:'/fixture'},seed,eventState:'detached'}),options:{provider:'offline',model:'main',maxTokens:1024}}}
    else {
      new Agents(ctx);new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new Tools(ctx);new AgentLoop(ctx,{agents:[],maxParallelToolCalls:10})
      h.agent=await ctx.agentLoop.create('fault-test',{provider:'offline',model:'main',maxTokens:1024},{cwd:'/fixture'})
      for(let i=0;i<historyCount;i++)h.agent.session.append('user/message',message('Synthetic historical task '+i+' '+'x'.repeat(96000)),{surfaceOp:'append'})
    }
    h.originals=new Map(h.agent.session.snapshotEvents().map(event=>[event.seq,hash(event)]))
    await run(h)
  } finally {
    for(const controller of h.engine?.backgroundControllers||[])controller.abort(Error('Fixture finished'))
    for(const release of h.gates)release()
    await h.engine?.settleBackgroundFold(h.agent)
    await ctx.fiber.dispose()
  }
}
async function send(h,text='Current synthetic user task.') {
  h.latest=text
  const errors=[];let status,error,timer
  try {
    await new Promise((resolve,reject)=>{
      error=h.ctx.on('agent/error',payload=>{if(payload.agent===h.agent)errors.push(payload.error)})
      status=h.ctx.on('agent/status',payload=>{if(payload.agent===h.agent&&payload.status==='idle')resolve()})
      timer=setTimeout(()=>reject(Error('Offline request did not settle')),5000)
      h.agent.send(message(text),'next-turn',true)
    })
  }finally{status?.();error?.();clearTimeout(timer)}
  return errors
}
const events=(h,type)=>h.agent.session.snapshotEvents().filter(event=>event.type===type)
function verify(h,{closed=true}={}) {
  const session=h.agent.session
  for(const [seq,digest] of h.originals)assert.equal(hash(session.eventAt(seq)),digest)
  if(h.latest)assert.ok(session.surface.nodes.some(seq=>session.eventAt(seq).data?.content?.some(block=>block.text===h.latest)))
  const store=new SuperLcmStore(join(h.dir,'rebuilt-'+Date.now()+'.sqlite'))
  try{assert.deepEqual(reindexSession(store,session).errors,[]);assert.equal(doctorSession(store,session).ok,closed)}finally{store.close()}
}

for(const mode of ['aware','ignored'])test(`${mode} primary timeout uses configured backup and real resubmission reaches main, without late commits`,async()=>host(async h=>{
  await send(h);await h.engine.settleBackgroundFold(h.agent)
  assert.ok(h.calls.includes('fallback'));assert.notEqual(h.engine.backgroundFolds.get(h.agent)?.status,'cancelling')
  assert.deepEqual(await send(h,'Retry retained synthetic task.'),[])
  assert.equal(h.calls.filter(model=>model==='main').length,1)
  const replaced=h.agent.session.surface.replaceGeneration
  for(const release of h.gates)release()
  await sleep(20);await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.agent.session.surface.replaceGeneration,replaced)
  verify(h)
},{mode}))

for(const mode of ['auth','quota','ACCOUNT_QUOTA','ACCOUNT_SIGN_IN_REQUIRED','ACCOUNT_TOKEN_INVALID','MISSING_CREDENTIAL','INVALID_CREDENTIAL'])test(`${mode} SDK terminal failure keeps safe class, long cooldown and healthy backup`,async()=>host(async h=>{
  assert.deepEqual(await send(h),[]);await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.calls.filter(model=>model==='summary').length,1)
  assert.ok(h.calls.includes('fallback'))
  const route=h.engine.summaryGuards.routes.get(JSON.stringify(['offline','summary']))
  assert.ok(route.retryAt-Date.now()>290000)
  verify(h)
},{mode}))

for(const mode of ['rate','cutoff','length'])test(`${mode} primary failure rejects its output and finitely uses backup`,async()=>host(async h=>{
  assert.deepEqual(await send(h),[]);await h.engine.settleBackgroundFold(h.agent)
  assert.ok(h.calls.includes('fallback'));assert.equal(events(h,'compaction/summary').length,1);verify(h)
},{mode}))

test('user cancellation releases a hung adapter and refuses its late draft, replacement and backup',async()=>host(async h=>{
  const pending=send(h);while(!h.gates.length)await tick()
  h.agent.cancel({kind:'user'});await pending
  assert.equal(h.engine.backgroundFolds.has(h.agent),false)
  for(const release of h.gates)release();await sleep(20)
  assert.equal(h.engine.superLcmStore.loadDraft(h.agent.session.id),null)
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{allowPressure:true}),null)
  assert.deepEqual(h.calls,['summary']);assert.equal(events(h,'compaction/summary').length,0);verify(h)
},{mode:'cancel'}))

test('both configured routes exhausted preserve current input and bounded calls through cooldown',async()=>host(async h=>{
  assert.ok((await send(h)).length>0);await h.engine.settleBackgroundFold(h.agent)
  assert.deepEqual(h.calls,['summary','fallback','main'])
  await assert.rejects(pressureStep(h.engine,h.agent,new AbortController().signal))
  assert.deepEqual(h.calls,['summary','fallback','main']);assert.equal(events(h,'compaction/start').length,0);verify(h)
},{mode:'both-fail'}))

for(const phase of ['compaction/start','compaction/summary','user/message'])test(`transient ${phase} commit write failure reuses ready summary without rebuying`,async()=>host(async h=>{
  await send(h);await h.engine.settleBackgroundFold(h.agent)
  const append=h.agent.session.append.bind(h.agent.session);let failed=false
  h.agent.session.append=(type,data,...args)=>{
    if(!failed&&type===phase&&(type!=='user/message'||data.source?.kind==='compact-checkpoint')){failed=true;throw Error('Synthetic write failure')}
    return append(type,data,...args)
  }
  // Failure remains injected until exercised by the actual pressure path.
  const calls=h.calls.length
  try{await pressureStep(h.engine,h.agent,new AbortController().signal)}catch{}
  assert.equal(failed,true);assert.equal(h.calls.length,calls)
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.calls.length,calls);assert.equal(h.agent.session.surface.replaceGeneration,1)
  assert.equal(h.engine.superLcmStore.loadDraft(h.agent.session.id),null);verify(h)
},{mode:'aware'}))

test('end write fails once: closure retries without buying or replacing twice',async()=>host(async h=>{
  const append=h.agent.session.append.bind(h.agent.session);let failed=false
  h.agent.session.append=(type,...args)=>{if(type==='compaction/end'&&!failed){failed=true;throw Error('Synthetic end failure')}return append(type,...args)}
  assert.deepEqual(await send(h),[]);assert.equal(failed,true)
  assert.equal(events(h,'compaction/start').length,1);assert.equal(events(h,'compaction/end').length,1)
  assert.equal(h.engine.superLcmStore.loadDraft(h.agent.session.id),null)
  assert.deepEqual(await send(h,'Continue after transient end failure.'),[]);verify(h)
}))

for(const restart of [false,true])test(`persistent end failure recovers ${restart?'after host restart':'in the same host'} from durable replacement with zero rebuy`,async()=>{
  let seed,dir
  await host(async h=>{
    const append=h.agent.session.append.bind(h.agent.session)
    h.agent.session.append=(type,...args)=>{if(type==='compaction/end')throw Error('Synthetic persistent end failure');return append(type,...args)}
    const errors=await send(h);assert.ok(errors.length);assert.match(errors.map(e=>e.message).join(' '),/结束记录|persistent end/);assert.equal(events(h,'compaction/end').length,0);verify(h,{closed:false})
    const before=h.calls.length
    if(restart){seed=h.agent.session.snapshotEvents();dir=h.dir;return}
    h.agent.session.append=append
    await pressureStep(h.engine,h.agent,new AbortController().signal)
    assert.equal(h.calls.length,before);assert.equal(h.agent.session.surface.replaceGeneration,1)
    assert.equal(events(h,'compaction/end').length,1);verify(h)
  })
  if(restart)await host(async h=>{
    await pressureStep(h.engine,h.agent,new AbortController().signal)
    await pressureStep(h.engine,h.agent,new AbortController().signal)
    assert.deepEqual(h.calls,[]);assert.equal(events(h,'compaction/start').length,1)
    assert.equal(events(h,'compaction/summary').length,1);assert.equal(events(h,'compaction/end').length,1);verify(h)
  },{dir,seed})
})

test('control document retains explicit backup and rejects partial or identical routes',()=>{
  const base={auto:true,summarizationProvider:'primary',summarizationModel:'summary',summaryAdapter:{plugin:'test'}}
  const doc=controlsConfig({...base,fallbackSummarizationProvider:'backup',fallbackSummarizationModel:'fallback'})
  assert.equal(doc.fallbackSummarizationProvider,'backup');assert.equal(doc.fallbackSummarizationModel,'fallback')
  assert.throws(()=>controlsConfig({...base,fallbackSummarizationProvider:'backup'}))
  assert.throws(()=>controlsConfig({...base,fallbackSummarizationProvider:'primary',fallbackSummarizationModel:'summary'}))
})

for(const mode of ['final-quota','partial-final'])test(`${mode} uses current conversation model once for the complete emergency prefix`,async()=>host(async h=>{
  assert.deepEqual(await send(h),[])
  const calls=h.requests.filter(options=>options.model==='main'&&options.purpose==='compaction')
  assert.equal(calls.length,1)
  assert.equal(h.requests.filter(options=>options.model==='main'&&options.purpose!=='compaction').length,1)
  assert.ok(JSON.stringify(calls[0].messages).length/4<100000,'final compaction fixture fits the real main-model window')
  if(mode==='partial-final'){
    assert.match(JSON.stringify(calls[0].messages),/Verified historical background summary/)
    assert.doesNotMatch(JSON.stringify(calls[0].messages),/Synthetic historical task 0/)
  }
  assert.equal(events(h,'compaction/start').length,1);assert.equal(events(h,'compaction/end').length,1)
  const count=h.calls.length
  await pressureStep(h.engine,h.agent,new AbortController().signal)
  assert.equal(h.calls.length,count);verify(h)
},{mode,historyCount:mode==='partial-final'?5:4}))

test('user cancels the final main-model rescue: late output cannot replace or store',async()=>host(async h=>{
  const pending=send(h);while(!h.gates.length)await tick()
  h.agent.cancel({kind:'user'});await pending
  for(const release of h.gates)release();await sleep(20)
  assert.equal(h.engine.superLcmStore.loadDraft(h.agent.session.id),null)
  assert.equal(events(h,'compaction/start').length,0)
  assert.equal(h.requests.filter(options=>options.purpose==='compaction'&&options.model==='main').length,1);verify(h)
},{mode:'final-cancel'}))
