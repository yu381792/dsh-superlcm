import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync,mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {lab,close,send,remember,history,count,checkpoint,until,restoreReady,prepare,snapshot,boundaries,tick,sleep} from './reliability/lab.mjs'
import {resolvePolicy,pressureStep} from '../src/ratio-runtime.js'
import {rescueOutputBudget} from '../src/rescue-budget.js'
import {automaticRatios} from '../src/ratio-policy.js'

const evidence=[]
async function scenario(name,options,body){
  const h=await lab(options)
  try {const result=await body(h);evidence.push({scenario:name,status:'passed',...result})}
  catch(error){evidence.push({scenario:name,status:'failed',message:error.message});throw error}
  finally{await close(h)}
}
test.after(()=>{
  if(!process.env.SUPERLCM_MATRIX_REPORT)return
  const dir=process.env.SUPERLCM_MATRIX_REPORT;mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'matrix.json'),JSON.stringify({captured:new Date().toISOString(),realSdk:true,paidCalls:0,productionSettingsChanged:false,scenarios:evidence},null,2)+'\n')
})

for(const capacity of [64000,200000,500000,1000000])for(const mode of ['normal','slow']){
  const name=`${capacity} window: 72 real turns and repeated compression (${mode})`
  test(name,async()=>scenario(name,{capacity,mode},async h=>{
    for(let turn=0;turn<72;turn++){
      const input='CURRENT_'+turn+' '+'x'.repeat(Math.floor((capacity-2048)*.26))
      assert.deepEqual(await send(h,input),[])
      if(mode==='normal')await h.engine.settleBackgroundFold(h.agent)
      remember(h)
    }
    await h.engine.settleBackgroundFold(h.agent)
    assert.equal(h.main.length,72);assert.ok(count(h,'compaction/end')>=4,'fixture must cross several complete cycles')
    return await checkpoint(h)
  }))
}

for(const mode of ['timeout-aware','timeout-ignored','quota','auth','transport','rate','truncated','length','invalid','both-quota','all-quota']){
  const name='200K emergency: '+mode
  test(name,async()=>scenario(name,{mode,config:{summaryTimeoutMs:90}},async h=>{
    history(h)
    const errors=await send(h,'CURRENT_'+mode)
    await h.engine.settleBackgroundFold(h.agent)
    if(mode==='both-quota'){
      assert.deepEqual(errors,[],'healthy main-model rescue must fit its own input plus output budget')
      assert.equal(h.calls.filter(c=>c.purpose==='compaction'&&c.model===h.agent.options.model).length,1)
    }
    if(errors.length){assert.equal(h.main.length,0);h.mode='normal';h.engine.summaryGuards.clock=()=>Date.now()+600000;assert.deepEqual(await send(h,'RETRY_'+mode),[]);await h.engine.settleBackgroundFold(h.agent)}
    assert.ok(h.main.length>=1,'a healthy route must eventually reach the main model')
    const generation=h.agent.session.surface.replaceGeneration
    for(const gate of h.gates)gate.resolve()
    await tick();await tick()
    assert.equal(h.agent.session.surface.replaceGeneration,generation,'old route late output replaced again')
    return await checkpoint(h)
  }))
}

test('200K cancel while summary ignores abort, then real current-request retry',async()=>scenario('cancel and retry',{mode:'cancel'},async h=>{
  history(h)
  const pending=send(h,'CURRENT_CANCEL')
  await until(()=>h.gates.length>0)
  h.agent.cancel({kind:'user'});await pending
  assert.equal(count(h,'compaction/start'),0);assert.equal(h.main.length,0)
  for(const gate of h.gates)gate.resolve()
  await tick();await tick()
  assert.equal(h.engine.superLcmStore.loadDraft(h.id),null)
  h.mode='normal';assert.deepEqual(await send(h,'CURRENT_AFTER_CANCEL'),[]);await h.engine.settleBackgroundFold(h.agent)
  return await checkpoint(h)
}))

for(const countTools of [1,3])test(`200K actual ${countTools} parallel tools produce large results across the pressure boundary`,async()=>scenario('tools-'+countTools,{},async h=>{
  history(h,.55,{pieces:8})
  h.toolRequest={count:countTools,characters:Math.floor((200000-2048)*4*.42/countTools)}
  assert.deepEqual(await send(h,'CURRENT_RUN_REAL_TOOLS'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.toolRuns.length,countTools)
  assert.equal(count(h,'tool/result'),countTools)
  assert.ok(count(h,'compaction/end')>=1)
  boundaries(h)
  return await checkpoint(h)
}))

for(const phase of ['compaction/start','compaction/summary','user/message','compaction/end'])test('200K transient write failure: '+phase,async()=>scenario('write-'+phase,{},async h=>{
  history(h)
  const append=h.agent.session.append.bind(h.agent.session);let failures=0
  h.agent.session.append=(type,data,...args)=>{
    if(type===phase&&failures===0&&(phase!=='user/message'||data.source?.kind==='compact-checkpoint')){failures++;throw Error('Synthetic single write failure')}
    return append(type,data,...args)
  }
  const errors=await send(h,'CURRENT_WRITE_'+phase);await h.engine.settleBackgroundFold(h.agent)
  const calls=h.calls.filter(c=>c.purpose==='compaction').length
  if(errors.length)assert.deepEqual(await send(h,'CURRENT_WRITE_RETRY'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(failures,1);assert.equal(h.agent.session.surface.replaceGeneration,1)
  assert.equal(h.calls.filter(c=>c.purpose==='compaction').length,calls,'the ready batch should not be purchased again')
  return await checkpoint(h)
}))

test('200K process-like fresh host restores ready draft from disk and answers without buying it twice',async()=>{
  let seed,dir,id,calls
  await scenario('restart-prepare',{config:{auto:false}},async h=>{
    history(h);assert.deepEqual(await send(h,'CURRENT_BEFORE_RESTART'),[])
    await prepare(h);assert.ok(h.engine.superLcmStore.loadDraft(h.id));seed=snapshot(h);dir=h.dir;id=h.id;calls=h.calls.length
    return {readyBatches:h.engine.backgroundFolds.get(h.agent).parts.length,summaryCalls:calls}
  })
  await scenario('restart-answer',{dir,seed,id},async h=>{
    assert.ok(await restoreReady(h));remember(h)
    assert.deepEqual(await send(h,'CURRENT_AFTER_RESTART'),[])
    assert.equal(h.calls.filter(c=>c.purpose==='compaction').length,0)
    return await checkpoint(h)
  })
})

for(const capacity of [64000,500000,1000000])test(`main-model rescue fits the actual ${capacity} window including its output reservation`,async()=>scenario('rescue-window-'+capacity,{capacity,mode:'both-quota'},async h=>{
  history(h)
  assert.deepEqual(await send(h,'CURRENT_RESCUE_'+capacity),[])
  await h.engine.settleBackgroundFold(h.agent)
  const calls=h.calls.filter(c=>c.purpose==='compaction'&&c.model===h.agent.options.model)
  assert.equal(calls.length,1);assert.ok(calls[0].characters/4+calls[0].maxTokens<capacity)
  return await checkpoint(h)
}))

test('main-model-specific output override cannot enlarge the rescue beyond its window',async()=>scenario('rescue-output-override',{mode:'both-quota',config:{modelPolicies:[{provider:'lab-main',model:'main-200000',maxTokens:180000}]}},async h=>{
  history(h)
  assert.deepEqual(await send(h,'CURRENT_RESCUE_OVERRIDE'),[])
  await h.engine.settleBackgroundFold(h.agent)
  const call=h.calls.find(c=>c.purpose==='compaction'&&c.model===h.agent.options.model)
  assert.ok(call);assert.ok(call.maxTokens<180000)
  return await checkpoint(h)
}))

test('transient draft persistence failure retains completed output and does not buy the same batch twice',async()=>scenario('draft-save-failure',{},async h=>{
  history(h)
  const save=h.engine.superLcmStore.saveDraft.bind(h.engine.superLcmStore);let failures=0
  h.engine.superLcmStore.saveDraft=(...args)=>{if(!failures++){throw Error('Isolated first draft write failure')}return save(...args)}
  await send(h,'CURRENT_DRAFT_WRITE');await h.engine.settleBackgroundFold(h.agent)
  const hashes=h.calls.filter(c=>c.purpose==='compaction').map(c=>c.inputHash)
  h.engine.summaryGuards.clock=()=>Date.now()+600000
  assert.deepEqual(await send(h,'CURRENT_AFTER_DRAFT_WRITE'),[]);await h.engine.settleBackgroundFold(h.agent)
  const later=h.calls.filter(c=>c.purpose==='compaction').map(c=>c.inputHash)
  assert.equal(new Set(later).size,later.length,'an identical completed prompt was bought again')
  assert.ok(later.length>=hashes.length)
  return await checkpoint(h)
}))

test('200K provider usage above the text heuristic calibrates later real requests',async()=>scenario('usage-calibration',{priceFactor:1.8},async h=>{
  for(let turn=0;turn<48;turn++){
    assert.deepEqual(await send(h,'CURRENT_CALIBRATED_'+turn+' '+'x'.repeat(40000)),[])
    await h.engine.settleBackgroundFold(h.agent);remember(h)
  }
  assert.ok(count(h,'compaction/end')>=3)
  assert.ok(h.main.every(call=>call.inputTokens+call.maxTokens<200000))
  return await checkpoint(h)
}))

test('switching to a smaller model after cancelling in-flight preparation builds a fresh safe request',async()=>scenario('cancel-and-model-switch',{mode:'block'},async h=>{
  history(h)
  const pending=send(h,'CURRENT_BEFORE_MODEL_SWITCH');await until(()=>h.gates.length)
  h.agent.cancel({kind:'user'});await pending
  h.model='main-64000';h.mode='normal'
  for(const gate of h.gates)gate.resolve();await tick();await tick()
  assert.deepEqual(await send(h,'CURRENT_AFTER_MODEL_SWITCH'),[]);await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.main.at(-1).model,'main-64000')
  assert.ok(h.main.at(-1).inputTokens+h.main.at(-1).maxTokens<64000)
  return await checkpoint(h)
}))

test('one 200K conversation continues through ten rounds of alternating route failures and recovery',async()=>scenario('mixed-ten-cycles',{},async h=>{
  const modes=['normal','quota','auth','timeout-ignored','length','both-quota','transport','truncated','rate','normal']
  for(let cycle=0;cycle<modes.length;cycle++){
    h.mode=modes[cycle];h.engine.summaryGuards.clock=()=>Date.now()+cycle*600000
    // Each admitted turn adds 8% input; a whole cycle adds 64%, forcing
    // several replacements without resetting the real agent or archive.
    for(let turn=0;turn<8;turn++){
      const text=`CURRENT_MIXED_${cycle}_${turn} `+'x'.repeat(64000)
      const errors=await send(h,text);await h.engine.settleBackgroundFold(h.agent)
      if(errors.length){h.mode='normal';h.engine.summaryGuards.clock=()=>Date.now()+(cycle+1)*600000;assert.deepEqual(await send(h,'CURRENT_RECOVERY_'+cycle+'_'+turn),[]);await h.engine.settleBackgroundFold(h.agent)}
      remember(h)
    }
    const generation=h.agent.session.surface.replaceGeneration
    for(const gate of h.gates.filter(g=>g.signal.aborted))gate.resolve()
    await tick();await tick();assert.equal(h.agent.session.surface.replaceGeneration,generation)
  }
  assert.ok(count(h,'compaction/end')>=5)
  return await checkpoint(h)
}))

test('200K fixed prompt survives compression; lowering model capacity rebuilds request policy',async()=>scenario('fixed-and-model-switch',{fixed:120000},async h=>{
  history(h,.65)
  assert.deepEqual(await send(h,'CURRENT_FIXED_PROMPT'),[]);await h.engine.settleBackgroundFold(h.agent)
  h.model='main-64000'
  assert.deepEqual(await send(h,'CURRENT_SMALL_MODEL'),[]);await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.main.at(-1).model,'main-64000')
  return await checkpoint(h)
}))

for(const broken of [false,true])test(`200K ${broken?'unfinished committed closure':'ready draft'} survives two real operating-system processes with zero summary repurchase`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-process-restart-')),results=[]
  for(const stage of broken?['prepare-broken-end','resume-broken-end']:['prepare','resume']){
    const result=spawnSync(process.execPath,['--experimental-loader',fileURLToPath(new URL('../scripts/host-loader.mjs',import.meta.url)),fileURLToPath(new URL('./reliability/restart-worker.mjs',import.meta.url)),stage,dir],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{...process.env,SUPERLCM_MATRIX_REPORT:''}})
    assert.equal(result.status,0,result.stderr);results.push(JSON.parse(result.stdout.trim()))
  }
  assert.notEqual(results[0].pid,results[1].pid)
  if(!broken)assert.equal(results[1].summaryCalls,0)
  assert.equal(results[1].mainCalls,1);assert.equal(results[1].compactions,1)
  evidence.push({scenario:'real-process-restart-'+broken,status:'passed',...results[1]})
})

for(const threshold of [.7,.8,.9,.01])test(`200K custom switch ratio ${threshold}`,async()=>scenario('ratio-'+threshold,{fixed:threshold===.01?120000:0,config:automaticRatios(threshold)},async h=>{
  history(h,.92)
  const errors=await send(h,'CURRENT_CUSTOM_RATIO')
  await h.engine.settleBackgroundFold(h.agent)
  if(threshold===.01){assert.ok(errors.length);assert.equal(h.calls.length,0);remember(h);return {explicitSafeRefusal:true,summaryCalls:0,originalEvents:h.originals.size}}
  assert.deepEqual(errors,[]);assert.ok(h.main.length);return await checkpoint(h)
}))

test('a single current input larger than the model window is explicitly refused with originals retained',async()=>scenario('oversized-current',{},async h=>{
  const errors=await send(h,'CURRENT_TOO_LARGE '+'x'.repeat(h.capacity*4*1.1))
  assert.ok(errors.length);assert.equal(h.main.length,0);assert.equal(count(h,'compaction/summary'),0)
  remember(h);assert.ok(h.agent.session.surface.nodes.some(seq=>JSON.stringify(h.agent.session.eventAt(seq).data).includes(h.current)))
  return {explicitSafeRefusal:true,mainCalls:0,summaryCalls:0}
}))

for(const kind of ['ready','end','compaction/summary','replace','cancel'])test('real JSONL cold resume: '+kind,()=>{
  const dir=mkdtempSync(join(tmpdir(),'superlcm-cold-resume-')),results=[]
  for(const phase of ['prepare','resume']){
    const result=spawnSync(process.execPath,['--experimental-loader',fileURLToPath(new URL('../scripts/host-loader.mjs',import.meta.url)),fileURLToPath(new URL('./reliability/cold-worker.mjs',import.meta.url)),phase,dir,kind],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{...process.env,SUPERLCM_MATRIX_REPORT:''}})
    assert.equal(result.status,0,result.stderr);results.push(JSON.parse(result.stdout.trim()))
  }
  assert.notEqual(results[0].pid,results[1].pid)
  assert.equal(results[1].loadedViaSdkResume,true)
  evidence.push({scenario:'sdk-cold-resume-'+kind,status:'passed',...results[1]})
})

test('main rescue uses prior provider usage calibration for dense text',async()=>scenario('rescue-usage-calibration',{priceFactor:1.8},async h=>{
  assert.deepEqual(await send(h,'CURRENT_USAGE_ANCHOR '+'u'.repeat(40000)),[])
  h.mode='both-quota';history(h,.47)
  assert.deepEqual(await send(h,'CURRENT_DENSE_RESCUE'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.calls.filter(c=>c.purpose==='compaction'&&c.model===h.model).length,1)
  return await checkpoint(h)
}))

test('main rescue budgets actual provider image prices and file handle text',async()=>scenario('attachment-budget',{},async h=>{
  assert.deepEqual(await send(h,'CURRENT_ATTACHMENT_POLICY'),[])
  await resolvePolicy(h.engine,h.agent,new AbortController().signal)
  const image={type:'image',attachment:{attachmentId:'f'.repeat(64),mediaType:'image/png',bytes:100,width:100,height:100}}
  const file={type:'file',attachment:{attachmentId:'e'.repeat(64),name:'synthetic.txt',bytes:100}}
  const text={type:'text',text:'x'.repeat(180000*4)}
  const input={messages:[{role:'user',content:[text,image,file]}],tools:[]}
  const baseline=rescueOutputBudget(h.engine,h.agent,input,'Summary only',20000,65536)
  h.imageCost=10000
  const priced=rescueOutputBudget(h.engine,h.agent,input,'Summary only',20000,65536)
  assert.ok(priced<baseline-9000)
  h.imageCost=30000
  assert.throws(()=>rescueOutputBudget(h.engine,h.agent,input,'Summary only',20000,65536),/无法同时容纳/)
  return {providerImageBudget:true,fileHandleText:true,overBudgetRefused:true}
}))

test('persistent closing failure blocks a new turn, then heals without duplicate replacement',async()=>scenario('blocked-boundary-heals',{},async h=>{
  history(h)
  const append=h.agent.session.append.bind(h.agent.session);let broken=true
  h.agent.session.append=(type,...args)=>{if(broken&&type==='compaction/end')throw Error('Isolated sustained close failure');return append(type,...args)}
  await send(h,'CURRENT_BAD_CLOSE');await h.engine.settleBackgroundFold(h.agent)
  const turns=count(h,'turn/start'),replacement=h.agent.session.surface.replaceGeneration
  assert.equal(replacement,1);assert.equal(count(h,'compaction/end'),0)
  assert.ok((await send(h,'CURRENT_BLOCKED_BOUNDARY')).length)
  assert.equal(count(h,'turn/start'),turns)
  broken=false
  h.allowedQueuedInputs=['CURRENT_BLOCKED_BOUNDARY','CURRENT_HEALTHY_BOUNDARY']
  assert.deepEqual(await send(h,'CURRENT_HEALTHY_BOUNDARY'),[])
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.agent.session.surface.replaceGeneration,replacement)
  assert.equal(count(h,'turn/start'),count(h,'turn/end'))
  for(const text of h.allowedQueuedInputs)assert.ok(h.main.some(call=>call.content.includes(text)))
  return await checkpoint(h)
}))

test('seven continuous 200K turns with three truly parallel tools and unfinished background batches',async()=>scenario('continuous-three-tools',{},async h=>{
  h.toolRequest={count:3,characters:100000};h.summaryDelay=15
  for(let turn=0;turn<7;turn++){
    assert.deepEqual(await send(h,'CURRENT_THREE_TOOLS_'+turn),[])
    remember(h)
  }
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.toolRuns.length,21);assert.equal(h.maxParallel,3)
  assert.ok(count(h,'compaction/end')>=3)
  return {...await checkpoint(h),actualToolConcurrency:h.maxParallel}
}))

test('ownership journal write failure preserves ready output before any lifecycle start',async()=>scenario('ownership-write-failure',{config:{auto:false}},async h=>{
  history(h);assert.deepEqual(await send(h,'CURRENT_OWNERSHIP_READY'),[]);await prepare(h)
  const calls=h.calls.length,record=h.engine.superLcmStore.recordCommitOwnership.bind(h.engine.superLcmStore)
  h.engine.superLcmStore.recordCommitOwnership=()=>{throw Error('Isolated ownership journal write failure')}
  assert.equal(h.engine.tryCommitBackgroundFold(h.agent,{force:true}),null)
  assert.equal(count(h,'compaction/start'),0);assert.equal(h.calls.length,calls)
  h.engine.superLcmStore.recordCommitOwnership=record
  assert.ok(h.engine.tryCommitBackgroundFold(h.agent,{force:true}))
  assert.equal(h.calls.length,calls);assert.equal(count(h,'compaction/end'),1)
  return await checkpoint(h)
}))
