import {SUMMARY_POLICY_VERSION} from './summary-policy.js'
import { randomUUID } from 'node:crypto'
import { nativePreStep, registerRequestBoundary } from './request-boundary.js'
import { currentPolicy, latestUserIndex, pressureStep, resolvePolicy } from './ratio-runtime.js'
import { saveDraft, restoreDraft, finishDraft } from './draft-persistence.js'
import { engineSchema } from './engine-schema.js'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { committedCompactionSummary, indexCompactionEvent, nodeLevel } from './core.js'
import { appendRecallEnvelope, markerFromSummary } from './marker.js'
import { selectRollingRange } from './rolling.js'
import { carryPrefix, buildDraftTree, assembleTree, draftTokens, summaryBudget, draftBudget } from './draft-tree.js'
import { selectionPricing } from './selection-pricing.js'
import { selectSummaryCondensation } from './summary-prefix.js'
import { SessionFoldRegistry, SummaryGuards } from './summary-guards.js'
import { SuperLcmStore, resolveConfiguredDatabasePath } from './store.js'
import { summaryContext } from './summary-model.js'
import { summarizeWithRecall } from './engine-summary.js'
import { readControls, controlsConfig } from './controls-config.js'
import { watchControls } from './controls-runtime.js'
import {
  AsyncSurfaceChangedError,
  commitAsyncRegion,
  prepareAsyncRegion,
  summarizeAsyncRegion,
  minimumCheckpointTokens,
} from './async-region.js'

import { DEPRECATED_CONFIG_KEYS, FALLBACK_CONFIG_KEYS, ROLLING_CONFIG_KEYS, ROLLING_DEFAULTS, positiveInteger, nonNegativeInteger, normalizeRolling, cleanRouteValue, cleanRoute, routeIsComplete, routeIsConfigured, routesEqual, SETTINGS_NAMESPACE, SUMMARIZATION_ROUTE_SCHEMA, SETTINGS_SCHEMA, unwrapVolatile, unwrapConfig, splitConfig, systemPrefixEndIndex, isFrozenCheckpoint, firstFoldableSurfaceIndex, reportIndexFailure } from './engine-config.js'

export class SuperLcmCompactionEngine extends BasicCompactionEngine {
  static Config = engineSchema

  constructor(ctx, config = {}) {
    config={...config,...(config.runtimeTuning?.[ctx.get?.('profileContext')?.name]||{})}
    const controls=readControls(config.controlFile)
    if(controls)config={...config,...controls.config}
    const { base, rolling, fallbackRoute } = splitConfig(config)
    super(ctx, base)
    const summary=summaryContext(ctx,config.summaryAdapter)
    this.summaryContext=summary?.ctx
    this.summaryModelReady=summary?.ready
    this.disposeSummary=summary?.dispose
    this.summaryModelReady?.catch(()=>ctx.logger?.warn?.('SuperLcm 压缩模型配置无法加载'))
    this.rollingConfig = rolling
    ctx.logger?.info?.('SuperLcm：已启用后台分批组装，达到压缩门槛后一次替换上下文')
    this.fallbackSummarizationRoute = fallbackRoute
    this.superLcmStore = new SuperLcmStore(resolveConfiguredDatabasePath(config))
    this.compressionReporter = this.superLcmStore.compressionReporter({
      kind: 'engine', profile: ctx.get?.('profileContext')?.name || null,
      enabled: this.config.auto === true,
      routeReady: !!this.config.summarizationProvider && !!this.config.summarizationModel,
      onError: () => ctx.logger?.warn?.('SuperLcm 压缩状态写入失败'),
    })
    this.backgroundFolds = new SessionFoldRegistry()
    this.summaryGuards = new SummaryGuards()
    this.backgroundControllers = new Set()
    this.runtimeGeneration = 0
    this.warnedMissingBackgroundRoute = false
    this.superlcmStore = this.superLcmStore
    // 兼容 dsh-lossless-context <= 0.2.x 的旧属性 / Compatibility property for dsh-lossless-context <= 0.2.x.
    this.losslessStore = this.superLcmStore
    ctx.effect(() => () => {
      this.compressionReporter.close()
      for (const controller of this.backgroundControllers) controller.abort(new Error('SuperLcm disposed'))
      this.backgroundControllers.clear()
      this.superLcmStore.close()
    })

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'compaction/end') return
      try {
        const summaryEvent = committedCompactionSummary(session, event)
        if (summaryEvent !== null) {
          const node = indexCompactionEvent(this.superLcmStore, session, summaryEvent)
          this.superLcmStore.setIndexCursor(node.sessionId, event.seq)
        }
      } catch (error) {
        reportIndexFailure(error)
      }
    })

    registerRequestBoundary(this)
    this.watchVolatileConfig(ctx)
    watchControls(this,ctx,config.controlFile,controls)
    if(config.controlFile&&!this.config.auto)this._registerAutomaticCompaction()
  }

  // dsh 0.1.7 迁移：原 installSection 的 onChange/validate 由这里承接。
  // volatile 字段变更时 Loader 会把新值提交进运行中的 fiber.config，
  // 并对本 fiber 发 loader/volatile-update；这里重读 config 派生运行参数。
  watchVolatileConfig(ctx) {
    ctx.on('loader/volatile-update', () => {
      if(this.controlFile)return
      try {
        this.applyRuntimeConfig(ctx.fiber?.config)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[SuperLcm] 配置变更被拒绝 / rejected config change: ${message}`)
      }
    })
  }

  applyRuntimeConfig(config) {
    const raw = unwrapConfig(config)
    // 先做主路由校验（与旧版 validate 的报错顺序一致），再走 splitConfig
    // 的 fallback 完整性检查。
    const route = cleanRoute({
      provider: raw.summarizationProvider,
      model: raw.summarizationModel,
    })
    if (!routeIsComplete(route) || !routeIsConfigured(route)) {
      throw new Error('background compaction requires an explicit summarization provider and model')
    }
    const { rolling, fallbackRoute } = splitConfig(raw)
    if (!routeIsComplete(fallbackRoute)) {
      throw new Error('fallback summarization provider and model must be set together')
    }
    if (routeIsConfigured(fallbackRoute) && routesEqual(route, fallbackRoute)) {
      throw new Error('fallback summarization route must differ from the primary route')
    }
    if (rolling.pressureFoldTokens > rolling.foldBatchTokens) {
      throw new Error(`pressureFoldTokens (${rolling.pressureFoldTokens}) must not exceed foldBatchTokens (${rolling.foldBatchTokens})`)
    }
    if (rolling.hardActiveTokens <= rolling.softActiveTokens) {
      throw new Error(`hardActiveTokens (${rolling.hardActiveTokens}) must be greater than softActiveTokens (${rolling.softActiveTokens})`)
    }
    this.runtimeGeneration++
    for (const controller of this.backgroundControllers) controller.abort(new Error('压缩设置已更新'))
    this.rollingConfig = rolling
    this.fallbackSummarizationRoute = fallbackRoute
    this.summaryGuards.clear()
    this.compressionReporter.configure({ enabled: this.config.auto === true, routeReady: !!route.provider && !!route.model })
    this.config = {
      ...this.config,
      summarizationProvider: route.provider,
      summarizationModel: route.model,
    }
  }

  async summarize(...args) { return summarizeWithRecall(this,args) }

  _registerAutomaticCompaction() {
    if (this.rollingConfig === undefined) {
      if (!this.registrationDeferred) {
        this.registrationDeferred = true
        queueMicrotask(() => this._registerAutomaticCompaction())
      }
      return
    }
    if(this.automaticRegistered)return
    this.automaticRegistered=true
    if (this.rollingConfig.mode !== 'rolling') return super._registerAutomaticCompaction()
    this._registerRollingPressure()
    this._registerOverflowRecovery()
  }

  _registerRollingPressure() {
    const { ctx } = this
    ctx.on('agent/pre-step', async (payload, next) => {
      const {agent,signal}=payload
      if (signal.aborted || !this.config.auto || nativePreStep(this,payload)) return next()
      await pressureStep(this, agent, signal)
      return next()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle'&&this.config.auto) this.tryCommitBackgroundFold(agent)
    })
  }

  backgroundRouteConfigured() {
    const provider = cleanRouteValue(this.config?.summarizationProvider)
    const model = cleanRouteValue(this.config?.summarizationModel)
    if (provider.length > 0 && model.length > 0) return [{ provider, model }, this.fallbackSummarizationRoute].some(route => routeIsConfigured(route) && this.summaryGuards.canTry(route))
    if (!this.warnedMissingBackgroundRoute) {
      this.warnedMissingBackgroundRoute = true
      this.ctx.logger?.warn?.('SuperLcm background compaction requires an explicit summarizationRoute; refusing to fall back to the conversation model')
    }
    return false
  }

  prepareBackgroundSelection(agent, selection) {
    return prepareAsyncRegion(this, agent, selection)
  }

  summarizeBackgroundSelection(agent, prepared, signal) {
    return summarizeAsyncRegion(this, agent, prepared, signal)
  }

  commitBackgroundSelection(agent, summarized) {
    const result = commitAsyncRegion(this, agent, summarized)
    return result === null ? null : { ...result, rollingPolicy: summarized }
  }

  summaryRouteFingerprint() { return JSON.stringify([SUMMARY_POLICY_VERSION,this.config.summarizationProvider, this.config.summarizationModel, this.fallbackSummarizationRoute]) }

  canPrepareBackground(agent) {
    if(this.controlFile&&!this.config.auto)return false
    const state = this.backgroundFolds.get(agent)
    return (!state || state.status === 'ready') && this.backgroundRouteConfigured() && this.summaryGuards.canStart(agent, this.summaryRouteFingerprint())
  }

  startBackgroundFold(agent, selection) {
    const policy = currentPolicy(this, agent)
    if (!policy) return null
    if (!this.canPrepareBackground(agent)) return false
    let previous = this.backgroundFolds.get(agent)
    const suffix = !previous ? carryPrefix(this, agent, agent.session.surface.nodes.indexOf(selection.end) + 1, firstFoldableSurfaceIndex(agent.session)) : []
    if (!previous) {
      const prefix = carryPrefix(this, agent, systemPrefixEndIndex(agent.session), agent.session.surface.nodes.indexOf(selection.start))
      if (prefix.length) previous = { status: 'ready', parts: [], frontier: prefix, tree: [] }
    }
    const parts = previous?.parts ?? []
    if (parts.length && !selection.treeOnly) {
      const nodes = agent.session.surface.nodes
      if (nodes.indexOf(selection.start) !== nodes.indexOf(previous.summarized.end) + 1) return false
    }
    const fingerprint = this.summaryRouteFingerprint()
    let prepared
    try {
      prepared = selection.treeOnly ? previous.summarized : this.prepareBackgroundSelection(agent, selection)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(`rolling compaction staging failed: ${message}; continuing`)
      return false
    }

    const controller = new AbortController()
    const state = { status: 'summarizing', selection, prepared, controller, promise: null, summarized: null, parts,
      signature: policy.signature, cutoffEnd: previous?.cutoffEnd ?? (selection.activeTokens >= policy.softActiveTokens ? selection.eligibleEnd : undefined), revision:this.controlRevision, generation: this.runtimeGeneration }
    this.backgroundFolds.set(agent, state)
    this.backgroundControllers.add(controller)
    this.compressionReporter.report(agent.session.id, 'summarizing', { ...selection, start: parts[0]?.start ?? selection.start })
    let timer
    const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => {
      state.status = 'cancelling'
      this.compressionReporter.report(agent.session.id, 'cancelling', selection)
      controller.abort(new Error('SuperLcm 后台摘要超时'))
    }, policy.summaryTimeoutMs)
    timer.unref() }
    armTimeout()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
    if (!selection.treeOnly && policy.summaryLeafTargetTokens) prepared.summaryTargetTokens = policy.summaryLeafTargetTokens
    state.promise = (selection.treeOnly ? Promise.resolve(null) : this.summarizeBackgroundSelection(agent, prepared, controller.signal))
      .then(async (summarized) => {
        controller.signal.throwIfAborted()
        if (this.backgroundFolds.get(agent) !== state || currentPolicy(this, agent)?.signature !== state.signature) return
        const built = await buildDraftTree(this, agent, previous, summarized, controller.signal, suffix, armTimeout)
        controller.signal.throwIfAborted()
        if (this.backgroundFolds.get(agent) !== state || currentPolicy(this, agent)?.signature !== state.signature) return
        state.parts = summarized ? [...parts, summarized] : parts
        state.frontier = built.frontier; state.tree = built.tree
        state.summarized = assembleTree(this, built.frontier, built.tree, state.parts.length)
        state.status = 'ready'
        saveDraft(this, agent, state)
        this.compressionReporter.report(agent.session.id, 'ready', state.summarized)
        this.summaryGuards.succeededSession(agent)
        // Prepare only up to the frozen end once pressure asks for a switch.
        const next = this.planRolling(agent)
        if (next !== null) this.startBackgroundFold(agent, next)
      })
      .catch((error) => {
        this.compressionReporter.report(agent.session.id, controller.signal.aborted ? 'cancelled' : 'failed', selection)
        if (this.backgroundFolds.get(agent) === state) {
          const recovered = state.recoveryReady ?? previous
          if (recovered?.status === 'ready' && recovered.summarized && recovered.generation === this.runtimeGeneration && currentPolicy(this,agent)?.signature === recovered.signature) this.backgroundFolds.set(agent, recovered)
          else this.backgroundFolds.delete(agent)
        }
        this.summaryGuards.failedSession(agent, fingerprint, policy.summaryRetryCooldownMs)
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`rolling compaction background summary failed: ${message}; continuing`)
      })
      .finally(() => { clearTimeout(timer); this.backgroundControllers.delete(controller) })
    return true
  }

  tryCommitBackgroundFold(agent, options = {}) {
    const policy = currentPolicy(this, agent)
    if (!policy) return null
    const state = this.backgroundFolds.get(agent)
    const activeTokens = options.allowPressure === true || options.force === true ? this.ctx.tokenMeter.measure(agent.session).totalTokens : 0
    if (state && state.cutoffEnd === undefined && (activeTokens >= policy.softActiveTokens || options.force === true)) {
      const measurement = this.ctx.tokenMeter.measure(agent.session)
      const priced = selectionPricing(measurement, agent.session.requestHeader())
      const eligible = selectRollingRange(priced.nodes, agent.session.surface.nodes, { ...policy,
        tailCount: policy.minRetainTokens > 0 ? 1 : policy.tailCount,
        retainTokenBudget: true, activeTokens, forceHard: options.force === true,
        firstFoldableIndex: firstFoldableSurfaceIndex(agent.session),
        protectedFromIndex: policy.protectLatestUser ? latestUserIndex(agent.session) : undefined,
        isBalancedBefore: seq => toolPairingBalancedBefore(agent.session, seq),
        isBalancedAfter: seq => toolPairingBalancedAfter(agent.session, seq) })
      state.cutoffEnd = eligible?.eligibleEnd ?? state.summarized?.end ?? state.prepared?.end
      const durable = state.status === 'ready' ? state : state.recoveryReady
      if (durable) { durable.cutoffEnd = state.cutoffEnd; saveDraft(this,agent,durable) }
    }
    if (state?.status !== 'ready') return null
    if (state.generation !== this.runtimeGeneration || state.signature !== policy.signature) {
      this.backgroundFolds.delete(agent); this.compressionReporter.report(agent.session.id, 'discarded', state.selection); return null
    }
    if(this.controlFile&&(!this.config.auto||state.revision!==this.controlRevision)){this.backgroundFolds.delete(agent);this.compressionReporter.report(agent.session.id,'discarded',state.selection);return null}
    if (options.force !== true) {
      if (activeTokens < policy.softActiveTokens) return null
    }
    // Catch up the last eligible span before the single live replacement.
    if (this.planRolling(agent) !== null) return null
    if (draftTokens(this, agent, state.frontier) > summaryBudget(policy)) return null
    try {
      const result = this.commitBackgroundSelection(agent, state.summarized)
      if (result === null) return null
      this.backgroundFolds.delete(agent)
      finishDraft(this, agent)
      this.compressionReporter.report(agent.session.id, 'committed', state.summarized)
      this.logFoldResult(this.ctx, result)
      return result
    } catch (error) {
      this.backgroundFolds.delete(agent)
      this.compressionReporter.report(agent.session.id, error instanceof AsyncSurfaceChangedError ? 'discarded' : 'failed', state.selection)
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AsyncSurfaceChangedError) {
        this.ctx.logger?.info?.(`rolling compaction prepared span changed; restaging later: ${message}`)
      } else {
        this.ctx.logger?.warn?.(`rolling compaction commit failed: ${message}; continuing`)
      }
      return null
    }
  }

  async settleBackgroundFold(agent) {
    let state
    while (['summarizing', 'cancelling'].includes((state = this.backgroundFolds.get(agent))?.status)) await state.promise
  }

  logFoldResult(ctx, result) {
    if (result !== null && typeof result === 'object' && Array.isArray(result.shadowedSeqs)) {
      const policy = result.rollingPolicy
      const detail = policy === undefined
        ? ''
        : `, reason=${policy.reason}, active~${policy.activeTokens}, tail~${policy.tailTokens}`
      ctx.logger?.info?.(
        `compaction (rolling): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens${detail})`,
      )
    }
  }

  _registerOverflowRecovery() {
    const { ctx } = this
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== void 0) this.overflowRetries.delete(agent)
    })
    ctx.on('agent/request-error', ({ agent, failure, signal }, next) => {
      if (!this.config.auto||failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= (this.config?.maxOverflowRetries ?? 1)) return next()
      const generation = agent.session.surface.replaceGeneration
      const result = this.tryCommitBackgroundFold(agent, { force: true })
      if (result !== null && agent.session.surface.replaceGeneration > generation) {
        this.overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      if (this.canPrepareBackground(agent)) {
        try {
          const selection = this.planRolling(agent, true)
          if (selection !== null) this.startBackgroundFold(agent, selection)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger?.warn?.(`context-overflow background staging failed: ${message}`)
        }
      }
      ctx.logger?.warn?.('context overflow reached before the background summary was ready; preserving the request error without blocking')
      return next()
    })
  }

  planRolling(agent, forceHard = false) {
    const policy = currentPolicy(this, agent)
    if (!policy) return null
    const session = agent.session
    const staged = this.backgroundFolds.get(agent)
    if (staged && staged.status !== 'ready') return null
    if (staged && staged.generation !== this.runtimeGeneration) {
      this.backgroundFolds.delete(agent)
      return this.planRolling(agent, forceHard)
    }
    if (staged?.frontier && draftTokens(this, agent, staged.frontier) > draftBudget(this,agent)) {
      return { ...staged.selection, treeOnly: true }
    }
    const measurement = this.ctx.tokenMeter.measure(session)
    const priced = selectionPricing(measurement, session.requestHeader())
    const options = {
      tailCount: policy.minRetainTokens > 0 ? 1 : policy.tailCount,
      minRetainTokens: policy.minRetainTokens,
      retainTokenBudget: true,
      pressureFoldTokens: policy.pressureFoldTokens,
      foldBatchTokens: policy.foldBatchTokens,
      softActiveTokens: policy.softActiveTokens,
      hardActiveTokens: policy.hardActiveTokens,
      activeTokens: measurement.totalTokens,
      firstFoldableIndex: firstFoldableSurfaceIndex(session),
      protectedFromIndex: policy.protectLatestUser ? latestUserIndex(session) : undefined,
      isBalancedBefore: (seq) => toolPairingBalancedBefore(session, seq),
      isBalancedAfter: (seq) => toolPairingBalancedAfter(session, seq),
      forceHard,
    }
    if (staged?.cutoffEnd !== undefined) options.lastFoldableIndex = session.surface.nodes.indexOf(staged.cutoffEnd)
    // Once drafts exist, fill small gaps ahead of the switch rather than
    // waiting for another whole batch while the live request is already full.
    if (staged?.parts?.length) {
      // A frozen cycle must finish its final span even when it is smaller
      // than the usual background batch minimum. The frozen end still
      // prevents newly arriving messages from extending this cycle.
      options.prepareMinimumTokens = staged.cutoffEnd !== undefined ? 1 : policy.pressureFoldTokens
    }
    const systemEnd = systemPrefixEndIndex(session), prefixEnd = options.firstFoldableIndex
    if (staged?.parts?.length) {
      const endIndex = session.surface.nodes.indexOf(staged.summarized.end)
      if (endIndex < 0) {
        this.backgroundFolds.delete(agent)
        return this.planRolling(agent, forceHard)
      }
      options.firstFoldableIndex = endIndex + 1
    }
    if (!staged?.parts?.length && prefixEnd > systemEnd) {
      const depths = index => {
        if (index < systemEnd || index >= prefixEnd) return null
        const seq = session.surface.nodes[index]
        const marker = markerFromSummary(session.eventAt(seq).data.content)
        const node = marker && typeof session.id === 'string' && this.superLcmStore.getNode(session.id, marker.id)
        return node?.status === 'ready' ? nodeLevel(this.superLcmStore, session.id, marker.id) : null
      }
      const condensed = selectSummaryCondensation(priced.nodes, session.surface.nodes, depths, {
        ...policy, ...options, systemEnd, prefixEnd,
        isBalancedAfter: seq => toolPairingBalancedAfter(session, seq),
      })
      if (condensed) return condensed
    }
    const selection = selectRollingRange(priced.nodes, session.surface.nodes, options)
    if (selection) {
      const prepared = prepareAsyncRegion(this, agent, selection)
      // A few verbatim tokens cannot fit even an empty framed checkpoint.
      // Retain them explicitly and close the cycle at the last completed span,
      // rather than buying an impossible summary and blocking the whole draft.
      if (prepared.shadowedRouteTokenCount <= minimumCheckpointTokens(this, prepared.trustedChildNodeIds)) {
        if (staged?.parts?.length && staged.cutoffEnd !== undefined) staged.cutoffEnd = staged.summarized.end
        return null
      }
    }
    // At hard pressure, never reselect ranges already present in the assembled
    // draft. Otherwise the fallback blocks its own completed commit forever.
    if (staged?.parts?.length) return selection
    if (selection !== null || (!forceHard && measurement.totalTokens < policy.hardActiveTokens)) return selection
    if (options.firstFoldableIndex <= systemEnd) return null
    return selectRollingRange(priced.nodes, session.surface.nodes, { ...options, firstFoldableIndex: systemEnd })
  }

  async commitRollingSelection(agent, selection) {
    this.startBackgroundFold(agent, selection)
    return null
  }

  restoreDraft(agent) { return restoreDraft(this, agent) }

  async rollingMaintain(agent, _signal) {
    await resolvePolicy(this, agent, _signal)
    this.restoreDraft(agent)
    if (!this.canPrepareBackground(agent)) return null
    const selection = this.planRolling(agent)
    if (selection === null) return null
    this.startBackgroundFold(agent, selection)
    return null
  }

}

// 兼容旧版 SuperLcm、SuperLCM 与 dsh-lossless-context <= 0.2.x 的导出 / Compatibility exports for older SuperLcm, SuperLCM, and dsh-lossless-context <= 0.2.x.
export { SuperLcmCompactionEngine as SuperLCMCompactionEngine }
export { SuperLcmCompactionEngine as LosslessCompactionEngine }
export default SuperLcmCompactionEngine
