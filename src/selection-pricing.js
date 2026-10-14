// DSH's text nodes use a four-characters-per-token heuristic, while pressure
// uses the provider's usage. Calibrate selection budgets against that same
// observed request so a 40K tail does not silently retain 80K+ on Chinese text.
// This is an estimate, not a replacement for the provider's tokenizer.
export function selectionPricing(measurement, header) {
  const anchorSurface = measurement.surfaceTokens - measurement.surfaceDeltaTokens
  const tools = header?.tools?.length ? Math.ceil(JSON.stringify(header.tools).length / 4) + 4 : 0
  const anchorEstimate = anchorSurface + tools
  const factor = measurement.baseline?.kind === 'usage' && anchorEstimate > 0
    ? Math.max(1, measurement.baseline.tokens / anchorEstimate)
    : 1
  return {
    factor,
    activeTokens:Math.max(measurement.totalTokens,Math.ceil((measurement.surfaceTokens+tools)*factor)),
    nodes: measurement.nodes.map(node => ({ ...node, tokens: Math.ceil(node.tokens * factor) })),
  }
}
