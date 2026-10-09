// Read persisted originals directly when available, including incremental cold
// reads. Query-generated interrupted-turn closers must never enter the archive.
export async function readRawDshSession(ctx,id,from=0) {
  const live=ctx.sessions?.get?.(id)
  if(live)return {header:live.header,events:live.snapshotEvents().filter(e=>e.seq>=from),inheritedEventCount:live.inheritedEventCount,close(){}}
  const persistence=ctx.get?.('sessionPersistence')||ctx.sessionPersistence
  if(persistence){
    let handle
    try{handle=await persistence.open(id,'read')}catch(error){
      const sequenceError=(error?.name==='SessionFormatError'||error?.constructor?.name==='SessionFormatError')&&/has seq gap/.test(error.message)
      if((!['SessionFormatUnsupportedError','SessionPersistenceCorruptionError'].includes(error?.name)&&!sequenceError)||!ctx.sessionQuery||!persistence.locate)throw error
      const {readLegacyArchive}=await import('./legacy-archive.js')
      return readLegacyArchive(ctx,persistence,id,from,{recoverSequence:true})
    }
    try{const {events}=await handle.read(from);return {header:handle.header,events,inheritedEventCount:handle.inheritedEventCount,close:()=>handle.close()}}
    catch(error){await handle.close();throw error}
  }
  const observed=await ctx.sessionQuery.observeSession(id,{projectionMode:'none'})
  if(observed.source==='live')return {header:observed.header,events:observed.events.filter(event=>event.seq>=from),inheritedEventCount:observed.inheritedEventCount,close:()=>observed[Symbol.dispose]()}
  observed[Symbol.dispose]()
  throw Error('DSH raw persistence is unavailable; refusing to archive synthetic cold events')
}
