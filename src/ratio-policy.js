// Ratios describe the current routed request's INPUT capacity, after its
// output reservation. Fixed prompt/tool costs still count as active input.
export const RATIO_DEFAULTS = Object.freeze({prepareRatio:0.7,switchRatio:0.8,emergencyRatio:0.9})
// One user-facing replacement threshold; the other phases are internal.
export function automaticRatios(switchRatio) {
  if(!Number.isFinite(switchRatio)||switchRatio<.01||switchRatio>.99)throw Error('压缩比例必须在 1% 到 99% 之间')
  const round=value=>Math.round(value*1e12)/1e12
  return {prepareRatio:round(switchRatio-Math.min(.1,switchRatio/2)),switchRatio,
    emergencyRatio:round(switchRatio+Math.min(.1,(1-switchRatio)/2))}
}
export function ratioOptions(raw = {}) {
  const out = {}
  for (const [key, fallback] of Object.entries(RATIO_DEFAULTS)) {
    const value = raw[key] ?? fallback
    if (!Number.isFinite(value) || value <= 0 || value >= 1) throw Error('压缩比例必须在 0 与 1 之间：' + key)
    out[key] = value
  }
  if (!(out.prepareRatio < out.switchRatio && out.switchRatio < out.emergencyRatio)) throw Error('压缩比例必须按准备、替换、紧急顺序递增')
  return out
}
export function deriveRatioPolicy(base, {contextWindow,reservedCompletionTokens=0,fixedTokens=0,signature,headerFingerprint} = {}) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) throw Error('当前聊天模型缺少有效上下文容量或输出预算')
  if (!Number.isSafeInteger(fixedTokens) || fixedTokens < 0 || !Number.isSafeInteger(base.foldBatchTokens) || base.foldBatchTokens < 1) throw Error('摘要粒度和固定上下文预算无效')
  const inputBudget = contextWindow - reservedCompletionTokens
  if (inputBudget < 1024) throw Error('当前聊天模型没有足够输入空间进行后台压缩')
  const ratios = ratioOptions(base)
  const prepareActiveTokens = Math.floor(inputBudget * ratios.prepareRatio)
  const softActiveTokens = Math.floor(inputBudget * ratios.switchRatio)
  const hardActiveTokens = Math.floor(inputBudget * ratios.emergencyRatio)
  const minRetainTokens = Math.min(Math.floor(inputBudget * 0.2), Math.floor(softActiveTokens * 0.15), Math.max(2048, Math.min(65536, Math.floor(inputBudget * 0.04))))
  // Fixed prompts/tools cannot be compressed. Add them to the normal summary
  // and recent-original budgets instead of squeezing the summary into the
  // last 1K of an otherwise impossible 10% post-compaction target.
  const desiredSummaryTokens = Math.max(256, Math.floor(Math.min(inputBudget * 0.06, softActiveTokens * 0.5)))
  const postTargetTokens = Math.min(softActiveTokens - 1, Math.max(Math.floor(Math.min(inputBudget * 0.1,softActiveTokens * 0.5)), fixedTokens + minRetainTokens + desiredSummaryTokens))
  const summaryPrefixTargetTokens = Math.min(desiredSummaryTokens, postTargetTokens - fixedTokens - minRetainTokens)
  const foldBatchTokens = Math.max(256, Math.min(base.foldBatchTokens, Math.floor((softActiveTokens - fixedTokens - minRetainTokens) / 2)))
  if (summaryPrefixTargetTokens < 256 || fixedTokens + minRetainTokens + summaryPrefixTargetTokens >= hardActiveTokens || foldBatchTokens < 512) throw Error('当前压缩比例过低或系统工具占用过多，无法容纳摘要和近期原文，请提高比例或减少固定占用')
  return {...base,...ratios,inputBudget,contextWindow,reservedCompletionTokens,signature,headerFingerprint,
    prepareActiveTokens,softActiveTokens,hardActiveTokens,minRetainTokens,postTargetTokens,
    summaryPrefixTargetTokens,foldBatchTokens,pressureFoldTokens:foldBatchTokens,protectLatestUser:true,
    summaryLeafTargetTokens:Math.max(256,Math.min(2400,Math.floor(summaryPrefixTargetTokens/4))),
    condensedMinSourceTokens:Math.max(512,Math.min(2000,Math.floor(foldBatchTokens*0.1))),
    routineMaxDepth:1}
}
