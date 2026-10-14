// Real host, local adapter, temporary archive. No production settings or APIs.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,writeFileSync,appendFileSync,readFileSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import Llm,{LlmAdapter,LlmError,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionStore} from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Agents from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools,{defineTool} from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import {toolPairingBalancedBefore,toolPairingBalancedAfter} from '@deepseek-ai/dsh-compaction'
import Engine from '../../src/engine.js'
import {resolvePolicy,pressureStep} from '../../src/ratio-runtime.js'
import {SuperLcmStore} from '../../src/store.js'
import {reindexSession,doctorSession} from '../../src/core.js'

export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export const tick=()=>new Promise(resolve=>setImmediate(resolve))
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const message=text=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
const summary='# Historical decisions\nOriginals remain available through exact source references. Preserve current authorization, unresolved questions and recorded evidence. This offline summary tests control flow, not semantic quality.'

export async function lab({capacity=200000,mode='normal',config={},dir,seed,id='matrix-session',fixed=0,priceFactor=1,persistent=false,resume=false}={}) {
  dir??=mkdtempSync(join(tmpdir(),'superlcm-reliability-'))
  mkdirSync(dir,{recursive:true})
  const ctx=new Context(),h={ctx,dir,id,capacity,model:'main-'+capacity,mode,calls:[],main:[],errors:[],warnings:[],gates:[],toolRuns:[],activeTools:0,maxParallel:0,boundaryChecks:[],originals:new Map(),generation:0}
  ctx.logger.warn=value=>h.warnings.push(String(value))
  class Offline extends LlmAdapter {
    imageRequestPricing(){return h.imageCost?{priceImages:images=>images.map(()=>({visualTokens:h.imageCost,text:'Synthetic image handle'}))}:undefined}
    async resolveModel(provider,model){return {provider,id:model,name:model,context:{contextWindow:model.startsWith('main-')?Number(model.slice(5)):1000000},defaultMaxTokens:2048}}
    async *stream(options){
      const serialized=JSON.stringify(options.messages)
      const entry={model:options.model,provider:options.provider,purpose:options.purpose,sessionId:options.sessionId,signal:options.signal,characters:serialized.length,maxTokens:options.maxTokens,inputHash:hash(options.messages),content:serialized}
      h.calls.push(entry)
      await h.beforeModel?.(options,entry)
      const requestWindow=options.model.startsWith('main-')?Number(options.model.slice(5)):1000000
      entry.inputTokens=Math.ceil((entry.characters/4+(options.tools?.length?JSON.stringify(options.tools).length/4+4:0))*priceFactor)
      assert.ok(entry.inputTokens+(options.maxTokens||0)<requestWindow,'oversized request reached the adapter: '+options.purpose)
      if(options.purpose==='compaction') {
        const input=JSON.stringify(options.messages)
        assert.ok(!input.includes(h.current),'current request must not become summary source')
        const primary=options.provider==='lab-primary'
        if(h.mode==='both-quota'||h.mode==='all-quota') {
          if(options.model!==h.agent.options.model||h.mode==='all-quota')throw new LlmError('Synthetic quota','ACCOUNT_QUOTA')
        }
        if(primary&&['auth','quota','transport','rate'].includes(h.mode))throw new LlmError('Synthetic route failure',h.mode==='auth'?'ACCOUNT_TOKEN_INVALID':h.mode==='quota'?'ACCOUNT_QUOTA':h.mode==='rate'?'RATE_LIMIT':'TRANSPORT')
        if(primary&&h.mode==='truncated'){yield {type:'text-delta',index:0,text:summary};return}
        if(primary&&h.mode==='length'){yield {type:'finish',reason:{kind:'max-tokens'}};return}
        if(primary&&h.mode==='invalid'){yield {type:'text-delta',index:0,text:'invalid heading'};yield {type:'finish',reason:{kind:'stop'}};return}
        if(primary&&h.mode==='timeout-aware')await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))
        if(primary&&['timeout-ignored','cancel','block'].includes(h.mode))await new Promise(resolve=>h.gates.push({resolve,signal:options.signal}))
        if(h.mode==='slow'||h.summaryDelay)await sleep(h.summaryDelay||8)
        entry.finished=!options.signal.aborted
        yield {type:'text-delta',index:0,text:summary};yield {type:'finish',reason:{kind:'stop'}};return
      }
      const modelCapacity=Number(options.model.slice(5))
      assert.ok(entry.characters/4+(options.maxTokens||0)<modelCapacity,'oversized main request reached the adapter')
      assert.ok(JSON.stringify(options.messages).includes(h.current)||h.allowedQueuedInputs?.some(text=>JSON.stringify(options.messages).includes(text)),'actual main request must retain an exact admitted input')
      h.main.push(entry)
      if(h.fixedText)assert.ok(JSON.stringify(options.messages).includes(h.fixedText),'fixed system prompt must remain exact')
      if(h.toolRequest&&!h.toolIssued.has(h.current)){
        h.toolIssued.add(h.current)
        for(let i=0;i<h.toolRequest.count;i++)yield {type:'tool-call-delta',index:i,id:'lab-'+randomUUID(),name:'lab_payload',argumentsDelta:JSON.stringify({characters:h.toolRequest.characters,number:i})}
        yield {type:'finish',reason:{kind:'tool-calls'}};return
      }
      yield {type:'text-delta',index:0,text:'Answered '+h.current.slice(0,70)}
      if(priceFactor!==1)yield {type:'usage',usage:{inputTokens:entry.inputTokens,outputTokens:30,totalTokens:entry.inputTokens+30}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  try {
    new SessionStore(ctx);new SessionProjections(ctx);new Llm(ctx)
    ctx.llm.registerAdapter(['lab-primary','lab-backup','lab-main'],new Offline())
    if(persistent)new Persistence(ctx,{root:join(dir,'sessions'),compression:'none'})
    new TokenMeter(ctx);new Agents(ctx)
    new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});new Tools(ctx,{mode:'native'})
    ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:10})
    await until(()=>!!ctx.agentLoop)
    if(fixed){h.fixedText='Fixed operating rules. '+'s'.repeat(fixed);ctx.systemPrompt.section({name:'lab-fixed',order:100,text:h.fixedText,interpolate:false})}
    h.toolIssued=new Set()
    ctx.tools.register(defineTool({name:'lab_payload',description:'Return a deterministic test-only text payload.',parameters:{characters:{type:'integer',required:true},number:{type:'integer',required:true}},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},isConcurrencySafe:()=>true,async execute(args){h.toolRuns.push(args);h.activeTools++;h.maxParallel=Math.max(h.maxParallel,h.activeTools);await sleep(args.number?2:4);h.activeTools--;return 'TOOL_RESULT_'+args.number+' '+'t'.repeat(args.characters)}}))
    h.engine=new Engine(ctx,{auto:true,budgetMode:'ratio',archiveHome:dir,foldBatchTokens:20000,summaryTimeoutMs:1500,summaryRetryCooldownMs:10,summarizationProvider:'lab-primary',summarizationModel:'summary',fallbackSummarizationProvider:'lab-backup',fallbackSummarizationModel:'backup',...config})
    await tick()
    if(resume){h.handle=await ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'lab-main',model:h.model,maxTokens:2048}});h.agent=h.handle.agent}
    else if(persistent){h.handle=await ctx.agents.create({sessionId:id,agentOptions:{provider:'lab-main',model:h.model,maxTokens:2048},meta:{cwd:dir}});h.agent=h.handle.agent}
    else if(seed){const handle=await ctx.agents.create({sessionId:id,seed:seed.events,meta:seed.header,agentOptions:{provider:'lab-main',model:'main-'+capacity,maxTokens:2048}});h.agent=handle.agent}
    else h.agent=await ctx.agentLoop.create(id,{provider:'lab-main',model:'main-'+capacity,maxTokens:2048},{cwd:dir})
    h.agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),model:h.model}))
    h.journal=join(dir,'session-events-'+randomUUID()+'.jsonl')
    writeFileSync(h.journal,JSON.stringify({header:h.agent.session.header})+'\n'+h.agent.session.snapshotEvents().map(e=>JSON.stringify(e)+'\n').join(''))
    ctx.on('session/event',(session,event)=>{
      if(session.id!==id)return
      appendFileSync(h.journal,JSON.stringify(event)+'\n')
      if(event.type==='compaction/summary'){
        const range=event.data.shadowedRange
        try{h.boundaryChecks.push({before:toolPairingBalancedBefore(session,range.start),after:toolPairingBalancedAfter(session,range.end)})}
        catch(error){h.boundaryChecks.push({error:error.message})}
      }
    })
    h.current='not-yet-admitted-'+randomUUID()
    return h
  } catch(error){await ctx.fiber.dispose();throw error}
}

export async function close(h){
  for(const controller of h.engine.backgroundControllers)controller.abort(Error('Test finished'))
  for(const gate of h.gates)gate.resolve()
  await h.engine.settleBackgroundFold(h.agent)
  await h.handle?.dispose()
  await h.ctx.fiber.dispose()
}

export async function send(h,text,{timeout=15000}={}) {
  h.current=text
  const errors=[];let status,error,timer
  try {
    await new Promise((resolve,reject)=>{
      error=h.ctx.on('agent/error',payload=>{if(payload.agent===h.agent)errors.push(payload.error)})
      status=h.ctx.on('agent/status',payload=>{if(payload.agent===h.agent&&payload.status==='idle')resolve()})
      timer=setTimeout(()=>reject(Error('Real Agent.send did not settle')),timeout)
      h.agent.send(message(text),'next-turn',true)
    })
  }finally{status?.();error?.();clearTimeout(timer)}
  h.errors.push(...errors)
  return errors
}

export function remember(h){
  for(const [seq,value] of h.originals)assert.equal(hash(h.agent.session.eventAt(seq)),value,'original event changed at '+seq)
  for(const event of h.agent.session.snapshotEvents())h.originals.set(event.seq,hash(event))
}
export function history(h,ratio=.92,{pieces=12}={}){
  const characters=Math.floor((h.capacity-2048)*4*ratio/pieces)
  for(let i=0;i<pieces;i++)h.agent.session.append('user/message',message('Historical decision '+i+' '+'x'.repeat(characters)),{surfaceOp:'append'})
  remember(h)
}
export const count=(h,type)=>h.agent.session.snapshotEvents().filter(e=>e.type===type).length
export async function checkpoint(h,{closed=true,duplicate=true}={}){
  if(duplicate){await pressureStep(h.engine,h.agent,new AbortController().signal);await h.engine.settleBackgroundFold(h.agent)}
  remember(h)
  assert.ok(h.agent.session.surface.nodes.some(seq=>JSON.stringify(h.agent.session.eventAt(seq).data).includes(h.current)),'current input missing from live surface')
  const starts=h.agent.session.snapshotEvents().filter(e=>e.type==='compaction/start'),ends=h.agent.session.snapshotEvents().filter(e=>e.type==='compaction/end')
  if(closed)assert.equal(starts.length,ends.length,'unclosed replacement')
  const successful=ends.filter(e=>!e.data.error)
  assert.equal(new Set(successful.map(e=>e.data.compactionId)).size,successful.length,'duplicate successful compaction identifier')
  assert.equal(h.agent.session.surface.replaceGeneration,successful.length,'replacement count disagrees with successful closing events')
  const archive=readFileSync(h.journal,'utf8').trim().split('\n').map(JSON.parse).slice(1)
  for(const event of archive)assert.equal(hash(h.agent.session.eventAt(event.seq)),hash(event),'journal disagrees with original event')
  const rebuilt=new SuperLcmStore(join(h.dir,'rebuilt-'+randomUUID()+'.sqlite'))
  try{
    assert.deepEqual(reindexSession(rebuilt,h.agent.session).errors,[])
    assert.equal(doctorSession(rebuilt,h.agent.session).ok,closed)
    assert.deepEqual(h.engine.superLcmStore.stats(h.id).missingChildren,[])
  }finally{rebuilt.close()}
  if(duplicate){
    const replacements=h.agent.session.surface.replaceGeneration,calls=h.calls.length
    for(let i=0;i<3;i++)await pressureStep(h.engine,h.agent,new AbortController().signal)
    assert.equal(h.agent.session.surface.replaceGeneration,replacements,'repeated check replaced again')
    assert.equal(h.calls.length,calls,'repeated check repurchased work')
  }
  return {window:h.capacity,mainCalls:h.main.length,summaryCalls:h.calls.length-h.main.length,compactions:successful.length,failedCommitAttempts:ends.length-successful.length,originalEvents:archive.length,activeTokens:h.ctx.tokenMeter.measure(h.agent.session).totalTokens}
}
export async function until(predicate,timeout=5000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('Test condition did not occur');await tick()}}
export async function restoreReady(h){await resolvePolicy(h.engine,h.agent,new AbortController().signal);return h.engine.restoreDraft(h.agent)}
export async function prepare(h){await resolvePolicy(h.engine,h.agent,new AbortController().signal);const next=h.engine.planRolling(h.agent);assert.ok(next);assert.ok(h.engine.startBackgroundFold(h.agent,next));await h.engine.settleBackgroundFold(h.agent)}
export function snapshot(h){return {header:h.agent.session.header,events:h.agent.session.snapshotEvents()}}
export function boundaries(h){
  assert.ok(h.boundaryChecks.length>0)
  for(const check of h.boundaryChecks){assert.ok(!check.error,check.error);assert.ok(check.before);assert.ok(check.after)}
}
