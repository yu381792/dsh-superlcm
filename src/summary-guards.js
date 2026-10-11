const keyOf = carrier => carrier?.session ?? carrier

// Existing callers can still use an Agent key; the underlying owner is always
// its Session, so two agents cannot buy two summaries for one selected span.
export class SessionFoldRegistry extends WeakMap {
  get(carrier) { return super.get(keyOf(carrier)) }
  has(carrier) { return super.has(keyOf(carrier)) }
  set(carrier, value) { super.set(keyOf(carrier), value); return this }
  delete(carrier) { return super.delete(keyOf(carrier)) }
}

function authFailure(error, seen = new Set()) {
  if (!error || seen.has(error)) return false
  seen.add(error)
  const status = error.status ?? error.statusCode ?? error.response?.status ?? error.failure?.status ?? error.failure?.statusCode
  const code = String(error.code || error.failure?.code || '')
  const text = code + ' ' + String(error.message || '')
  return status === 401 || status === 403
    || /^(AUTH(?:ENTICATION)?(?:_REQUIRED|_FAILED|_FAILURE|_ERROR)?|UNAUTHENTICATED|NO_API_KEY|INVALID_API_KEY|ACCOUNT_(?:BANNED|DEACTIVATED|DISABLED))$/i.test(code)
    || /(?:http|status|response)[\s:=_-]*(401|403)\b/i.test(text)
    || /authentication|unauthorized|forbidden|invalid.{0,20}(api.?key|token)|account.{0,30}(banned|blocked|disabled|deactivated|suspended)|账户.{0,12}(封禁|停用)/i.test(text)
    || authFailure(error.cause, seen) || (Array.isArray(error.errors) && error.errors.some(e => authFailure(e, seen)))
}

export class SummaryGuards {
  constructor(clock = Date.now) { this.clock = clock; this.routes = new Map(); this.sessions = new SessionFoldRegistry() }
  routeKey(route) { return JSON.stringify([route.provider, route.model]) }
  canTry(route) { return (this.routes.get(this.routeKey(route))?.retryAt ?? 0) <= this.clock() }
  unavailable(route) { const state=this.routes.get(this.routeKey(route));return state?.permanent===true&&state.retryAt>this.clock() }
  assertRoute(route) {
    if (this.canTry(route)) return
    const error = Error('摘要模型正在等待重试：' + route.provider + '/' + route.model)
    error.code = 'SUPERLCM_SUMMARY_COOLDOWN'; throw error
  }
  failedRoute(route, error, baseMs) {
    if (error?.code === 'SUPERLCM_SUMMARY_COOLDOWN') return
    const key = this.routeKey(route), failures = (this.routes.get(key)?.failures ?? 0) + 1
    const permanent = authFailure(error) || error?.code === 'QUOTA' || error?.summaryKind === 'quota'
    const delay = permanent ? Math.max(300000, baseMs) : Math.min(baseMs * 16, baseMs * 2 ** Math.min(4, failures - 1))
    this.routes.set(key, { failures, permanent, retryAt: this.clock() + delay })
  }
  succeededRoute(route) { this.routes.delete(this.routeKey(route)) }
  canStart(agent, fingerprint) {
    const state = this.sessions.get(agent)
    return !state || state.fingerprint !== fingerprint || state.retryAt <= this.clock()
  }
  failedSession(agent, fingerprint, baseMs) {
    const previous = this.sessions.get(agent)
    const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1
    this.sessions.set(agent, { fingerprint, failures, retryAt: this.clock() + Math.min(baseMs * 16, baseMs * 2 ** Math.min(4, failures - 1)) })
  }
  succeededSession(agent) { this.sessions.delete(agent) }
  clear() { this.routes.clear(); this.sessions = new SessionFoldRegistry() }
}
