import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Engine from '../src/engine.js'
import {markerFromSummary} from '../src/marker.js'
import {nodeLevel,reindexSession} from '../src/core.js'
import {SuperLcmStore} from '../src/store.js'
import {semanticFrontier} from '../src/tree-semantics.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
async function withHost(config, response, run) {
  const dir = mkdtempSync(join(tmpdir(), 'superlcm-dsh-optimized-'))
  const prior = process.env.DSH_SUPERLCM_DB
  process.env.DSH_SUPERLCM_DB = join(dir, 'lcm.sqlite')
  const ctx = new Context(), calls = [], warnings = []
  ctx.logger.warn = message => warnings.push(message)
  try {
    new SessionStore(ctx); new SessionProjections(ctx)
    const localStream=async function* (options) {
      calls.push({ provider: options.provider, model: options.model, signal: options.signal, sessionId: options.sessionId,
        inputTokens:Math.ceil(JSON.stringify(options.messages).length/4) })
      const text = await response(options)
      yield { type: 'text-delta', index: 0, text:'# '+text }
    }
    ctx.reflect.provide('llm', {
      stream:options=>ctx.waterfall('llm/stream',options,()=>localStream(options)),
      prepareCall:async config=>({config,context:{contextWindow:config.model==='million'?1000000:100000},stream:options=>ctx.llm.stream(options)}),
      resolveModelInfo:async (_provider,model)=>({context:{contextWindow:model==='million'?1000000:100000},defaultMaxTokens:0}), imageRequestPricing() {}, fileRequestText() {} })
    new TokenMeter(ctx)
    new Engine(ctx, { budgetMode:'tokens', auto: false, summarizationProvider: 'local', summarizationModel: 'fixture', ...config })
    const session = ctx.sessions.create('optimized-native', { meta: { cwd: '/project' } })
    const agent = { session, options: { provider: 'local', model: 'fixture' } }
    await tick()
    await run({ ctx, engine: ctx.compaction, session, agent, calls, warnings, dir })
  } finally {
    await ctx.fiber.dispose()
    if (prior === undefined) delete process.env.DSH_SUPERLCM_DB; else process.env.DSH_SUPERLCM_DB = prior
  }
}
const append = (session, text) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
const source = 'original engineering facts and exact numbers. '.repeat(5000)

test('successive checkpoints retain a same-level forest and only four siblings truly升层', async () => {
  let serial = 0
  await withHost({ minRetainTokens: 1000, foldBatchTokens: 64000, pressureFoldTokens: 1000,
    summaryPrefixTargetTokens: 64000, softActiveTokens: 4000, hardActiveTokens: 10000 },
  async () => 'Distinct summarized facts and exact references ' + (++serial),
  async ({ engine, session, agent, dir }) => {
    const levels = [], sizes = [], original = [], replacements = []
    for (let i = 0; i < 6; i++) {
      const raw = append(session, source.slice(0, 24000) + i); original.push(raw.seq)
      const live = [...session.surface.nodes]
      engine.startBackgroundFold(agent, { start: raw.seq, end: raw.seq, activeTokens: 8000, eligibleEnd: raw.seq })
      await engine.settleBackgroundFold(agent)
      assert.deepEqual(session.surface.nodes, live, 'preparation never changes the live prefix')
      const result = engine.tryCommitBackgroundFold(agent, { allowPressure: true }); assert.ok(result)
      await tick()
      assert.equal(new Set(result.shadowedSeqs).size, result.shadowedSeqs.length, 'physical checkpoints occur once')
      const root = markerFromSummary(result.summary).id
      levels.push(nodeLevel(engine.superLcmStore, session.id, root))
      sizes.push(semanticFrontier(engine.superLcmStore, session.id, root).length)
      replacements.push(session.snapshotEvents().filter(e => e.surfaceOp?.op === 'replace').length)
    }
    assert.deepEqual(levels, [1, 1, 1, 2, 2, 2])
    assert.deepEqual(sizes, [1, 2, 3, 1, 2, 3])
    assert.deepEqual(replacements, [1, 2, 3, 4, 5, 6])
    assert.equal(serial, 7, 'six first-level summaries plus one genuine four-way merge')
    const root = markerFromSummary(session.eventAt(session.surface.nodes[0]).data.content).id
    const rebuilt = new SuperLcmStore(join(dir, 'forest-rebuilt.sqlite'))
    try {
      assert.deepEqual(reindexSession(rebuilt, session).errors, [])
      assert.equal(nodeLevel(rebuilt, session.id, root), 2)
      assert.deepEqual(semanticFrontier(rebuilt, session.id, root), semanticFrontier(engine.superLcmStore, session.id, root))
      for (const seq of original) assert.match(session.eventAt(seq).data.content[0].text, /original engineering facts/)
    } finally { rebuilt.close() }
  })
})
