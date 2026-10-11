import { createHash } from 'node:crypto'
import {abortable} from './summary-attempt.js'
const routeFailureCodes = new Map([
  ...['AUTH','QUOTA','RATE_LIMIT','TIMEOUT','TRANSPORT','CONTEXT_WINDOW_EXCEEDED'].map(code=>[code,code]),
  ['ACCOUNT_QUOTA','QUOTA'],['ACCOUNT_SIGN_IN_REQUIRED','AUTH'],['ACCOUNT_TOKEN_INVALID','AUTH'],
  ['MISSING_CREDENTIAL','AUTH'],['INVALID_CREDENTIAL','AUTH'],
])

export function summarySessionId(sessionId, route) {
  return 'superlcm-summary-' + createHash('sha256')
    .update(JSON.stringify([sessionId, route?.provider ?? '', route?.model ?? '']))
    .digest('hex').slice(0, 32)
}

// DSH's BlockAssembler defaults to stop even if the wire closes without finish.
// Require the actual terminal event before any summary may replace or be stored.
export async function* completeSummaryStream(stream, signal) {
  let finished = false,received=false
  const iterator = stream[Symbol.asyncIterator]()
  try { for (;;) {
    signal?.throwIfAborted()
    const {value:chunk,done} = await abortable(iterator.next(),signal)
    if (done) break
    signal?.throwIfAborted()
    if (finished || chunk.type === 'tool-call-delta' || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') {
      throw new Error('Summary generation was incomplete; unexpected summary stream output, original content retained')
    }
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind !== 'stop') {
        const raw = chunk.reason?.failure?.code ?? chunk.reason?.code
        const code = routeFailureCodes.get(raw)
        throw Object.assign(new Error('Summary generation was incomplete; original content retained'),code ? {code} : {})
      }
      finished = true
    }
    if(chunk.type==='text-delta'&&chunk.text)received=true
    yield chunk
  } } finally {
    // Async generator return() can itself queue behind an ignored abort.
    // Request cleanup without waiting for that uncooperative provider.
    try { Promise.resolve(iterator.return?.()).catch(() => {}) } catch {}
  }
  signal?.throwIfAborted()
  if (!finished) throw Object.assign(new Error(received?'Summary generation was incomplete; stream cut off before its final event, original content retained':'Summary generation was incomplete; no completion data, original content retained'),{summaryKind:received?'stream_cutoff':'stream_empty'})
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
