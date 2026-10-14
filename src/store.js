import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CompressionReporter } from './compression-status.js'

const SCHEMA_VERSION = 4

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
}

export function rowToNode(row) {
  if (row === undefined) return null
  return {
    sessionId: row.session_id,
    nodeId: row.node_id,
    compactionId: row.compaction_id ?? null,
    summarySeq: row.summary_seq ?? null,
    createdAt: row.created_at,
    summary: parseJson(row.summary_json, []),
    summaryText: row.summary_text,
    childIds: parseJson(row.child_ids_json, []),
    sourceSeqs: parseJson(row.source_seqs_json, []),
    sourceStart: row.source_start ?? null,
    sourceEnd: row.source_end ?? null,
    shadowedTokenCount: row.shadowed_token_count ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    status: row.status,
    kind: row.node_kind ?? null,
  }
}

function safeLimit(value, fallback = 20, max = 200) {
  if (!Number.isSafeInteger(value) || value <= 0) return fallback
  return Math.min(value, max)
}

function ftsQuery(text) {
  const tokens = normalizeText(text).match(/[\p{L}\p{N}_./:@-]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

export function resolveDatabasePath(env = process.env) {
  const explicit=env.DSH_SUPERLCM_DB?.trim()||env.DSH_LOSSLESS_DB?.trim()
  if(explicit)return resolve(explicit)
  const root=env.DSH_HOME?.trim()||join(homedir(),'.dsh')
  const current=resolve(root,'SuperLcm','lcm.sqlite'),legacy=resolve(root,'lossless-context','lcm.sqlite')
  return !existsSync(current)&&existsSync(legacy)?legacy:current
}

// Internal runtime location keeps every store on the exact selected filename.
// archiveHome remains compatible with older direct engine configurations.
export function resolveConfiguredDatabasePath(config = {}, env = process.env) {
  if (typeof config.databasePath === 'string' && config.databasePath.trim()) return resolve(config.databasePath)
  return config.archiveHome ? resolve(config.archiveHome, 'lcm.sqlite') : resolveDatabasePath(env)
}

export class SuperLcmStore {
  #db
  #closed = false

  constructor(path = resolveDatabasePath()) {
    this.path = path === ':memory:' ? path : resolve(path)
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    this.#db = new DatabaseSync(this.path)
    this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
    this.#migrate()
  }

  #assertOpen() {
    if (this.#closed) throw new Error('SuperLcm 存储已关闭 / SuperLcm store is closed')
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS lcm_summary_blocks (
        session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id,fingerprint)
      );
      CREATE TABLE IF NOT EXISTS lcm_compaction_drafts (
        session_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data_json TEXT NOT NULL,
        status TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lcm_compaction_ownership (
        session_id TEXT NOT NULL, compaction_id TEXT NOT NULL, start_seq INTEGER NOT NULL,
        lifecycle_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id,compaction_id,start_seq)
      );
      CREATE TABLE IF NOT EXISTS lcm_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lcm_index_state (
        session_id TEXT PRIMARY KEY,
        last_committed_end_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lcm_scan_state (
        session_id TEXT PRIMARY KEY,
        last_scanned_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lcm_nodes (
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        compaction_id TEXT,
        summary_seq INTEGER,
        created_at INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        summary_normalized TEXT NOT NULL,
        child_ids_json TEXT NOT NULL,
        source_seqs_json TEXT NOT NULL,
        source_start INTEGER,
        source_end INTEGER,
        shadowed_token_count INTEGER,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS lcm_nodes_session_created
        ON lcm_nodes(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS lcm_nodes_compaction
        ON lcm_nodes(session_id, compaction_id);
      CREATE TABLE IF NOT EXISTS lcm_edges (
        session_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        child_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (session_id, parent_id, child_id),
        FOREIGN KEY (session_id, parent_id)
          REFERENCES lcm_nodes(session_id, node_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS lcm_edges_child
        ON lcm_edges(session_id, child_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS lcm_nodes_fts USING fts5(
        session_id UNINDEXED,
        node_id UNINDEXED,
        summary_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    if (!this.#db.prepare('PRAGMA table_info(lcm_nodes)').all().some(row => row.name === 'node_kind')) {
      this.#db.exec('ALTER TABLE lcm_nodes ADD COLUMN node_kind TEXT')
    }
    this.#db.exec(`
      INSERT OR IGNORE INTO lcm_scan_state(session_id, last_scanned_seq)
      SELECT session_id, last_committed_end_seq FROM lcm_index_state;
    `)
    this.#db.prepare(`
      INSERT INTO lcm_meta(key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION))
  }

  compressionReporter(options) { return new CompressionReporter(this.#db, options) }

  archivedSessionIds() {
    if (!this.#db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_mirrors'").get()) return []
    return this.#db.prepare('SELECT header FROM dsh_mirrors').all().map(row => JSON.parse(row.header).id)
  }

  insertNodeIfMissing(node) { return this.upsertNode(node, {onlyIfAbsent:true}) }

  upsertNode(node, {onlyIfAbsent=false} = {}) {
    this.#assertOpen()
    const childIds = [...new Set(node.childIds ?? [])]
    const sourceSeqs = [...new Set(node.sourceSeqs ?? [])]
    const summaryJson = JSON.stringify(node.summary ?? [])
    const summaryText = String(node.summaryText ?? '')
    const createdAt = Number.isFinite(node.createdAt) ? Math.trunc(node.createdAt) : Date.now()

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if(onlyIfAbsent){const prior=this.getNode(node.sessionId,node.nodeId);if(prior){this.#db.exec('COMMIT');return {node:prior,inserted:false}}}
      this.#db.prepare(`
        INSERT INTO lcm_nodes(
          session_id, node_id, compaction_id, summary_seq, created_at,
          summary_json, summary_text, summary_normalized,
          child_ids_json, source_seqs_json, source_start, source_end,
          shadowed_token_count, provider, model, status, node_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, node_id) DO UPDATE SET
          compaction_id = excluded.compaction_id,
          summary_seq = excluded.summary_seq,
          created_at = excluded.created_at,
          summary_json = excluded.summary_json,
          summary_text = excluded.summary_text,
          summary_normalized = excluded.summary_normalized,
          child_ids_json = excluded.child_ids_json,
          source_seqs_json = excluded.source_seqs_json,
          source_start = excluded.source_start,
          source_end = excluded.source_end,
          shadowed_token_count = excluded.shadowed_token_count,
          provider = excluded.provider,
          model = excluded.model,
          status = excluded.status,
          node_kind = excluded.node_kind
      `).run(
        node.sessionId,
        node.nodeId,
        node.compactionId ?? null,
        node.summarySeq ?? null,
        createdAt,
        summaryJson,
        summaryText,
        normalizeText(summaryText),
        JSON.stringify(childIds),
        JSON.stringify(sourceSeqs),
        sourceSeqs.length > 0 ? sourceSeqs[0] : null,
        sourceSeqs.length > 0 ? sourceSeqs[sourceSeqs.length - 1] : null,
        node.shadowedTokenCount ?? null,
        node.provider ?? null,
        node.model ?? null,
        node.status ?? 'ready',
        node.kind ?? null,
      )
      this.#db.prepare('DELETE FROM lcm_edges WHERE session_id = ? AND parent_id = ?')
        .run(node.sessionId, node.nodeId)
      const insertEdge = this.#db.prepare(`
        INSERT OR IGNORE INTO lcm_edges(session_id, parent_id, child_id, position)
        VALUES (?, ?, ?, ?)
      `)
      childIds.forEach((childId, position) => insertEdge.run(node.sessionId, node.nodeId, childId, position))
      this.#db.prepare('DELETE FROM lcm_nodes_fts WHERE session_id = ? AND node_id = ?')
        .run(node.sessionId, node.nodeId)
      this.#db.prepare('INSERT INTO lcm_nodes_fts(session_id, node_id, summary_text) VALUES (?, ?, ?)')
        .run(node.sessionId, node.nodeId, summaryText)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    const saved=this.getNode(node.sessionId, node.nodeId)
    return onlyIfAbsent ? {node:saved,inserted:true} : saved
  }

  indexCursor(sessionId) {
    this.#assertOpen()
    const row = this.#db.prepare('SELECT last_scanned_seq FROM lcm_scan_state WHERE session_id = ?').get(sessionId)
    return row === undefined ? -1 : Number(row.last_scanned_seq)
  }

  setIndexCursor(sessionId, seq) {
    this.#assertOpen()
    if (!Number.isSafeInteger(seq)) return this.indexCursor(sessionId)
    this.#db.prepare(`
      INSERT INTO lcm_scan_state(session_id, last_scanned_seq) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_scanned_seq = MAX(last_scanned_seq, excluded.last_scanned_seq)
    `).run(sessionId, seq)
    return this.indexCursor(sessionId)
  }

  getNode(sessionId, nodeId) {
    this.#assertOpen()
    return rowToNode(this.#db.prepare(`
      SELECT * FROM lcm_nodes WHERE session_id = ? AND node_id = ?
    `).get(sessionId, nodeId))
  }

  getCompactionNode(sessionId, compactionId) {
    this.#assertOpen()
    return rowToNode(this.#db.prepare('SELECT * FROM lcm_nodes WHERE session_id = ? AND compaction_id = ?').get(sessionId,compactionId))
  }

  listNodes(sessionId, { limit = 200, status } = {}) {
    this.#assertOpen()
    const capped = safeLimit(limit, 200, 5000)
    const rows = status === undefined
      ? this.#db.prepare(`
          SELECT * FROM lcm_nodes WHERE session_id = ?
          ORDER BY created_at DESC, summary_seq DESC LIMIT ?
        `).all(sessionId, capped)
      : this.#db.prepare(`
          SELECT * FROM lcm_nodes WHERE session_id = ? AND status = ?
          ORDER BY created_at DESC, summary_seq DESC LIMIT ?
        `).all(sessionId, status, capped)
    return rows.map(rowToNode)
  }

  listNodeIds(sessionId) {
    this.#assertOpen()
    return this.#db.prepare('SELECT node_id FROM lcm_nodes WHERE session_id = ? ORDER BY node_id').all(sessionId).map(row => row.node_id)
  }

  searchNodes(sessionId, query, { limit = 20 } = {}) {
    this.#assertOpen()
    const capped = safeLimit(limit, 20, 200)
    const normalized = normalizeText(query).trim()
    if (normalized.length === 0) return []
    const hits = new Map()
    const fts = ftsQuery(normalized)
    if (fts !== null) {
      try {
        const rows = this.#db.prepare(`
          SELECT n.*, bm25(lcm_nodes_fts) AS rank
          FROM lcm_nodes_fts
          JOIN lcm_nodes n
            ON n.session_id = lcm_nodes_fts.session_id
           AND n.node_id = lcm_nodes_fts.node_id
          WHERE lcm_nodes_fts MATCH ? AND n.session_id = ?
          ORDER BY rank ASC LIMIT ?
        `).all(fts, sessionId, capped)
        rows.forEach((row, index) => hits.set(row.node_id, { node: rowToNode(row), score: 1000 - index }))
      } catch {
        // FTS 只是加速器；下面的规范化子串扫描才是权威结果。
        // FTS is an accelerator only. The normalized substring scan below is authoritative.
      }
    }
    const rows = this.#db.prepare(`
      SELECT * FROM lcm_nodes
      WHERE session_id = ? AND instr(summary_normalized, ?) > 0
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, normalized, capped)
    for (const row of rows) {
      const node = rowToNode(row)
      const existing = hits.get(node.nodeId)
      const occurrences = normalizeText(node.summaryText).split(normalized).length - 1
      hits.set(node.nodeId, { node, score: (existing?.score ?? 0) + Math.max(1, occurrences) })
    }
    return [...hits.values()]
      .sort((a, b) => b.score - a.score || b.node.createdAt - a.node.createdAt)
      .slice(0, capped)
      .map(({ node, score }) => ({ ...node, score }))
  }

  childrenOf(sessionId, nodeId) {
    this.#assertOpen()
    return this.#db.prepare(`
      SELECT child_id FROM lcm_edges
      WHERE session_id = ? AND parent_id = ? ORDER BY position ASC
    `).all(sessionId, nodeId).map(row => row.child_id)
  }

  parentsOf(sessionId, nodeId) {
    this.#assertOpen()
    return this.#db.prepare(`
      SELECT parent_id FROM lcm_edges
      WHERE session_id = ? AND child_id = ? ORDER BY parent_id ASC
    `).all(sessionId, nodeId).map(row => row.parent_id)
  }

  deleteSession(sessionId) {
    this.#assertOpen()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('DELETE FROM lcm_nodes_fts WHERE session_id = ?').run(sessionId)
      this.#db.prepare('DELETE FROM lcm_edges WHERE session_id = ?').run(sessionId)
      const result = this.#db.prepare('DELETE FROM lcm_nodes WHERE session_id = ?').run(sessionId)
      this.#db.prepare('DELETE FROM lcm_index_state WHERE session_id = ?').run(sessionId)
      this.#db.prepare('DELETE FROM lcm_scan_state WHERE session_id = ?').run(sessionId)
      this.#db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  quickCheck() {
    this.#assertOpen()
    const rows = this.#db.prepare('PRAGMA quick_check').all()
    return rows.map(row => Object.values(row)[0])
  }

  stats(sessionId) {
    this.#assertOpen()
    const nodeCount = this.#db.prepare('SELECT COUNT(*) AS n FROM lcm_nodes WHERE session_id = ?').get(sessionId).n
    const edgeCount = this.#db.prepare('SELECT COUNT(*) AS n FROM lcm_edges WHERE session_id = ?').get(sessionId).n
    const missingChildren = this.#db.prepare(`
      SELECT e.parent_id, e.child_id
      FROM lcm_edges e
      LEFT JOIN lcm_nodes c
        ON c.session_id = e.session_id AND c.node_id = e.child_id
      WHERE e.session_id = ? AND c.node_id IS NULL
      ORDER BY e.parent_id, e.position
    `).all(sessionId)
    return { nodeCount, edgeCount, missingChildren }
  }

  blockSummary(sessionId,fingerprint) {
    this.#assertOpen()
    this.#db.prepare('INSERT OR IGNORE INTO lcm_summary_blocks VALUES (?,?,?)').run(sessionId,fingerprint,Date.now())
  }
  summaryBlocked(sessionId,fingerprint) {
    this.#assertOpen()
    return !!this.#db.prepare('SELECT 1 FROM lcm_summary_blocks WHERE session_id=? AND fingerprint=?').get(sessionId,fingerprint)
  }

  saveDraftIfMissing(sessionId, fingerprint, data) {
    this.#assertOpen()
    return this.#db.prepare("INSERT INTO lcm_compaction_drafts VALUES (?,?,?,'ready',?) ON CONFLICT(session_id) DO NOTHING").run(sessionId,fingerprint,data,Date.now()).changes===1
  }
  recordCommitOwnership(sessionId,startSeq,lifecycle) {
    this.#assertOpen()
    const data=JSON.stringify(lifecycle)
    // Ownership must survive cancellation of a ready draft, and must reach
    // durable storage before the first session lifecycle event can be written.
    const prior=this.#db.prepare('PRAGMA synchronous').get().synchronous
    try {
      this.#db.exec('PRAGMA synchronous = FULL')
      this.#db.prepare('INSERT OR IGNORE INTO lcm_compaction_ownership VALUES (?,?,?,?,?)').run(sessionId,lifecycle.compactionId,startSeq,data,Date.now())
      const row=this.#db.prepare('SELECT lifecycle_json FROM lcm_compaction_ownership WHERE session_id=? AND compaction_id=? AND start_seq=?').get(sessionId,lifecycle.compactionId,startSeq)
      if(!row||row.lifecycle_json!==data)throw Error('Compaction lifecycle ownership conflicts with its durable record')
    }finally{this.#db.exec('PRAGMA synchronous = '+prior)}
  }
  commitOwnership(sessionId,compactionId,startSeq) {
    this.#assertOpen()
    const row=this.#db.prepare('SELECT lifecycle_json FROM lcm_compaction_ownership WHERE session_id=? AND compaction_id=? AND start_seq=?').get(sessionId,compactionId,startSeq)
    return row?JSON.parse(row.lifecycle_json):null
  }

  saveDraft(sessionId, fingerprint, data) {
    this.#assertOpen()
    this.#db.prepare(`INSERT INTO lcm_compaction_drafts VALUES (?,?,?,'ready',?)
      ON CONFLICT(session_id) DO UPDATE SET fingerprint=excluded.fingerprint,
      data_json=excluded.data_json,status='ready',updated_at=excluded.updated_at`).run(sessionId,fingerprint,data,Date.now())
  }
  draftRecord(sessionId) {
    this.#assertOpen()
    const row=this.#db.prepare('SELECT fingerprint,data_json,status FROM lcm_compaction_drafts WHERE session_id=?').get(sessionId)
    return row ? {fingerprint:row.fingerprint,data:row.data_json,status:row.status} : null
  }
  loadDraft(sessionId) {
    this.#assertOpen()
    const row=this.#db.prepare("SELECT fingerprint,data_json FROM lcm_compaction_drafts WHERE session_id=? AND status='ready'").get(sessionId)
    return row ? {fingerprint:row.fingerprint,data:row.data_json} : null
  }
  finishDraft(sessionId,status) {
    this.#assertOpen()
    this.#db.prepare('UPDATE lcm_compaction_drafts SET status=?,data_json=?,updated_at=? WHERE session_id=?').run(status,'{}',Date.now(),sessionId)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#db.close()
  }
}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的导出 / Compatibility exports for older SuperLcm, SuperLCM, and dsh-lossless-context <= 0.2.x.
export { SuperLcmStore as SuperLCMStore }
export { SuperLcmStore as LosslessStore }
