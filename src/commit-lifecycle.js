import {isDeepStrictEqual} from 'node:util'
import {symbols} from '@deepseek-ai/cordis'
import {interruptedCompactionRecords} from './core.js'
import {markerFromSummary} from './marker.js'

const guarded = new WeakMap()
const backends = new WeakMap()
const unfinished = session => {
  let start
  for(const event of session.snapshotEvents()) {
    if(event.type==='session/end-seed'||event.type==='compaction/end')start=undefined
    else if(event.type==='compaction/start')start=event
  }
  return start
}
const proven = (session,start) => interruptedCompactionRecords(session)
  .find(record=>record.start.seq===start.seq&&markerFromSummary(record.summary.data.summary))

// The SDK attempts turn/end even after a request error. Close our unfinished
// commit first; a valid open tail is recoverable, a crossed turn boundary isn't.
export function guardCommitLifecycle(session,lifecycle) {
  let state=guarded.get(session)
  if(!state) {
    const append=session.append
    state={ids:new Set(),deferred:null,append,cursor:0,open:undefined}
    state.pending=()=>{
      while(state.cursor<session.seq){
        const event=session.eventAt(state.cursor++)
        if(event.type==='session/end-seed'||event.type==='compaction/end'){if(state.open)state.ids.delete(state.open.data.compactionId);state.open=undefined}
        else if(event.type==='compaction/start')state.open=event
      }
      return state.open
    }
    session.append=function(type,data,...options) {
      if(type==='turn/start'||type==='turn/end') {
        const start=state.pending()
        if(start&&state.ids.has(start.data.compactionId)) {
          if(type==='turn/end')state.deferred={data,options}
          session.append('compaction/end',{
            ...start.data,...(proven(session,start)?{}:{error:'SuperLcm commit interrupted before replacement'}),
          })
        }
        if(state.deferred) {
          const pending=state.deferred
          append.call(session,'turn/end',pending.data,...pending.options)
          state.deferred=null
          if(type==='turn/end')return session.eventAt(session.seq-1)
        }
      }
      return append.call(session,type,data,...options)
    }
    guarded.set(session,state)
  }
  state.ids.add(lifecycle.compactionId)
}

// Use only the backend's owned write handle, before the SDK appends its turn
// closers. Append exact lifecycle proof; never edit events or mutate read opens.
export function registerCommitRecovery(engine) {
  const installed=new Set()
  const attach=value=> {
    const backend=value?.[symbols.original]??value
    if(!backend||installed.has(backend))return
    installed.add(backend)
    let entry=backends.get(backend)
    if(!entry) {
      const open=backend.open
      entry={engines:new Set(),open,wrapped:null}
      entry.wrapped=async function(id,access,options) {
        const handle=await open.call(this,id,access,options)
        if(access!=='write')return handle
        try {
          const loaded=await handle.read(0,undefined,options)
          const events=loaded.events,start=unfinished({snapshotEvents:()=>events})
          if(!start)return handle
          const session={seq:events.length,snapshotEvents:()=>events}
          const completed=!!proven(session,start)
          let owned=completed
          if(!owned)for(const owner of entry.engines) {
            const claim=owner.superLcmStore.commitOwnership(id,start.data.compactionId,start.seq)
            if(claim&&isDeepStrictEqual(claim,start.data)){owned=true;break}
            // Preserve compatibility with incomplete drafts created before
            // ownership gained its own append-only journal.
            const draft=owner.superLcmStore.loadDraft(id)
            if(draft&&JSON.parse(draft.data).summarized?.compactionId===start.data.compactionId){owned=true;break}
          }
          if(!owned)return handle
          options?.signal?.throwIfAborted()
          await handle.append([{type:'compaction/end',seq:events.length,time:Date.now(),
            data:{...start.data,...(completed?{}:{error:'SuperLcm commit interrupted before replacement'})}}],options)
          await handle.flush(options)
          return handle
        }catch(error){await handle.close().catch(()=>{});throw error}
      }
      backend.open=entry.wrapped
      backends.set(backend,entry)
    }
    entry.engines.add(engine)
  }
  attach(engine.ctx.get?.('sessionPersistence'))
  engine.ctx.on('internal/service',(name,backend)=>{if(name==='sessionPersistence')attach(backend)})
  engine.ctx.effect(()=>()=>{
    for(const backend of installed){
      const entry=backends.get(backend)
      entry?.engines.delete(engine)
      if(entry&&entry.engines.size===0){if(backend.open===entry.wrapped)backend.open=entry.open;backends.delete(backend)}
    }
  })
}
