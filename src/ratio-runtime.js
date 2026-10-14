import { createHash } from 'node:crypto'
import { deriveRatioPolicy } from './ratio-policy.js'
import { selectionPricing } from './selection-pricing.js'
import { SessionFoldRegistry } from './summary-guards.js'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { abortable } from './summary-attempt.js'
import {compactionBusy} from './async-region.js'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function requestIdentity(agent) {
  const header = agent.session.requestHeader(), config = header?.config ?? {}
  return { provider: config.provider ?? agent.options.provider, model: config.model ?? agent.options.model,
    maxTokens: config.maxTokens, tools: header?.tools ?? [],
    system: agent.session.surface.nodes.map(seq => agent.session.eventAt(seq)).find(e => e.type === 'system/message')?.data }
}
export function currentPolicy(engine, agent) {
  if (engine.rollingConfig.budgetMode !== 'ratio') return engine.rollingConfig
  const policy = engine.resolvedPolicies?.get(agent)
  return policy?.generation === engine.runtimeGeneration && policy.headerFingerprint === hash(requestIdentity(agent)) ? policy : null
}
export async function resolvePolicy(engine, agent, signal) {
  if (engine.rollingConfig.budgetMode !== 'ratio') return engine.rollingConfig
  engine.resolvedPolicies ??= new SessionFoldRegistry()
  const identity = requestIdentity(agent), headerFingerprint = hash(identity)
  const generation = engine.runtimeGeneration
  // A real host request has already bound an adapter. Its logged context
  // wins over subsequently edited provider metadata for this exact dispatch.
  const bound=agent.session.requestContext?.()
  const boundMatches=bound?.provider===identity.provider && bound.model===identity.model && bound.contextWindow!==undefined
  const info=boundMatches ? {context:{contextWindow:bound.contextWindow},defaultMaxTokens:0}
    : await engine.ctx.llm.resolveModelInfo(identity.provider, identity.model, signal)
  signal?.throwIfAborted()
  if (headerFingerprint !== hash(requestIdentity(agent)) || generation !== engine.runtimeGeneration) throw Error('聊天模型正在切换，请重试当前请求')
  const measurement = engine.ctx.tokenMeter.measure(agent.session)
  const priced = selectionPricing(measurement, agent.session.requestHeader())
  const fixedTokens = priced.nodes.filter(n => agent.session.eventAt(n.seq).type === 'system/message').reduce((sum,n) => sum+n.tokens,0)
    + Math.ceil((identity.tools.length ? JSON.stringify(identity.tools).length / 4 + 4 : 0) * priced.factor)
  const policy = deriveRatioPolicy(engine.rollingConfig, { contextWindow: info.context?.contextWindow,
    reservedCompletionTokens: identity.maxTokens ?? info.defaultMaxTokens ?? 0, fixedTokens, headerFingerprint,
    signature: hash([headerFingerprint, info.context?.contextWindow, identity.maxTokens ?? info.defaultMaxTokens ?? 0, engine.rollingConfig, engine.summaryRouteFingerprint()]) })
  policy.generation = generation
  const previous = engine.resolvedPolicies.get(agent)
  if (previous && previous.signature !== policy.signature) {
    engine.backgroundFolds.get(agent)?.controller?.abort(Error('聊天模型容量或压缩策略已改变'))
    engine.backgroundFolds.delete(agent)
  }
  engine.resolvedPolicies.set(agent, policy)
  return policy
}
export function latestUserIndex(session) {
  const realUser = event => event.type === 'user/message'
    && (!event.data?.source || !isCompactCheckpointSource(event.data.source))
    && event.data?.source?.kind !== 'runtime-context'
    && !event.data?.content?.every(block => block.type === 'tool-result')
  let index = session.surface.nodes.length
  for (let i=index-1;i>=0;i--) if(realUser(session.eventAt(session.surface.nodes[i]))) {index=i;break}
  if(index===session.surface.nodes.length)return index
  // A turn can contain multiple admitted user messages plus automatic context.
  // Protect its first real input, not the newest automatic snapshot.
  let turnStart=-1
  for(let seq=session.surface.nodes[index];seq>=0;seq--) if(session.eventAt(seq).type==='turn/start'){turnStart=seq;break}
  if(turnStart>=0) for(let i=index-1;i>=0&&session.surface.nodes[i]>turnStart;i--) if(realUser(session.eventAt(session.surface.nodes[i])))index=i
  return index
}
export function activeInputTokens(engine,agent) {
  const measurement=engine.ctx.tokenMeter.measure(agent.session)
  return engine.rollingConfig.budgetMode==='ratio'?selectionPricing(measurement,agent.session.requestHeader()).activeTokens:measurement.totalTokens
}
export async function pressureStep(engine, agent, signal) {
  const policy = await resolvePolicy(engine, agent, signal)
  engine.bindBackgroundCancellation?.(agent,signal)
  engine.restoreDraft?.(agent)
  engine.tryCommitBackgroundFold(agent, { allowPressure: true })
  if(compactionBusy(agent.session))throw Error('压缩结束记录尚未写入，当前请求已保留，请稍后重试。')
  if (engine.canPrepareBackground(agent)) {
    const selection = engine.planRolling(agent)
    if (selection) engine.startBackgroundFold(agent, selection)
  }
  if (policy.budgetMode !== 'ratio' || activeInputTokens(engine,agent) < policy.hardActiveTokens) return
  // Wait for progress, not the whole frozen multi-batch job. At each completed
  // batch a verified prefix may already release safe headroom. One total
  // deadline covers all batches; later batches do not reset it.
  const deadline = new AbortController()
  const waiting = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(Error('后台摘要尚未就绪，请稍后重试。当前请求已保留。')), policy.summaryTimeoutMs)
  try {
    for (;;) {
      waiting.throwIfAborted()
      engine.tryCommitBackgroundFold(agent, {allowPressure:true})
      if (activeInputTokens(engine,agent) < policy.hardActiveTokens) break
      const pending = engine.backgroundFolds.get(agent)
      if (!['summarizing','cancelling'].includes(pending?.status) || !pending.promise) break
      await abortable(pending.promise, waiting)
    }
  } finally { clearTimeout(timer) }
  engine.tryCommitBackgroundFold(agent, {allowPressure:true})
  if(activeInputTokens(engine,agent)>=policy.hardActiveTokens)await engine.rescueWithConversation?.(agent,signal)
  if (activeInputTokens(engine,agent) >= policy.hardActiveTokens) throw Error('当前轮原文或后台摘要仍占用过多空间，请等待摘要就绪或缩短本轮输入。当前请求已保留。')
}
