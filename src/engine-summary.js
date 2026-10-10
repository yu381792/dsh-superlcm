import {summaryRangeNotice} from './summary-language.js'
import {dshSummaryLanguage} from './dsh-summary-language.js'
import { randomUUID } from 'node:crypto'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { cleanRoute, routeIsConfigured } from './engine-config.js'
import { appendRecallEnvelope } from './marker.js'
import { nativeSummaryTask } from './summary-task.js'
import { summaryCallContext } from './summary-session.js'
import { SUMMARY_SYSTEM, RECALL_POLICY, summaryInstructions, summaryClosing, checkedSummary } from '../src/summary-policy.js'
export async function summarizeWithRecall(engine,args) {
    const lease=engine.acquireSummary?.()
    try {
    await (lease?.ready||engine.summaryModelReady)
    const metadata = args[3] ?? nativeSummaryTask(engine,args[0],args[1])
    const task={...metadata?.summaryTask,language:dshSummaryLanguage(args[1].session,metadata?.summaryTask),requireHeading:true,maxChars:null}
    const children = Array.isArray(metadata?.trustedChildNodeIds)
      ? [...new Set(metadata.trustedChildNodeIds)]
      : []
    const summarizeArgs = args.slice(0, 3)
    const config=lease?.config||engine.config
    const primaryRoute = cleanRoute({
      provider: config?.summarizationProvider,
      model: config?.summarizationModel,
    })
    const fallbackRoute = cleanRoute(lease?.fallback||engine.fallbackSummarizationRoute)

    let qualityRetried=false
    const attempt = async (route) => {
      if (route) engine.summaryGuards.assertRoute(route)
      const receiver = route === null ? Object.create(engine) : Object.assign(Object.create(engine), {
        config: {
          ...config,
          summarizationProvider: route.provider,
          summarizationModel: route.model,
          modelPolicies: Array.isArray(config?.modelPolicies)
            ? config.modelPolicies.map((policy) => ({
                ...policy,
                summarizationProvider: route.provider,
                summarizationModel: route.model,
              }))
            : [],
        },
      })
      let result
      const modelContext=lease?.ctx||engine.summaryContext
      const ctx = modelContext && route?.provider === primaryRoute.provider ? modelContext : engine.ctx
      const input = summarizeArgs[0]
      const directive = SUMMARY_SYSTEM + '\n\n' + summaryInstructions(task)+'\n'+summaryClosing(task,'all preceding conversation messages')
      try {
        for(;;) {
          Object.defineProperty(receiver, 'ctx', { configurable:true, value: summaryCallContext(ctx, summarizeArgs[1].session.id, route, { input, directive:directive+(qualityRetried?'\nThe previous response failed language or heading validation. Follow the summary task and language; return a factual summary beginning with a heading.':'') }) })
          result = await BasicCompactionEngine.prototype.summarize.call(receiver, ...summarizeArgs)
          if (result === null || typeof result !== 'object' || !Array.isArray(result.summary)) {
            throw new TypeError('BasicCompactionEngine.summarize() returned an invalid summary result')
          }
          try {
            checkedSummary(result.summary.filter(block=>block.type==='text').map(block=>block.text).join('\n'),task)
            break
          } catch(error) {
            if(!error.summaryQuality||qualityRetried||summarizeArgs[2]?.aborted)throw error
            qualityRetried=true
          }
        }
        if (route) engine.summaryGuards.succeededRoute(route)
      } catch (error) {
        if (route && !summarizeArgs[2]?.aborted) engine.summaryGuards.failedRoute(route, error, engine.rollingConfig.summaryRetryCooldownMs)
        throw error
      }
      return result
    }

    let result
    try {
      result = await attempt(routeIsConfigured(primaryRoute) ? primaryRoute : null)
    } catch (primaryError) {
      const signal = summarizeArgs[2]
      if (signal?.aborted || !routeIsConfigured(fallbackRoute)) throw primaryError
      engine.ctx.logger?.warn?.(
        `primary summarization route ${primaryRoute.provider}/${primaryRoute.model} failed; retrying once with fallback ${fallbackRoute.provider}/${fallbackRoute.model}`,
      )
      try {
        result = await attempt(fallbackRoute)
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError
        throw new AggregateError(
          [primaryError, fallbackError],
          `primary and fallback summarization routes failed (${primaryRoute.provider}/${primaryRoute.model} -> ${fallbackRoute.provider}/${fallbackRoute.model})`,
        )
      }
    }

    // Native host owns the outer frame; put the consumer caution in the
    // returned body as well so its old established-background sentence cannot
    // make this historical snapshot look like a present user instruction.
    const summary = args[3] === undefined
      ? [...result.summary,{type:'text',text:summaryRangeNotice(task)}]
      : result.summary
    checkedSummary(summary.filter(b=>b.type==='text').map(b=>b.text).join('\n'),task)
    const nodeId = randomUUID()
    return {
      ...result,
      summary: appendRecallEnvelope(summary, { id: nodeId, children }),
    }
    } finally {lease?.release()}
}
