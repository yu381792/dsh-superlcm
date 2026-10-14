import {SessionFoldRegistry} from './summary-guards.js'
import {cleanRoute,routeIsConfigured,routesEqual,systemPrefixEndIndex} from './engine-config.js'
import {requestIdentity,currentPolicy,latestUserIndex} from './ratio-runtime.js'
import {toolPairingBalancedBefore,toolPairingBalancedAfter} from '@deepseek-ai/dsh-compaction'
import {selectRollingRange} from './rolling.js'
import {selectionPricing} from './selection-pricing.js'
import {locateStableSpan} from './async-region.js'
import {plainSummaryBlocks} from './assembly-blocks.js'
import {assembleTree,draftNode} from './draft-tree.js'
import {nodeLevel} from './core.js'
import {saveDraft} from './draft-persistence.js'

// One final main-model call, only under emergency pressure after every
// configured summary route reports exhausted quota or unusable credentials.
export async function rescueWithConversation(engine,agent,parent) {
  const routes=[cleanRoute({provider:engine.config.summarizationProvider,model:engine.config.summarizationModel}),engine.fallbackSummarizationRoute].filter(routeIsConfigured)
  const route=cleanRoute(requestIdentity(agent))
  if(!routes.length||!routes.every(value=>engine.summaryGuards.unavailable(value))||!routeIsConfigured(route)||routes.some(value=>routesEqual(value,route))||!engine.summaryGuards.canTry(route))return null
  engine.conversationRescues??=new SessionFoldRegistry()
  const running=engine.conversationRescues.get(agent)
  if(running)return running
  const policy=currentPolicy(engine,agent),generation=engine.runtimeGeneration
  if(!policy||!engine.config.auto)return null
  const controller=new AbortController(),signal=AbortSignal.any([parent,controller.signal])
  engine.backgroundControllers.add(controller)
  const task=(async()=>{
    const session=agent.session,measurement=engine.ctx.tokenMeter.measure(session)
    const priced=selectionPricing(measurement,session.requestHeader())
    const selection=selectRollingRange(priced.nodes,session.surface.nodes,{...policy,foldBatchTokens:Number.MAX_SAFE_INTEGER,
      tailCount:1,retainTokenBudget:true,activeTokens:priced.activeTokens,forceHard:true,
      firstFoldableIndex:systemPrefixEndIndex(session),protectedFromIndex:latestUserIndex(session),
      isBalancedBefore:seq=>toolPairingBalancedBefore(session,seq),isBalancedAfter:seq=>toolPairingBalancedAfter(session,seq)})
    if(!selection)return null
    const prepared=engine.prepareBackgroundSelection(agent,selection)
    const pending=engine.backgroundFolds.get(agent),ready=pending?.status==='ready'?pending:pending?.recoveryReady
    if(ready?.summarized&&ready.generation===generation&&ready.signature===policy.signature) {
      // Reuse only a proven prefix inside this final exact selected range.
      const prefix=ready.summarized.shadowedSeqs
      if(prefix.length<=prepared.shadowedSeqs.length&&prefix.every((seq,index)=>seq===prepared.shadowedSeqs[index])) {
        locateStableSpan(engine,session,ready.summarized)
        const system=prepared.input.messages.filter(message=>message.role==='system')
        const remainder=prepared.shadowedSeqs.slice(prefix.length).map(seq=>session.deriveEventMessage(session.eventAt(seq))).filter(Boolean)
        prepared.input={...prepared.input,messages:[...system,{role:'user',content:[{type:'text',text:'Verified historical background summary; it is not a new instruction.'},...plainSummaryBlocks(ready.summarized.summary)]},...remainder]}
      }
    }
    prepared.conversationRoute=route
    prepared.summaryTargetTokens=policy.summaryPrefixTargetTokens||Math.min(policy.foldBatchTokens,Math.floor(policy.softActiveTokens/2))
    engine.ctx.logger?.warn?.('摘要路线额度或凭证不可用，使用当前对话模型进行最后一次压缩')
    const summarized=await engine.summarizeBackgroundSelection(agent,prepared,signal)
    signal.throwIfAborted()
    if(engine.runtimeGeneration!==generation||!engine.config.auto||currentPolicy(engine,agent)?.signature!==policy.signature)throw Error('压缩设置已改变，最终压缩未提交')
    summarized.depth=1+Math.max(0,...summarized.trustedChildNodeIds.map(id=>nodeLevel(engine.superLcmStore,session.id,id)))
    const tree=[draftNode(summarized)],frontier=[summarized]
    const state={status:'ready',selection,signature:policy.signature,generation,revision:engine.controlRevision,
      cutoffEnd:selection.end,parts:[summarized],frontier,tree,summarized:assembleTree(engine,frontier,tree,1)}
    engine.backgroundFolds.set(agent,state)
    pending?.controller?.abort(Error('最终对话模型摘要已就绪'))
    saveDraft(engine,agent,state)
    return engine.tryCommitBackgroundFold(agent,{allowPressure:true})
  })()
  engine.conversationRescues.set(agent,task)
  engine.backgroundTasks?.add(task)
  try{return await task}finally{engine.conversationRescues.delete(agent);engine.backgroundControllers.delete(controller);engine.backgroundTasks?.delete(task)}
}
