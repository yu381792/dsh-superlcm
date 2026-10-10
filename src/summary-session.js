import { createHash } from 'node:crypto'

export function summarySessionId(sessionId, route) {
  return 'superlcm-summary-' + createHash('sha256')
    .update(JSON.stringify([sessionId, route?.provider ?? '', route?.model ?? '']))
    .digest('hex').slice(0, 32)
}

// DSH's BlockAssembler defaults to stop even if the wire closes without finish.
// Require the actual terminal event before any summary may replace or be stored.
export async function* completeSummaryStream(stream, signal) {
  let finished = false
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    if (finished || chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') {
      throw new Error('Summary generation was incomplete; unexpected summary stream output, original content retained')
    }
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') throw new Error('Summary generation was incomplete; original content retained')
      finished = true
    }
    yield chunk
  }
  signal?.throwIfAborted()
  if (!finished) throw new Error('Summary generation was incomplete; missing terminal finish, original content retained')
}

// Only the auxiliary wire identity changes. Original Session methods, content,
// events, and recall ownership stay on the real conversation.
export function summaryCallContext(ctx, sessionId, route, { input, directive } = {}) {
  const llm = ctx.llm
  const wire = Object.create(llm)
  Object.defineProperty(wire, 'stream', { value: async function* (options) {
    let messages = options.messages
    if (directive) {
      // The host must append exactly one compaction directive after our input.
      // Keep the replayed prefix byte-for-byte; never append two competing policies.
      if (options.purpose !== 'compaction' || !Array.isArray(messages)
        || messages.length !== input.messages.length + 1
        || !input.messages.every((message, index) => messages[index] === message)
        || messages.at(-1)?.role !== 'user') {
        throw new Error('Unsupported host summarization envelope; refusing to rewrite conversation input')
      }
      messages = [...input.messages, { role:'user', content:[{type:'text',text:directive}] }]
    }
    for await (const chunk of completeSummaryStream(llm.stream({ ...options, messages, sessionId:summarySessionId(sessionId,route) }), options.signal)) {
      yield chunk
    }
  } })
  const context = Object.create(ctx)
  Object.defineProperty(context, 'llm', { value: wire })
  return context
}
