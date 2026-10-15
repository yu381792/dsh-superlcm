import { saveDraft } from './draft-persistence.js'

// An uncompressible final fragment stays verbatim. It must not strand a
// previously completed prefix, nor pretend that the fragment was summarized.
export function retainUncompressibleTail(engine, agent, state, recovered, error, policy) {
  if (error?.code !== 'SUPERLCM_SUMMARY_NO_PROGRESS' || state.controller.signal.aborted
    || state.selection.treeOnly || recovered?.status !== 'ready' || !recovered.parts?.length
    || recovered.generation !== engine.runtimeGeneration || recovered.signature !== policy.signature
    || state.cutoffEnd === undefined || state.selection.end !== state.cutoffEnd
    || !Number.isFinite(state.selection.foldTokens) || state.selection.foldTokens <= 0
    || state.selection.foldTokens >= policy.foldBatchTokens) return null
  const nodes = agent.session.surface.nodes
  const end = nodes.indexOf(recovered.summarized.end)
  const start = nodes.indexOf(state.selection.start)
  const tailEnd = nodes.indexOf(state.selection.end)
  // A merge failure can have a newer recovery draft including this leaf.
  // Only the older, adjacent completed prefix qualifies for narrowing.
  if (end < 0 || start !== end + 1 || tailEnd < start) return null
  const ready = { ...recovered, cutoffEnd: recovered.summarized.end }
  try { saveDraft(engine, agent, ready) }
  catch { engine.ctx.logger?.warn?.('保留尾段原文的摘要范围暂未保存，将在提交前重试') }
  engine.ctx.logger?.info?.(`最终小批摘要无法节省空间，保留原文 #${state.selection.start}–#${state.selection.end}，提交范围截至 #${ready.cutoffEnd}`)
  return ready
}
