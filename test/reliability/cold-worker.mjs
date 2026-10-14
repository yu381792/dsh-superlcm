import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {reindexSession,doctorSession} from '../../src/core.js'
import {lab,close,send,remember,snapshot,restoreReady,checkpoint,count,hash} from './lab.mjs'

const [phase,dir,kind='end']=process.argv.slice(2),file=join(dir,'cold-manifest.json')
if(phase==='prepare'){
  const h=await lab({dir,persistent:true});h.summaryDelay=30
  try{
    assert.deepEqual(await send(h,'CURRENT_WARM'),[])
    if(kind==='ready'){
      assert.deepEqual(await send(h,'CURRENT_EARLIER '+'e'.repeat(300000)),[])
      assert.deepEqual(await send(h,'CURRENT_READY'),[])
      await h.engine.settleBackgroundFold(h.agent)
      assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready')
    }else{
      h.toolRequest={count:2,characters:130000}
      for(let i=0;i<2;i++)assert.deepEqual(await send(h,'CURRENT_TOOLS_'+i),[])
      h.beforeModel=async(options)=>{
        if(options.purpose==='compaction'&&h.calls.filter(c=>c.purpose==='compaction').length>1)
          await new Promise(resolve=>h.gates.push({resolve,signal:options.signal}))
      }
      const append=h.agent.session.append.bind(h.agent.session);let injected=false
      h.agent.session.append=(type,...args)=>{
        if(type==='compaction/end'){h.endFailures=(h.endFailures||0)+1;throw Error('Persistent isolated end write failure')}
        if(kind!=='end'&&!injected&&(type===kind||kind==='cancel'&&type==='compaction/summary'||kind==='replace'&&type==='user/message'&&args[1]?.surfaceOp?.op==='replace')){injected=true;if(kind==='cancel')h.agent.cancel({kind:'user'});throw Error('Isolated '+kind+' failure')}
        return append(type,...args)
      }
      await send(h,'CURRENT_UNFINISHED_CLOSURE')
      assert.equal(count(h,'compaction/end'),0)
      assert.ok(h.endFailures>0)
      assert.equal(h.agent.session.surface.replaceGeneration,kind==='end'?1:0)
      // Failed closure must not admit another turn or write a crossed boundary.
      const turns=count(h,'turn/start')
      await send(h,'CURRENT_BLOCKED_NEW_TURN')
      assert.equal(count(h,'turn/start'),turns)
      if(kind!=='end')assert.equal(injected,true)
      const open=h.agent.session.snapshotEvents().findLast(event=>event.type==='compaction/start')
      assert.deepEqual(h.engine.superLcmStore.commitOwnership(h.id,open.data.compactionId,open.seq),open.data)
      if(kind==='cancel')assert.equal(h.engine.superLcmStore.loadDraft(h.id),null,'cancelled ready draft must stay invalid')
    }
    remember(h)
    await h.ctx.sessionPersistence.flush()
    const manifest={pid:process.pid,events:snapshot(h).events,// Explicit cancellation invalidates the draft; only still-authorized outputs
    // have a zero-repurchase requirement on the next request.
    summaryHashes:kind==='cancel'?[]:h.calls.filter(c=>c.purpose==='compaction'&&c.finished&&!c.signal.aborted).map(c=>c.inputHash),cancelledHashes:kind==='cancel'?h.calls.filter(c=>c.purpose==='compaction'&&c.finished).map(c=>c.inputHash):[],kind,endFailures:h.endFailures||0}
    writeFileSync(file,JSON.stringify(manifest)+'\n')
    console.log(JSON.stringify({pid:process.pid,kind,endFailures:manifest.endFailures,replace:h.agent.session.surface.replaceGeneration,naturalTools:h.toolRuns.length}))
  }finally{await close(h)}
}else{
  const manifest=JSON.parse(readFileSync(file)),h=await lab({dir,persistent:true,resume:true})
  try{
    assert.notEqual(process.pid,manifest.pid)
    for(const event of manifest.events)assert.equal(hash(h.agent.session.eventAt(event.seq)),hash(event))
    assert.equal(h.calls.length,0,'cold lifecycle repair must not invoke a model')
    if(kind!=='ready'){
      const start=manifest.events.findLast(event=>event.type==='compaction/start')
      const end=h.agent.session.snapshotEvents().find(event=>event.seq>=manifest.events.length&&event.type==='compaction/end'&&event.data.compactionId===start.data.compactionId)
      assert.ok(end,'cold resume must close the old lifecycle before adding a turn boundary')
      assert.equal(!!end.data.error,kind!=='end')
    }
    assert.deepEqual(reindexSession(h.engine.superLcmStore,h.agent.session).errors,[])
    assert.equal(doctorSession(h.engine.superLcmStore,h.agent.session).ok,true,'cold reader left an unfinished compaction')
    if(kind==='ready')assert.ok(await restoreReady(h))
    h.current=kind==='ready'?'CURRENT_REAL_COLD_READY '+'c'.repeat(500000):'CURRENT_REAL_COLD_RECOVERY'
    assert.deepEqual(await send(h,h.current),[])
    await h.engine.settleBackgroundFold(h.agent)
    assert.ok(!h.calls.some(c=>c.purpose==='compaction'&&manifest.summaryHashes.includes(c.inputHash)),'completed source repurchased on cold resume')
    const result=await checkpoint(h)
    console.log(JSON.stringify({pid:process.pid,loadedViaSdkResume:true,...result,validCompletedSourceRepurchase:false,cancelledDraftRecomputed:h.calls.some(c=>c.purpose==='compaction'&&manifest.cancelledHashes.includes(c.inputHash)),originalsExact:true}))
  }finally{await close(h)}
}
