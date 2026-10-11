import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { contentBlocksToText, extractMarkers, markerFromSummary, stripRecallMetadata } from './marker.js'
import { preparedTreeNodes } from './prepared-tree.js'
import { semanticLevel } from './tree-semantics.js'
import { checkpointMatches, summaryIdentity, legacyIdentities } from './legacy-checkpoints.js'
import { isDeepStrictEqual } from 'node:util'
const historicalRepair = new WeakMap()

function clampInteger(value, fallback, min, max) {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function sessionIdOf(session) {
  const id = session?.id ?? session?.header?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('a live DSH session id is required')
  return id
}

function sessionEvents(session) {
  // rc.2 提供不可变快照；旧宿主提供 events 数组。
  // rc.2 exposes immutable snapshots; older hosts expose an events array.
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events
  if (!Array.isArray(events)) throw new Error('LCM cannot read session events: unsupported session API')
  return events
}

function eventMapOf(events) {
  const map = new Map()
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq)) map.set(event.seq, event)
  }
  return map
}

function eventText(event) {
  try {
    return JSON.stringify(event)
  } catch {
    return String(event?.data ?? '')
  }
}

function snippetAround(text, query, width = 360) {
  const normalized = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const at = normalized.indexOf(needle)
  if (at < 0) return text.slice(0, width)
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(text.length, start + width)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

function compactionIdOf(event) {
  const value = event?.data?.compactionId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function committedCompactionRecords(events) {
  const active = new Map()
  const committed = []
  const ordered = [...events].sort((left, right) => (left?.seq ?? 0) - (right?.seq ?? 0))
  const eventSeqs = new Set(ordered.map(event => event.seq))
  for (const event of ordered) {
    const id = compactionIdOf(event)
    if (event?.type === 'compaction/start' && id !== null) {
      active.set(id, { start: event, summary: null, checkpoint: null })
      continue
    }
    if (event?.type === 'compaction/summary' && id !== null) {
      const state = active.get(id)
      if (state !== undefined && state.summary === null) state.summary = event
      continue
    }
    if (event?.type === 'user/message' && event.data?.source && isCompactCheckpointSource(event.data.source)) {
      const checkpointId = typeof event.data.source.compactionId === 'string' ? event.data.source.compactionId : null
      const state = checkpointId === null ? undefined : active.get(checkpointId)
      const checkpointMarker = markerFromSummary(event.data?.content)
      const summaryMarker = markerFromSummary(state?.summary?.data?.summary)
      const shadowedSeqs = state?.summary?.data?.shadowedSeqs
      const shadowedRange = state?.summary?.data?.shadowedRange
      if (state !== undefined
        && state.summary !== null
        && event.surfaceOp?.op === 'replace'
        && checkpointMatches(state.summary.data?.summary, event.data?.content)
        && ((checkpointMarker === null && summaryMarker === null)
          || (checkpointMarker !== null && summaryMarker !== null && checkpointMarker.id === summaryMarker.id))
        && Array.isArray(shadowedSeqs)
        && shadowedSeqs.length > 0
        && new Set(shadowedSeqs).size === shadowedSeqs.length
        && shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0 && seq < state.summary.seq && eventSeqs.has(seq))
        && Array.isArray(event.sourceEventSeqs)
        && event.sourceEventSeqs.includes(state.start.seq)
        && event.sourceEventSeqs.includes(state.summary.seq)
        && shadowedSeqs.every(seq => event.sourceEventSeqs.includes(seq))
        && (shadowedRange === undefined
          || (event.surfaceOp.startSeq === shadowedRange.start && event.surfaceOp.endSeq === shadowedRange.end))) {
        state.checkpoint = event
      }
      continue
    }
    if (event?.type === 'compaction/end' && id !== null) {
      const state = active.get(id)
      if (state !== undefined
        && event.data?.error === undefined
        && state.summary !== null
        && state.checkpoint !== null) {
        committed.push({ ...state, end: event })
      }
      active.delete(id)
    }
  }
  return committed
}

export function unfinishedCompactionStarts(events) {
  const open = new Map()
  for (const event of events) {
    const id = compactionIdOf(event)
    if (id && event.type === 'compaction/start') open.set(id,event)
    if (id && event.type === 'compaction/end') open.delete(id)
  }
  return [...open.values()]
}

// Use the same exact checkpoint/source proof as ordinary replay. A missing
// end is repairable only after a valid replacement was actually persisted.
export function interruptedCompactionRecords(session) {
  const events = sessionEvents(session), starts = unfinishedCompactionStarts(events)
  const ends = starts.map((start,index) => ({type:'compaction/end',seq:session.seq+index,data:start.data}))
  const ids = new Set(starts.map(start=>start.data.compactionId))
  return committedCompactionRecords([...events,...ends]).filter(record=>ids.has(record.start.data.compactionId))
}

function scanHighWater(events, afterSeq) {
  const ordered = events
    .filter(event => Number.isSafeInteger(event?.seq) && event.seq > afterSeq)
    .sort((left, right) => left.seq - right.seq)
  if (ordered.length === 0) return afterSeq

  const openStarts = new Map()
  for (const event of ordered) {
    const id = compactionIdOf(event)
    if (event.type === 'compaction/start' && id !== null) openStarts.set(id, event.seq)
    if (event.type === 'compaction/end' && id !== null) openStarts.delete(id)
  }
  if (openStarts.size === 0) return ordered.at(-1).seq

  const firstOpenStart = Math.min(...openStarts.values())
  return ordered.reduce((cursor, event) => event.seq < firstOpenStart ? event.seq : cursor, afterSeq)
}

export function committedCompactionSummary(session, endEvent) {
  if (endEvent?.type !== 'compaction/end') return null
  const endSeq = endEvent.seq
  const record = committedCompactionRecords(sessionEvents(session))
    .find(candidate => candidate.end.seq === endSeq)
  return record?.summary ?? null
}

function trustedCheckpointNodeIds(sessionId, events, records, sourceSeqs, identities) {
  const eventsBySeq = eventMapOf(events)
  const committed = new Map(records.map(record => [record.checkpoint.seq, summaryIdentity(sessionId, record.summary, identities)]))
  return [...new Set(sourceSeqs.flatMap((seq) => {
    const source = eventsBySeq.get(seq)
    if (source?.type !== 'user/message' || !source.data?.source || !isCompactCheckpointSource(source.data.source)) return []
    const marker = markerFromSummary(source.data?.content)
    return marker === null ? committed.has(seq) ? [committed.get(seq)] : [] : [marker.id]
  }))]
}

export function nodeFromCompactionEvent(session, event, context) {
  if (event?.type !== 'compaction/summary') return null
  const marker = markerFromSummary(event.data?.summary)
  const events = context?.events ?? sessionEvents(session), records = context?.records ?? committedCompactionRecords(events)
  if (marker === null && !records.some(record => record.summary.seq === event.seq)) return null
  const sessionId = sessionIdOf(session)
  const sourceSeqs = Array.isArray(event.data?.shadowedSeqs)
    ? event.data.shadowedSeqs.filter(Number.isSafeInteger)
    : []
  return {
    sessionId,
    nodeId: summaryIdentity(sessionId, event, context?.identities),
    compactionId: String(event.data?.compactionId ?? ''),
    summarySeq: event.seq,
    createdAt: Number.isFinite(event.time) ? event.time : Date.now(),
    summary: event.data?.summary ?? [],
    summaryText: stripRecallMetadata(contentBlocksToText(event.data?.summary ?? [])),
    childIds: trustedCheckpointNodeIds(sessionId, events, records, sourceSeqs, context?.identities),
    sourceSeqs,
    shadowedTokenCount: Number.isFinite(event.data?.shadowedTokenCount)
      ? event.data.shadowedTokenCount
      : null,
    provider: typeof event.data?.provider === 'string' ? event.data.provider : null,
    model: typeof event.data?.model === 'string' ? event.data.model : null,
    status: 'ready',
    kind: event.data?.summaryTreeKind ?? null,
  }
}

function writeCompactionTree(store, session, event, context, repairOnly = false) {
  if (!context) {
    const events = sessionEvents(session), records = committedCompactionRecords(events)
    context = { events, records, identities: legacyIdentities(store, sessionIdOf(session), records) }
  }
  const node = nodeFromCompactionEvent(session, event, context)
  if (node === null) return null
  const tree = preparedTreeNodes(session, event, node, store)
  let changed = 0
  for (const item of tree) {
    const existing = repairOnly ? store.getNode(item.sessionId, item.nodeId) : null
    if (existing) {
      if (!isDeepStrictEqual(existing.summary, item.summary)) throw Error('Previously indexed DSH summary changed')
      if (isDeepStrictEqual(existing.childIds, item.childIds) && isDeepStrictEqual(existing.sourceSeqs, item.sourceSeqs)) continue
      store.upsertNode({ ...existing, childIds: item.childIds, sourceSeqs: item.sourceSeqs }); changed++
    } else { store.upsertNode(item); changed++ }
  }
  return { node: store.getNode(node.sessionId, node.nodeId), changed }
}

export function indexCompactionEvent(store, session, event) {
  return writeCompactionTree(store, session, event)?.node ?? null
}

export function reindexSession(store, session, { rebuild = false } = {}) {
  const sessionId = sessionIdOf(session)
  const events = sessionEvents(session)
  if (rebuild) store.deleteSession(sessionId)
  const afterSeq = rebuild ? -1 : store.indexCursor(sessionId)
  const pendingEvents = events.filter(event => Number.isSafeInteger(event?.seq) && event.seq > afterSeq)
  const hasNewEnd = pendingEvents.some(event => event.type === 'compaction/end')
  let repaired = historicalRepair.get(store)
  if (!repaired) historicalRepair.set(store, repaired = new Set())
  const repairHistory = !repaired.has(sessionId)
  const records = hasNewEnd || repairHistory ? committedCompactionRecords(events) : []
  const committed = hasNewEnd || repairHistory
    ? records.filter(record => repairHistory || record.end.seq > afterSeq)
    : []
  const identities = legacyIdentities(store, sessionId, records)
  let markers = 0
  let indexed = 0
  let failedEndSeq = null
  const errors = []
  for (const { summary: event, end } of committed) {
    markers += 1
    try {
      const result = writeCompactionTree(store, session, event, { events, records, identities }, end.seq <= afterSeq)
      if (result?.changed) indexed += 1
    } catch (error) {
      failedEndSeq = end.seq
      errors.push({ seq: event.seq, error: error instanceof Error ? error.message : String(error) })
      break
    }
  }

  let cursor = scanHighWater(pendingEvents, afterSeq)
  if (failedEndSeq !== null) {
    cursor = pendingEvents.reduce((safe, event) => event.seq < failedEndSeq && event.seq <= cursor ? Math.max(safe, event.seq) : safe, afterSeq)
  }
  if (cursor > afterSeq) store.setIndexCursor(sessionId, cursor)
  if (!errors.length) repaired.add(sessionId)
  return { sessionId, afterSeq, scanned: pendingEvents.length, markers, indexed, errors }
}

export function searchSessionEvents(session, query, { limit = 20 } = {}) {
  const needle = String(query ?? '').normalize('NFKC').toLocaleLowerCase().trim()
  if (needle.length === 0) return []
  const capped = clampInteger(limit, 20, 1, 200)
  const hits = []
  for (const event of sessionEvents(session)) {
    const text = eventText(event)
    const normalized = text.normalize('NFKC').toLocaleLowerCase()
    if (!normalized.includes(needle)) continue
    hits.push({
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: event.surfaceOp?.op ?? null,
      snippet: snippetAround(text, needle),
    })
    if (hits.length >= capped) break
  }
  return hits
}

function requireNode(store, sessionId, nodeId) {
  const node = store.getNode(sessionId, nodeId)
  if (node === null) throw new Error(`LCM node not found in this session: ${nodeId}`)
  return node
}

/**
 * 单个召回 DAG 节点的深度：原始折叠检查点为第 1 层，否则比最深子节点高一层。
 * Depth of one node in the recall DAG: level 1 for raw fold checkpoints, and
 * one above the deepest child otherwise.
 * 对损坏的索引保持环安全 / Corruption-safe for damaged indexes.
 */
export function nodeLevel(store, sessionId, nodeId) {
  return semanticLevel(store, sessionId, nodeId)
}

export function describeNode(store, session, nodeId) {
  const sessionId = sessionIdOf(session)
  const node = requireNode(store, sessionId, nodeId)
  return {
    sessionId,
    nodeId: node.nodeId,
    compactionId: node.compactionId,
    summarySeq: node.summarySeq,
    createdAt: node.createdAt,
    level: nodeLevel(store, sessionId, node.nodeId),
    provider: node.provider,
    model: node.model,
    status: node.status,
    childIds: store.childrenOf(sessionId, node.nodeId),
    parentIds: store.parentsOf(sessionId, node.nodeId),
    sourceSeqCount: node.sourceSeqs.length,
    sourceRange: node.sourceSeqs.length === 0
      ? null
      : { first: node.sourceSeqs[0], last: node.sourceSeqs[node.sourceSeqs.length - 1] },
    shadowedTokenCount: node.shadowedTokenCount,
    summary: node.summaryText,
  }
}

function collectDag(store, sessionId, rootId, depth) {
  const nodes = []
  const seen = new Set()
  const queue = [{ id: rootId, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current.id)) continue
    seen.add(current.id)
    const node = store.getNode(sessionId, current.id)
    if (node === null) {
      nodes.push({ nodeId: current.id, depth: current.depth, missing: true })
      continue
    }
    nodes.push({
      nodeId: node.nodeId,
      depth: current.depth,
      summarySeq: node.summarySeq,
      childIds: node.childIds,
      sourceSeqCount: node.sourceSeqs.length,
      summary: node.summaryText,
    })
    if (current.depth < depth) {
      node.childIds.forEach(child => queue.push({ id: child, depth: current.depth + 1 }))
    }
  }
  return nodes
}

export function expandNode(store, session, {
  nodeId,
  sourceOffset = 0,
  eventCharOffset = 0,
  maxChars = 30000,
  recursiveDepth = 0,
} = {}) {
  const sessionId = sessionIdOf(session)
  const node = requireNode(store, sessionId, nodeId)
  const offset = clampInteger(sourceOffset, 0, 0, Math.max(0, node.sourceSeqs.length))
  const charOffset = clampInteger(eventCharOffset, 0, 0, Number.MAX_SAFE_INTEGER)
  const budget = clampInteger(maxChars, 30000, 1, 100000)
  const depth = clampInteger(recursiveDepth, 0, 0, 8)
  const events = sessionEvents(session)
  const eventsBySeq = eventMapOf(events)
  const chunks = []
  let used = 0
  let next = null

  for (let index = offset; index < node.sourceSeqs.length; index += 1) {
    const seq = node.sourceSeqs[index]
    const event = eventsBySeq.get(seq)
    const serialized = event === undefined
      ? JSON.stringify({ seq, missing: true })
      : JSON.stringify(event)
    const start = index === offset ? charOffset : 0
    if (start >= serialized.length) continue
    const separatorCost = chunks.length === 0 ? 0 : 1
    const remaining = budget - used - separatorCost
    if (remaining <= 0) {
      next = { sourceOffset: index, eventCharOffset: start }
      break
    }
    const slice = serialized.slice(start, start + remaining)
    chunks.push({
      seq,
      type: event?.type ?? null,
      charOffset: start,
      complete: start + slice.length >= serialized.length,
      content: slice,
    })
    used += separatorCost + slice.length
    if (start + slice.length < serialized.length) {
      next = { sourceOffset: index, eventCharOffset: start + slice.length }
      break
    }
    if (index + 1 < node.sourceSeqs.length && used >= budget) {
      next = { sourceOffset: index + 1, eventCharOffset: 0 }
      break
    }
  }

  return {
    sessionId,
    nodeId: node.nodeId,
    summary: node.summaryText,
    dag: collectDag(store, sessionId, node.nodeId, depth),
    sourceSeqCount: node.sourceSeqs.length,
    chunks,
    next,
  }
}

export function searchSuperLcmContext(store, session, query, { scope = 'both', limit = 20 } = {}) {
  const sessionId = sessionIdOf(session)
  const capped = clampInteger(limit, 20, 1, 100)
  const normalizedScope = ['summary', 'events', 'both'].includes(scope) ? scope : 'both'
  return {
    sessionId,
    query,
    scope: normalizedScope,
    summaries: normalizedScope === 'events'
      ? []
      : store.searchNodes(sessionId, query, { limit: capped }).map(node => ({
          nodeId: node.nodeId,
          summarySeq: node.summarySeq,
          score: node.score,
          childCount: node.childIds.length,
          sourceSeqCount: node.sourceSeqs.length,
          snippet: snippetAround(node.summaryText, String(query)),
        })),
    events: normalizedScope === 'summary'
      ? []
      : searchSessionEvents(session, query, { limit: capped }),
  }
}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的调用方。
// Compatibility aliases for older SuperLCM and dsh-lossless-context <= 0.2.x consumers.
export const searchSuperLCMContext = searchSuperLcmContext
export const searchLosslessContext = searchSuperLcmContext

export function doctorSession(store, session) {
  const sessionId = sessionIdOf(session)
  const markers = []
  const markerIds = new Set()
  const duplicates = []
  const invalidSources = []
  const events = sessionEvents(session)
  const eventSeqs = new Set(events.map(event => event?.seq).filter(Number.isSafeInteger))
  const records = committedCompactionRecords(events)
  const unfinishedStarts = unfinishedCompactionStarts(events).map(event=>event.seq)
  const identities = legacyIdentities(store, sessionId, records)
  for (const { summary: event } of records) {
    const id = summaryIdentity(sessionId, event, identities)
    markers.push({ seq: event.seq, id })
    if (markerIds.has(id)) duplicates.push(id)
    try {
      const root = nodeFromCompactionEvent(session, event, { events, records, identities })
      for (const node of preparedTreeNodes(session, event, root, store)) {
        if (markerIds.has(node.nodeId) && node.nodeId !== id) duplicates.push(node.nodeId)
        markerIds.add(node.nodeId)
      }
    } catch {
      invalidSources.push({ summarySeq: event.seq, reason: 'invalid prepared summary tree' })
      markerIds.add(id)
    }
    const sourceSeqs = event.data?.shadowedSeqs ?? []
    for (const seq of sourceSeqs) {
      if (!Number.isSafeInteger(seq) || !eventSeqs.has(seq)) {
        invalidSources.push({ summarySeq: event.seq, sourceSeq: seq })
      }
    }
  }
  const stats = store.stats(sessionId)
  const storedIds = new Set(store.listNodeIds(sessionId))
  const missingInDb = [...markerIds].filter(id => !storedIds.has(id))
  const staleInDb = [...storedIds].filter(id => !markerIds.has(id))
  const quickCheck = store.quickCheck()
  return {
    ok: quickCheck.every(value => value === 'ok') && unfinishedStarts.length === 0
      && duplicates.length === 0
      && invalidSources.length === 0
      && missingInDb.length === 0
      && staleInDb.length === 0
      && stats.missingChildren.length === 0,
    sessionId,
    databasePath: store.path,
    quickCheck,
    logMarkers: markers.length,
    storedNodes: stats.nodeCount,
    storedEdges: stats.edgeCount,
    duplicates,
    invalidSources,
    unfinishedStarts,
    missingInDb,
    staleInDb,
    missingChildren: stats.missingChildren,
  }
}

export function markerInventory(value) {
  return extractMarkers(value)
}
