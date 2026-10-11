import {SessionFoldRegistry} from './summary-guards.js'

export function bindBackgroundCancellation(engine, agent, signal) {
    engine.backgroundRequestSignals ??= new SessionFoldRegistry()
    const previous = engine.backgroundRequestSignals.get(agent)
    if (previous?.signal === signal) return
    previous?.dispose()
    const cancel = () => {
      const state = engine.backgroundFolds.get(agent)
      engine.backgroundFolds.delete(agent)
      state?.controller?.abort(signal.reason ?? Error('请求已停止'))
      engine.superLcmStore.finishDraft(agent.session.id,'discarded')
      if (state) engine.compressionReporter.report(agent.session.id,'cancelled',state.selection)
    }
    signal.addEventListener('abort',cancel,{once:true})
    engine.backgroundRequestSignals.set(agent,{signal,dispose:()=>signal.removeEventListener('abort',cancel)})
    if (signal.aborted) cancel()
  }
