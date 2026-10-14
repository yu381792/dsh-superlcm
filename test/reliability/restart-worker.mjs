import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {lab,close,send,history,prepare,snapshot,restoreReady,checkpoint,hash} from './lab.mjs'

const [stage,dir]=process.argv.slice(2)
const file=join(dir,'persisted-session.json')
if(stage==='prepare'||stage==='prepare-broken-end'){
  const h=await lab({dir,config:{auto:stage==='prepare-broken-end'}})
  try{
    history(h)
    if(stage==='prepare-broken-end'){
      const append=h.agent.session.append.bind(h.agent.session)
      h.agent.session.append=(type,...args)=>{if(type==='compaction/end')throw Error('Persistent isolated end write failure');return append(type,...args)}
      await send(h,'CURRENT_BEFORE_PROCESS_RESTART');await h.engine.settleBackgroundFold(h.agent)
      assert.equal(h.agent.session.surface.replaceGeneration,1)
      assert.equal(h.agent.session.snapshotEvents().filter(e=>e.type==='compaction/end').length,0)
    }else{
      assert.deepEqual(await send(h,'CURRENT_BEFORE_PROCESS_RESTART'),[]);await prepare(h)
    }
    const seed=snapshot(h)
    const committed=seed.events.filter(e=>e.type==='compaction/summary').flatMap(e=>e.data.shadowedSeqs||[])
    seed.compressedRawTags=seed.events.filter(e=>committed.includes(e.seq)).flatMap(e=>(e.data?.content||[]).map(b=>b.text?.match(/^Historical decision \d+ /)?.[0]).filter(Boolean))
    seed.previousSummaryHashes=h.calls.filter(c=>c.purpose==='compaction').map(c=>({hash:c.inputHash,cancelled:c.signal.aborted}))
    writeFileSync(file,JSON.stringify(seed)+'\n')
    assert.ok(h.engine.superLcmStore.loadDraft(h.id))
    console.log(JSON.stringify({pid:process.pid,stage,summaryCalls:h.calls.filter(c=>c.purpose==='compaction').length,originalEvents:seed.events.length}))
  }finally{await close(h)}
}else if(stage==='resume'||stage==='resume-broken-end'){
  const seed=JSON.parse(readFileSync(file,'utf8')),h=await lab({dir,seed})
  try{
    if(stage==='resume')assert.ok(await restoreReady(h))
    assert.deepEqual(await send(h,'CURRENT_AFTER_PROCESS_RESTART'),[])
    const summaries=h.calls.filter(c=>c.purpose==='compaction')
    if(stage==='resume')assert.equal(summaries.length,0,'restart must reuse the paid-for ready batch')
    for(const call of summaries){assert.ok(!seed.previousSummaryHashes.some(old=>old.hash===call.inputHash&&!old.cancelled),'completed paid-for summary was purchased again');for(const tag of seed.compressedRawTags)assert.ok(!call.content.includes(tag),'already replaced raw prefix was purchased again')}
    for(const event of seed.events)assert.equal(hash(h.agent.session.eventAt(event.seq)),hash(event))
    console.log(JSON.stringify({pid:process.pid,stage,...await checkpoint(h),readyReused:true}))
  }finally{await close(h)}
}else throw Error('Unknown isolated restart stage')
