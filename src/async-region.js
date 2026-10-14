import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import { markerFromSummary, appendRecallEnvelope } from './marker.js'
import { nodeLevel, interruptedCompactionRecords } from './core.js'
import { checkpointChild } from './summary-task.js'
import { CHECKPOINT_PREAMBLE } from './checkpoint-frame.js'
import {guardCommitLifecycle} from './commit-lifecycle.js'

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

export class AsyncSurfaceChangedError extends Error {}
export class AsyncClosurePendingError extends Error {}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sourceFingerprints = (session,seqs) => seqs.map(seq=>[seq,hash(session.eventAt(seq))])
function noProgress(engine,sessionId,key,message) {
  engine.superLcmStore.blockSummary(sessionId,key)
  const error=Error(message);error.code='SUPERLCM_SUMMARY_NO_PROGRESS';return error
}

function systemHead(session, headSeq) {
  if (headSeq === undefined) return undefined
  const head = session.eventAt(headSeq)
  return head?.type === 'system/message' ? head : undefined
}

function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader()
  const head = systemHead(session, session.surface.nodes[0])
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const regionMessages = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null)
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? regionMessages : [system, ...regionMessages],
  }
}

function frameSummary(summary) {
  return [
    { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n' + SUMMARY_OPEN_TAG },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

export function minimumCheckpointTokens(engine, children = []) {
  return engine.ctx.tokenMeter.estimateMessage(createUserMessage({
    content: frameSummary(appendRecallEnvelope([], { id: randomUUID(), children })),
    source: compactCheckpointSource(CompactionId(randomUUID())),
  }))
}

export function locateStableSpan(engine, session, prepared) {
  const surfaceNodes = session.surface.nodes
  const startIdx = surfaceNodes.indexOf(prepared.start)
  const endIdx = surfaceNodes.indexOf(prepared.end)
  if (startIdx === -1 || endIdx < startIdx) {
    throw new AsyncSurfaceChangedError('prepared compaction span is no longer present')
  }
  const shadowedSeqs = surfaceNodes.slice(startIdx, endIdx + 1)
  if (!isDeepStrictEqual(shadowedSeqs, prepared.shadowedSeqs)) {
    throw new AsyncSurfaceChangedError('prepared compaction span changed while summarization ran')
  }
  if (!toolPairingBalancedBefore(session, prepared.start) || !toolPairingBalancedAfter(session, prepared.end)) {
    throw new AsyncSurfaceChangedError('prepared compaction span is no longer tool-pair balanced')
  }
  if (!isDeepStrictEqual(prepared.sourceFingerprints, sourceFingerprints(session,shadowedSeqs))) throw new AsyncSurfaceChangedError('prepared source content changed while summarization ran')
  const selectedNodes = engine.ctx.tokenMeter.measure(session).nodes.slice(startIdx, endIdx + 1)
  if (!isDeepStrictEqual(selectedNodes, prepared.selectedNodes)) {
    throw new AsyncSurfaceChangedError('prepared compaction span was rewritten while summarization ran')
  }
}

function inspectCompactionEntryState(session) {
  let openTurn = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart
  let compactionEntryStateKnown = false
  let latestEndSeedSeq
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

export function compactionBusy(session) {
  const state = inspectCompactionEntryState(session)
  return state.unmatchedCompactionStart !== undefined
    && !(state.latestEndSeedSeq !== undefined && state.latestEndSeedSeq > state.unmatchedCompactionStart.seq)
}

export function recoverInterruptedCommit(engine, agent) {
  const session = agent.session
  const entry=inspectCompactionEntryState(session)
  if(!entry.unmatchedCompactionStart)return null
  const record = interruptedCompactionRecords(session).find(record=>record.start.seq===entry.unmatchedCompactionStart.seq&&markerFromSummary(record.summary.data.summary))
  if (!record) return null
  // Finish only this proven replacement. Do not buy another summary or
  // replace its already-shadowed range a second time, including after reboot.
  const end = session.append('compaction/end',record.start.data)
  engine.superLcmStore.finishDraft(session.id,'committed')
  const staged = engine.backgroundFolds.get(agent)
  if (staged?.summarized?.compactionId === record.start.data.compactionId) engine.backgroundFolds.delete(agent)
  return {compactionId:record.start.data.compactionId,startSeq:record.start.seq,summarySeq:record.summary.seq,endSeq:end.seq,
    summary:record.summary.data.summary,shadowedRange:record.summary.data.shadowedRange,
    shadowedSeqs:record.summary.data.shadowedSeqs,shadowedTokenCount:record.summary.data.shadowedTokenCount}
}

export function prepareAsyncRegion(engine, agent, selection) {
  const session = agent.session
  const surfaceNodes = session.surface.nodes
  const startIdx = surfaceNodes.indexOf(selection.start)
  const endIdx = surfaceNodes.indexOf(selection.end)
  if (startIdx === -1 || endIdx < startIdx) throw new AsyncSurfaceChangedError('selected compaction span is not present')
  if (!toolPairingBalancedBefore(session, selection.start) || !toolPairingBalancedAfter(session, selection.end)) {
    throw new AsyncSurfaceChangedError('selected compaction span is not tool-pair balanced')
  }
  const measurement = engine.ctx.tokenMeter.measure(session)
  const selectedNodes = structuredClone(measurement.nodes.slice(startIdx, endIdx + 1))
  const shadowedSeqs = [...surfaceNodes.slice(startIdx, endIdx + 1)]
  const trustedChildNodeIds = [...new Set(shadowedSeqs.map(seq => checkpointChild(engine,session,session.eventAt(seq))).filter(Boolean))]
  if (selectedNodes.length !== shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== shadowedSeqs[index])) {
    throw new AsyncSurfaceChangedError('token-meter surface does not match the selected compaction span')
  }
  return {
    ...selection,
    startIdx,
    endIdx,
    selectedNodes,
    shadowedSeqs,
    sourceFingerprints: sourceFingerprints(session,shadowedSeqs),
    trustedChildNodeIds,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + (node.heuristicTokens ?? node.tokens ?? 0), 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + (node.tokens ?? 0), 0),
    input: structuredClone(buildSummarizationInput(session, shadowedSeqs)),
  }
}

export async function summarizeAsyncRegion(engine, agent, prepared, signal) {
  signal?.throwIfAborted()
  const attemptKey=hash([prepared.input,prepared.summaryTargetTokens,prepared.summaryDepth,prepared.conversationRoute,
    prepared.trustedChildNodeIds,engine.summaryRouteFingerprint(),engine.rollingConfig])
  if (engine.superLcmStore.summaryBlocked(agent.session.id,attemptKey)) {
    const error=Error('相同输入的摘要没有节省空间，请调整摘要模型或粒度后重试');error.code='SUPERLCM_SUMMARY_NO_PROGRESS';throw error
  }
  const compactionId = CompactionId(randomUUID())
  const summaryResult = await engine.summarize(prepared.input, agent, signal, {
    ...(prepared.conversationRoute?{conversationRoute:prepared.conversationRoute}:{}),
    trustedChildNodeIds: prepared.trustedChildNodeIds,
    summaryTask: { level:prepared.summaryDepth ?? Math.max(0,...prepared.trustedChildNodeIds.map(id=>nodeLevel(engine.superLcmStore,agent.session.id,id))),
      first:prepared.start,last:prepared.end, ...(prepared.summaryTargetTokens ? {targetTokens:prepared.summaryTargetTokens} : {}) },
  })
  signal?.throwIfAborted()
  if (summaryResult === null || typeof summaryResult !== 'object' || !Array.isArray(summaryResult.summary)) {
    throw new TypeError('summarizer returned an invalid summary result')
  }
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryResult.summary),
    source: compactCheckpointSource(compactionId),
  })
  const framedSummaryTokenCount = engine.ctx.tokenMeter.estimateMessage(checkpointMessage)
  if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
    throw noProgress(engine,agent.session.id,attemptKey,'summary is not smaller than the shadowed content (' + framedSummaryTokenCount + ' estimated framed tokens >= ' + prepared.shadowedRouteTokenCount + ')')
  }
  return { ...prepared, ...summaryResult, checkpointMessage, compactionId, attemptKey }
}

export function commitAsyncRegion(engine, agent, summarized) {
  const session = agent.session
  if (compactionBusy(session)) return null
  locateStableSpan(engine, session, summarized)
  const { openTurn } = inspectCompactionEntryState(session)
  const lifecycle = { compactionId: summarized.compactionId, turn: openTurn }
  engine.superLcmStore.recordCommitOwnership(session.id,session.seq,lifecycle)
  guardCommitLifecycle(session,lifecycle)
  const startEvent = session.append('compaction/start', lifecycle)
  let closing = false
  try {
    // Durable drafts deliberately omit the provider stream. Do not emit an
    // undefined rawOutput (rejected by DSH) or claim a stream without its data.
    const callRecord = summarized.rawOutput === undefined ? {}
      : { rawOutput: summarized.rawOutput, ...(summarized.llmStreamCall === true ? { llmStreamCall: true } : {}) }
    const summaryEvent = session.append('compaction/summary', {
      compactionId: summarized.compactionId,
      summary: summarized.summary,
      ...callRecord,
      shadowedRange: { start: summarized.start, end: summarized.end },
      shadowedSeqs: [...summarized.shadowedSeqs],
      shadowedTokenCount: summarized.shadowedTokenCount,
      provider: summarized.provider,
      model: summarized.model,
      ...(summarized.preparedBatchCount === undefined ? {} : { preparedBatchCount: summarized.preparedBatchCount }),
      ...(summarized.preparedTree === undefined ? {} : { preparedTree: summarized.preparedTree,
        summaryTreeKind: summarized.summaryTreeKind, summaryTreeDepth: summarized.summaryTreeDepth }),
      ...(summarized.maxTokens === undefined ? {} : { maxTokens: summarized.maxTokens }),
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
    })
    session.append('user/message', summarized.checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq: summarized.start, endSeq: summarized.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...summarized.shadowedSeqs],
    })
    closing = true
    let endEvent
    try { endEvent = session.append('compaction/end', lifecycle) }
    catch {
      // A single transient end-write failure must not leave a successfully
      // replaced context permanently busy. Persistent failures are repaired
      // from the durable start/summary/checkpoint proof on the next request.
      const recovered = recoverInterruptedCommit(engine,agent)
      if (!recovered) throw Error('Compaction replacement could not be closed')
      endEvent = session.eventAt(recovered.endSeq)
    }
    return {
      compactionId: summarized.compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: summarized.summary,
      shadowedRange: { start: summarized.start, end: summarized.end },
      shadowedSeqs: [...summarized.shadowedSeqs],
      shadowedTokenCount: summarized.shadowedTokenCount,
    }
  } catch (error) {
    if (!closing) {
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
      } catch {
        // The unmatched start remains intentionally detectable by lcm_doctor.
      }
    }
    if(closing)throw new AsyncClosurePendingError('压缩替换已完成，结束记录待恢复',{cause:error})
    throw error
  }
}
