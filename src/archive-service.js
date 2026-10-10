import {randomUUID} from 'node:crypto'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {ArchiveDatabase,sessionId} from './archive-db.js'
import {readRawDshSession} from './raw-session.js'
import {archiveWork} from './archive-planner.js'
import {SUMMARY_SYSTEM,summaryPromptParts,joinSummaryPrompt,withSummaryRetry,checkedSummary} from './summary-policy.js'
import {readSettings} from './settings.js'
import {summarySessionId,completeSummaryStream} from './summary-session.js'
import {reindexSession,nodeLevel} from './core.js'
import {semanticKind,semanticFrontier} from './tree-semantics.js'
import {archiveDiagnostic} from './archive-diagnostic.js'
export class ArchiveService {
  constructor(ctx,native,file) {
    this.ctx=ctx;this.native=native;this.file=file;this.db=new ArchiveDatabase(native.path);this.dirty=new Set();this.jobs=new Set();this.stopped=false;this.controllers=new Set();this.failures=new Map()
    this.onEvent=(session,event)=>{this.dirty.add(session.id);if(event?.type==='turn/end')this.jobs.add(session.id);void this.drain()}
    ctx.on('session/event',this.onEvent)
    ctx.on('ready',()=>{void this.import()})
    this.registerTools()
    ctx.effect(()=>()=>this.close())
  }
  get lastDiagnostic(){return [...this.failures.values()].at(-1)}
  get lastError(){return this.lastDiagnostic?.message}
  failed(error,session,stage){const diagnostic=archiveDiagnostic(error,{session,stage}),key=`${session}:${stage}`;this.failures.delete(key);this.failures.set(key,diagnostic);this.ctx.logger?.warn?.(diagnostic.message)}
  recovered(session,stage){this.failures.delete(`${session}:${stage}`)}
  async capture(id) {
    const live=this.ctx.sessions.get(id),cursor=this.db.cursor(id),incremental=cursor>0
    const raw=live&&incremental?{header:live.header,events:Array.from({length:Math.max(0,live.seq-cursor)},(_,i)=>live.eventAt(cursor+i)),close(){}}:await readRawDshSession(this.ctx,id,cursor)
    try{
      if(this.db.legacySource(id)&&!raw.legacy)throw Error('旧会话格式已变化，拒绝混合归档')
      if(raw.legacySource)this.jobs.delete(id)
      if(raw.recovery){this.db.captureRecovered(raw.header,raw.recovery,raw.legacySource);return}
      if(this.db.recovery(id))throw Error('旧会话格式已变化，拒绝混合归档')
      const legacy=raw.legacySource?{legacySource:raw.legacySource,legacyEvents:raw.legacyEvents}:undefined
      for(let i=0;i<raw.events.length;i+=500){if(this.stopped)return;this.db.capture(raw.header,raw.events.slice(i,i+500),i===0?legacy:undefined);await new Promise(r=>setImmediate(r))}
      if(!raw.events.length)this.db.capture(raw.header,[],legacy)
      if(!raw.legacy&&!this.db.legacySource(id)&&(!incremental||raw.events.some(e=>e.type==='compaction/end'))){
        const full=incremental&&!live?await readRawDshSession(this.ctx,id):null
        try{reindexSession(this.native,{id,header:raw.header,snapshotEvents:()=>full?.events||(incremental?live.snapshotEvents():raw.events)})}finally{await full?.close()}
      }
    }finally{await raw.close()}
  }
  async import(){if(this.importing)return {scheduled:true};this.importing=true
    try{for(const {header} of await this.ctx.sessionQuery.listSessions())this.dirty.add(header.id);this.recovered('@history','capture');void this.drain()}catch(error){this.failed(error,'@history','capture')}finally{this.importing=false}
    return {scheduled:true}
  }
  schedule(id){sessionId(id);if(!readSettings(this.file).settings.summaryEnabled)throw Error('请先开启后台摘要并选择模型');this.dirty.add(id);this.jobs.add(id);void this.drain();return {scheduled:true}}
  changed(){for(const controller of this.controllers)controller.abort(Error('摘要设置已变化'))}
  async drain(){if(this.running||this.stopped)return this.running
    this.running=(async()=>{while(this.dirty.size&&!this.stopped){const id=this.dirty.values().next().value;this.dirty.delete(id)
      let stage='capture'
      try{await this.capture(id);this.recovered(id,'capture');if(this.dirty.has(id))continue;if(this.jobs.delete(id)){stage='summary';const result=await this.summarize(id);if(result==='complete')this.recovered(id,'summary')}}catch(error){this.failed(error,id,stage)}
    }})().finally(()=>{this.running=null;if(this.dirty.size&&!this.stopped)void this.drain()});return this.running
  }
  async summarize(id){const doc=readSettings(this.file);if(!doc.settings.summaryEnabled)return 'disabled'
    // Historical decoder output is exact recall data, not current-format input
    // for summary generation or native compaction checkpoint reconstruction.
    if(this.db.legacySource(id))return 'legacy'
    const owner=this.db.lease(id,doc.revision);if(!owner)return 'busy'
    const controller=new AbortController();this.controllers.add(controller);let failed=false
    const heartbeat=setInterval(()=>{try{if(!this.db.renew(id,owner))controller.abort(Error('摘要任务已失去归属'));if(readSettings(this.file).revision!==doc.revision)controller.abort(Error('摘要设置已变化'))}catch{controller.abort(Error('摘要设置不可用'))}},10000);heartbeat.unref()
    try{for(let work;(work=archiveWork(this.db,id,doc.settings));){controller.signal.throwIfAborted();if(readSettings(this.file).revision!==doc.revision)return 'cancelled'
      const timeout=AbortSignal.timeout(180000),signal=AbortSignal.any([controller.signal,timeout]),route={provider:doc.settings.summaryProvider,model:doc.settings.summaryModel}
      let text
      for(let attempt=0;attempt<2;attempt++) {
        let draft='',reason=null
        const task={...work,kind:work.level?'condensed':'leaf'}
        const parts=summaryPromptParts(work.content,task),prompt=joinSummaryPrompt(attempt?withSummaryRetry(parts,'The previous reply failed the summary language or heading check. Follow the required language and heading; summarize only.'):parts)
        for await(const chunk of completeSummaryStream(this.ctx.llm.stream({...route,sessionId:summarySessionId(id,route),purpose:'compaction',maxTokens:2048,signal,messages:[{role:'system',content:[{type:'text',text:SUMMARY_SYSTEM}]},{role:'user',content:[{type:'text',text:prompt}]}]}),signal)){
          signal.throwIfAborted();if(chunk.type==='text-delta')draft+=chunk.text
          if(chunk.type==='finish'){reason=chunk.reason;if(['error','aborted'].includes(reason?.kind))throw Error('摘要模型失败')}
        }
        signal.throwIfAborted();if(!reason)throw Error('摘要模型未正常结束')
        try{text=checkedSummary(draft,{...work,finishReason:reason});break}catch(error){if(!error.summaryQuality||attempt)throw error}
      }
      this.db.saveNode(id,work,text,owner,doc.revision,()=>readSettings(this.file).revision)
      await new Promise(r=>setImmediate(r))
    }}catch(error){
      if(controller.signal.aborted&&(this.stopped||readSettings(this.file).revision!==doc.revision))return 'cancelled'
      failed=true;throw error
    }finally{clearInterval(heartbeat);this.controllers.delete(controller);this.db.release(id,owner,failed)}
    return 'complete'
  }
  sessions(input){
    const value=this.db.sessions(input)
    return {...value,items:value.items.map(item=>({...item,summaryCount:this.db.recovery(item.id)?0:item.summaryCount+this.native.listNodes(item.id,{limit:5000,status:'ready'}).filter(n=>semanticKind(this.native,item.id,n.nodeId)!=='assembled').length}))}
  }
  outline(id){
    const recovery=this.db.recovery(id)
    if(recovery){const total=this.db.db.prepare('SELECT COUNT(*) count FROM sl_recovered_events WHERE session=? AND original=1').get(sessionId(id)).count
      return {session:id,title:this.db.outline(id).title,nodes:[],total,uncovered:total,recovery,sequenceMode:'physical-order',notice:'旧日志编号重叠或乱序，全部原始记录按文件顺序归档。读取位置是归档顺序号，sourceSeq 是原始编号。此会话仅供原文检索。'}
    }
    const value=this.db.outline(id),native=this.native.listNodes(id,{limit:5000,status:'ready'})
    const original=new Set(this.db.sourceRows(id).map(e=>e.seq)),memo=new Map()
    const sources=(key,seen=new Set())=>{
      if(seen.has(key))throw Error('摘要树存在循环')
      if(memo.has(key))return memo.get(key)
      const node=this.native.getNode(id,key);if(!node)throw Error('摘要树缺少子节点')
      const next=new Set([...seen,key]),seqs=[...new Set([...node.sourceSeqs,...node.childIds.flatMap(child=>sources(child,next))])].filter(seq=>original.has(seq)).sort((a,b)=>a-b)
      memo.set(key,seqs);return seqs
    }
    const nodes=native.filter(n=>semanticKind(this.native,id,n.nodeId)!=='assembled').map(n=>{
      const seqs=sources(n.nodeId)
      return {id:'native:'+n.nodeId,level:nodeLevel(this.native,id,n.nodeId)-1,first:seqs[0]??n.sourceStart??0,last:seqs.at(-1)??n.sourceEnd??0,summary:n.summaryText,children:n.childIds.flatMap(x=>semanticFrontier(this.native,id,x)).map(x=>'native:'+x),sources:seqs,native:true}
    })
    const covered=new Set([...value.nodes,...nodes].flatMap(n=>n.sources))
    return {...value,nodes:[...value.nodes,...nodes],uncovered:this.db.sourceRows(id).filter(e=>!covered.has(e.seq)).length}
  }
  registerTools(){const json={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},resolve=(args,exec)=>args.session||exec?.agent?.session?.id
    const specs=[['lcm_outline','查看 DSH 会话的后台摘要目录；摘要用于导航，精确结论请查原文。',{session:{type:'string'}},(a,e)=>this.outline(resolve(a,e))],
      ['lcm_read','读取 DSH 完整原文。编号损坏的旧日志按归档顺序分页，并返回原始编号 sourceSeq 和文件行号 sourceRow。',{session:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},(a,e)=>this.db.events(resolve(a,e),a.offset,a.limit)],
      ['lcm_find','搜索已归档的 DSH 会话原文。',{session:{type:'string'},query:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},a=>this.db.find(a)]]
    for(const [name,description,parameters,run] of specs)this.ctx.tools.register(defineTool({name,description,parameters,output:json,execute:async(args,exec)=>{await this.drain();return run(args,exec)},presentCall:args=>({card:'generic',title:name,kind:'read',rawInput:args})}))
  }
  async close(){if(this.closing)return this.closing;this.stopped=true;this.changed();this.closing=(async()=>{await this.running;this.db.close()})();return this.closing}
}
