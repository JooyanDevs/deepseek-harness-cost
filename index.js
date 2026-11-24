/**
 * Chat cost meter — host half.
 *
 * One Session projection unit that folds the durable log's provider usage into
 * billed token buckets and prices them per provider route:
 *
 * - `deepseek-official` / `deepseek-account` are DeepSeek's own platform and use
 *   the DeepSeek CNY list rates (peak hours double, off-peak half).
 * - `opencode-go` is the OpenCode Go subscription and uses the USD list rates
 *   OpenCode publishes on its models endpoint, including that model's own peak
 *   multipliers.
 *
 * A Session that mixed both shows both currencies instead of converting one into
 * the other: a subscription allowance and a CNY wallet are different money, and
 * inventing an exchange rate would make the figures unauditable.
 *
 * The unit imports nothing, so a profile installed from a Git URL needs no
 * dependency resolution at all. Only `ctx.sessionProjections` is required; the
 * OpenCode allowance route is mounted separately when the Host has a web server.
 *
 * Accounting semantics mirror the harness's own `tokenUsage` unit:
 *   - `assistant/message` carries the settled attempt's usage; `assistant/attempt`
 *     may carry a streaming sample; a later sample for the same (turn, step)
 *     REPLACES the earlier one instead of adding to it.
 *   - `llm/retry-started` closes that replacement slot, so a retried attempt in
 *     the same step is billed again.
 *   - `request/context` names the route a request was sent to; the assistant
 *     message's own `source.model` / `source.provider` win when present.
 *
 * @module deepseek-harness-cost
 */

export const name = 'deepseek-harness-cost'

/** The projection registry and the credential seam this plugin depends on. */
export const inject = ['credentials', 'sessionProjections']

/** Projection key the browser half reads through `useProjection`. */
export const PROJECTION_KEY = 'chatCost'

const MTOK = 1_000_000
const BUCKETS = ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']

/**
 * DeepSeek list prices in CNY per 1M tokens at PEAK time
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing).
 * Off-peak is half of peak, so these are the base rates and the off-peak
 * multiplier is applied at pricing time. `deepseek-chat` and `deepseek-reasoner`
 * are the retired names that now serve V4.1-Flash, so they keep Flash rates.
 */
const DEFAULT_RATES = {
  'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
  'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 0, output: 13.5 },
  'deepseek-chat': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
  'deepseek-reasoner': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
}

const DEFAULT_MODEL = 'deepseek-flash'

/**
 * OpenCode Go list prices in USD per 1M tokens, copied from the live
 * `GET https://opencode.ai/zen/go/v1/models` on 2026-11-18. They are the offline
 * fallback: the Host refreshes the same endpoint hourly and the live table wins,
 * so a price change does not need a plugin release. `peakFactor` multiplies the
 * base prices inside the model's published peak windows (DeepSeek doubles there).
 */
const DEFAULT_USD_RATES = {
  'deepseek-v4.1-flash': {
    input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
    peakFactor: 2, peakDays: [1, 2, 3, 4, 5], peakWindowsUtc: [[1, 4], [6, 10]],
    monthly: { go: 100, 'go-plus': 200, 'go-teams': 105 },
  },
  'deepseek-v4-pro': {
    input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0,
    peakFactor: 2, peakDays: [1, 2, 3, 4, 5], peakWindowsUtc: [[1, 4], [6, 10]],
    monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 },
  },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0, monthly: { go: 500, 'go-plus': 1000, 'go-teams': 505 } },
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0, monthly: { go: 60, 'go-plus': 120, 'go-teams': 65 } },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'kimi-k3.1-pro': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'qwen3.8-max': { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2, monthly: { go: 30, 'go-plus': 120, 'go-teams': 35 } },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'minimax-m3.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
  'mimo-v2.6-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0, monthly: { go: 15, 'go-plus': 60, 'go-teams': 20 } },
}

const DEFAULT_USD_MODEL = 'deepseek-v4.1-flash'

/**
 * Which provider route bills with which currency.
 *
 * A missing provider in the log is priced as CNY: the meter predates provider
 * filtering, and hiding a Session because its log is too old to name a route
 * would silently lose numbers the plugin used to show. A provider that is named
 * but has no entry here is not priced at all — its usage is counted and reported
 * as excluded, because neither DeepSeek's CNY card nor OpenCode's USD card
 * describes a third gateway.
 */
const DEFAULT_ROUTES = {
  'deepseek-official': 'CNY',
  'deepseek-account': 'CNY',
  'opencode-go': 'USD',
  opencode: 'USD',
}

/**
 * Coerce a configuration number.
 * @param {unknown} value - raw config value.
 * @param {number} fallback - value used when the input is not a finite number.
 * @returns {number} the coerced value.
 */
function toNumber(value, fallback) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Read one peak window as `[startHour, endHour)`.
 * @param {unknown} value - candidate window from configuration.
 * @returns {{ start: number, end: number } | null} the normalized window.
 */
function toWindow(value) {
  const pair = Array.isArray(value) ? value : null
  if (pair === null || pair.length < 2) return null
  const start = toNumber(pair[0], Number.NaN)
  const end = toNumber(pair[1], Number.NaN)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > 24 || end > 24 || start >= end) return null
  return { start, end }
}

/**
 * Normalize one USD rate row over a base row.
 * @param {unknown} raw - configured row.
 * @param {object} base - fallback row.
 * @returns {object} the normalized row.
 */
function resolveUsdRate(raw, base) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const days = Array.isArray(source.peakDays)
    ? source.peakDays.map(day => toNumber(day, Number.NaN)).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : base.peakDays ?? []
  const windows = Array.isArray(source.peakWindowsUtc)
    ? source.peakWindowsUtc.map(toWindow).filter(window => window !== null).map(window => [window.start, window.end])
    : base.peakWindowsUtc ?? []
  const monthly = source.monthly !== null && typeof source.monthly === 'object'
    ? { ...base.monthly, ...source.monthly }
    : base.monthly
  const row = {
    input: toNumber(source.input, base.input),
    output: toNumber(source.output, base.output),
    cacheRead: toNumber(source.cacheRead, base.cacheRead),
    cacheWrite: toNumber(source.cacheWrite, base.cacheWrite),
    peakFactor: toNumber(source.peakFactor, base.peakFactor ?? 1),
  }
  if (days.length > 0) row.peakDays = days
  if (windows.length > 0) row.peakWindowsUtc = windows
  if (monthly !== undefined) row.monthly = monthly
  return row
}

/**
 * Normalize the configured USD rate table over the built-in defaults.
 * @param {unknown} raw - `config.usd.prices`.
 * @returns {Record<string, object>} rates per model id.
 */
function resolveUsdRates(raw) {
  const rates = {}
  for (const [model, row] of Object.entries(DEFAULT_USD_RATES)) rates[model] = { ...row }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return rates
  for (const [model, row] of Object.entries(raw)) {
    const id = typeof model === 'string' ? model.trim() : ''
    if (id === '' || row === null || typeof row !== 'object') continue
    // A known model inherits its own peak rule; an override for a new model
    // inherits the default price level but no peak rule, so a partial override
    // cannot silently double at DeepSeek's peak window.
    const base = rates[id] ?? {
      ...DEFAULT_USD_RATES[DEFAULT_USD_MODEL],
      peakFactor: 1,
      peakDays: [],
      peakWindowsUtc: [],
      monthly: undefined,
    }
    rates[id] = resolveUsdRate(row, base)
  }
  return rates
}

/**
 * Normalize the route → currency map.
 * @param {unknown} raw - `config.routes`.
 * @returns {Record<string, 'CNY' | 'USD'>} routes.
 */
function resolveRoutes(raw) {
  const routes = { ...DEFAULT_ROUTES }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return routes
  for (const [route, group] of Object.entries(raw)) {
    const name = typeof route === 'string' ? route.trim() : ''
    if (name === '') continue
    if (group === 'CNY' || group === 'USD') routes[name] = group
    else if (group === null) delete routes[name]
  }
  return routes
}

/**
 * A config path appended to `baseUrl`, or null.
 *
 * The value is concatenated onto the configured origin, so it must stay a path:
 * a value such as `@elsewhere.example/x` or `//elsewhere.example/x` would
 * re-target the request — and the Bearer credential with it.
 * @param {unknown} value - `config.usd.modelsPath` or one `usagePaths` entry.
 * @returns {string | null} the path, when it is origin-relative.
 */
function apiPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.startsWith('/') && !trimmed.startsWith('//') ? trimmed : null
}

/**
 * Normalize the OpenCode allowance options.
 * @param {unknown} raw - `config.usd`.
 * @returns {object} allowance settings.
 */
function resolveUsdOptions(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const usagePaths = Array.isArray(source.usagePaths)
    ? source.usagePaths.map(apiPath).filter(path => path !== null)
    : []
  const plan = source.plan === 'go-plus' || source.plan === 'go-teams' ? source.plan : 'go'
  const monthlyLimitUsd = toNumber(source.monthlyLimitUsd, Number.NaN)
  return {
    apiKeyRef: typeof source.apiKeyRef === 'string' && source.apiKeyRef !== '' ? source.apiKeyRef : 'OPENCODE_GO_API_KEY',
    baseUrl: typeof source.baseUrl === 'string' && /^https?:\/\//.test(source.baseUrl)
      ? source.baseUrl.replace(/\/+$/, '')
      : 'https://opencode.ai',
    modelsPath: apiPath(source.modelsPath) ?? '/zen/go/v1/models',
    usagePaths: usagePaths.length > 0 ? usagePaths : ['/zen/go/v1/usage', '/inference/go/v1/usage'],
    plan,
    quotaTtlSeconds: Math.max(5, Math.min(600, toNumber(source.quotaTtlSeconds, 30))),
    modelsTtlSeconds: Math.max(60, Math.min(86_400, toNumber(source.modelsTtlSeconds, 3_600))),
    requestTimeoutMs: Math.max(1_000, Math.min(60_000, toNumber(source.requestTimeoutMs, 10_000))),
    monthlyLimitUsd: Number.isFinite(monthlyLimitUsd) ? monthlyLimitUsd : null,
  }
}

/**
 * One settled settings object for the plugin instance.
 * @param {unknown} config - the Loader row's `config`.
 * @returns {object} normalized settings used by the fold and the view.
 */
export function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const rates = {}
  for (const [model, table] of Object.entries(DEFAULT_RATES)) rates[model] = { ...table }
  if (source.models !== null && typeof source.models === 'object' && !Array.isArray(source.models)) {
    for (const [model, table] of Object.entries(source.models)) {
      const name = typeof model === 'string' ? model.trim() : ''
      if (name === '' || table === null || typeof table !== 'object') continue
      const base = rates[name] ?? rates[DEFAULT_MODEL] ?? DEFAULT_RATES[DEFAULT_MODEL]
      rates[name] = {
        cacheHit: toNumber(table.cacheHit, base.cacheHit),
        cacheMiss: toNumber(table.cacheMiss, base.cacheMiss),
        cacheWrite: toNumber(table.cacheWrite, base.cacheWrite),
        output: toNumber(table.output, base.output),
      }
    }
  }
  const defaultModel = typeof source.defaultModel === 'string' && Object.hasOwn(rates, source.defaultModel)
    ? source.defaultModel
    : DEFAULT_MODEL
  const peak = source.peak !== null && typeof source.peak === 'object' ? source.peak : {}
  const windows = Array.isArray(peak.windows)
    ? peak.windows.map(toWindow).filter(window => window !== null)
    : []
  const days = Array.isArray(peak.days)
    ? peak.days.map(day => toNumber(day, Number.NaN)).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : []
  const holidays = Array.isArray(peak.holidays)
    ? peak.holidays.filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : []
  const ratio = toNumber(source.offPeakRatio, 0.5)
  const usd = resolveUsdOptions(source.usd)
  usd.rates = resolveUsdRates(usdSource(source)?.prices)
  usd.defaultModel = typeof usdSource(source)?.defaultModel === 'string'
    && Object.hasOwn(usd.rates, usdSource(source).defaultModel)
    ? usdSource(source).defaultModel
    : DEFAULT_USD_MODEL
  return {
    rates,
    defaultModel,
    routes: resolveRoutes(source.routes),
    peakMode: source.peakMode === 'peak' || source.peakMode === 'off-peak' ? source.peakMode : 'auto',
    offPeakRatio: ratio > 1 ? 1 : ratio,
    peak: {
      timezoneOffsetMinutes: Math.max(-840, Math.min(840, toNumber(peak.timezoneOffsetMinutes, 480))),
      days: days.length > 0 ? days : [1, 2, 3, 4, 5],
      windows: windows.length > 0 ? windows : [{ start: 9, end: 12 }, { start: 14, end: 18 }],
      holidays,
    },
    usd,
  }
}

/**
 * The raw `config.usd` object, or undefined.
 * @param {object} source - plugin config.
 * @returns {any} raw USD config.
 */
function usdSource(source) {
  return source.usd !== null && typeof source.usd === 'object' ? source.usd : undefined
}

/**
 * The currency group a provider route bills in.
 *
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {string | null | undefined} provider - route id from the log, if any.
 * @returns {'CNY' | 'USD' | null} the priced group, or null when no card covers it.
 */
export function groupOf(settings, provider) {
  if (typeof provider !== 'string' || provider === '') return 'CNY'
  return Object.hasOwn(settings.routes, provider) ? settings.routes[provider] : null
}

/**
 * Whether a moment bills at DeepSeek's CNY peak rates.
 *
 * Peak is Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time (UTC+8, no DST).
 * Statutory holidays are not derivable from a calendar rule, so they come from
 * configuration; a holiday date moves that whole day to off-peak.
 *
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {number} timeMs - event time from the session log.
 * @returns {boolean} true when the sample bills at peak rates.
 */
export function isPeak(settings, timeMs) {
  if (settings.peakMode === 'peak') return true
  if (settings.peakMode === 'off-peak') return false
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false
  const { timezoneOffsetMinutes, days, windows, holidays } = settings.peak
  const local = new Date(timeMs + timezoneOffsetMinutes * 60_000)
  if (!days.includes(local.getUTCDay())) return false
  const date = `${String(local.getUTCFullYear()).padStart(4, '0')}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`
  if (holidays.includes(date)) return false
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60
  return windows.some(window => hour >= window.start && hour < window.end)
}

/**
 * Whether an instant falls inside a USD model's published peak window.
 * @param {any} rate - one USD rate row.
 * @param {number} timeMs - event time.
 * @returns {boolean} true when the multiplier applies.
 */
export function isPeakUsd(rate, timeMs) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false
  if (rate === null || typeof rate !== 'object') return false
  if (!(toNumber(rate.peakFactor, 1) > 1)) return false
  const days = Array.isArray(rate.peakDays) ? rate.peakDays : []
  const windows = Array.isArray(rate.peakWindowsUtc) ? rate.peakWindowsUtc : []
  if (days.length === 0 || windows.length === 0) return false
  const date = new Date(timeMs)
  if (!days.includes(date.getUTCDay())) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return windows.some(window => hour >= window[0] && hour < window[1])
}

/** @returns {{ cacheMiss: number, cacheHit: number, cacheWrite: number, output: number }} zero buckets. */
function zeroBuckets() {
  return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }
}

/**
 * Read a finite non-negative count, defaulting to zero.
 * @param {unknown} value - raw count.
 * @returns {number} the count.
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The billing buckets of one provider usage record.
 * @param {any} usage - `TokenUsage`-shaped record from a session event.
 * @returns {{ cacheMiss: number, cacheHit: number, cacheWrite: number, output: number }} buckets.
 */
function bucketsOf(usage) {
  return {
    cacheMiss: count(usage.inputTokens),
    cacheHit: count(usage.cacheReadTokens),
    cacheWrite: count(usage.cacheWriteTokens),
    output: count(usage.outputTokens),
  }
}

/**
 * Whether every bucket is zero.
 * @param {ReturnType<typeof zeroBuckets>} buckets - buckets.
 * @returns {boolean} true when nothing was billed.
 */
function isZero(buckets) {
  return BUCKETS.every(key => buckets[key] === 0)
}

/**
 * Whether two bucket records are identical.
 * @param {ReturnType<typeof zeroBuckets>} left - buckets.
 * @param {ReturnType<typeof zeroBuckets>} right - buckets.
 * @returns {boolean} true when equal.
 */
function sameBuckets(left, right) {
  return BUCKETS.every(key => left[key] === right[key])
}

/**
 * The token count of one bucket record.
 * @param {ReturnType<typeof zeroBuckets>} buckets - buckets.
 * @returns {number} every billed token.
 */
function totalOf(buckets) {
  return buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite + buckets.output
}

/**
 * The last `usage` chunk of an attempt's embedded stream.
 * @param {unknown} stream - `AssistantStreamRecord[]`.
 * @returns {any} the usage record, or undefined.
 */
function lastUsageInStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object' || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/**
 * Provider usage one event reports for its attempt.
 * @param {any} event - session event.
 * @returns {any} the usage record, or undefined.
 */
function usageOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message') {
    if (data.usage !== undefined && data.usage !== null) return data.usage
  }
  return lastUsageInStream(data.stream)
}

/**
 * A route label worth storing, or undefined.
 * @param {unknown} value - candidate model name.
 * @returns {string | undefined} trimmed name.
 */
function modelOf(value) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name === '' ? undefined : name
}

/**
 * The route a Session event names, if it names one.
 *
 * `request/context` is written once per request (and only when something about
 * it changed), so it is the durable route record; an Assistant message carries
 * the same pair on its own `source`, which is the winner when both exist.
 *
 * @param {any} event - session event.
 * @returns {{ model: string | undefined, provider: string | undefined }} route fields.
 */
function routeOf(event) {
  if (event.type === 'request/context') {
    return { model: modelOf(event.data?.model), provider: modelOf(event.data?.provider) }
  }
  if (event.type === 'assistant/message') {
    const source = event.data?.message?.source
    return { model: modelOf(source?.model), provider: modelOf(source?.provider) }
  }
  return { model: undefined, provider: undefined }
}

/**
 * Add or subtract one bucket record in the per-group, per-model table, never
 * going below 0.
 *
 * @param {Record<string, any>} models - current table.
 * @param {'CNY' | 'USD'} group - currency group.
 * @param {string} model - model id.
 * @param {'peak' | 'off'} slot - billing class.
 * @param {ReturnType<typeof zeroBuckets>} buckets - amounts.
 * @param {number} sign - 1 to add, -1 to subtract.
 * @returns {Record<string, any>} the next table.
 */
function shift(models, group, model, slot, buckets, sign) {
  const key = `${group}:${model}`
  const entry = models[key] ?? { group, model, peak: zeroBuckets(), off: zeroBuckets() }
  const current = entry[slot] ?? zeroBuckets()
  const next = {}
  for (const name of BUCKETS) next[name] = Math.max(0, current[name] + sign * buckets[name])
  return { ...models, [key]: { ...entry, [slot]: next } }
}

/**
 * Build the projection definition for one settings object.
 *
 * State is plain JSON and version-gated: token buckets per currency group,
 * model and billing class, the route the Session is on, the count of requests
 * left out because no rate card describes their provider, plus the replacement
 * slot the fold needs. Prices are NOT in the state, so re-pricing (including a
 * refreshed OpenCode rate table) never invalidates a checkpoint; the view prices
 * it on read.
 *
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {{ current: Record<string, any> }} ratesRef - live USD rates.
 * @returns {object} a `ProjectionDefinition` value.
 */
export function buildDefinition(settings, ratesRef) {
  const usdRates = () => ratesRef?.current ?? settings.usd.rates
  return {
    key: PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: {
      parse(value) {
        const source = value !== null && typeof value === 'object' ? value : {}
        const models = {}
        const table = source.models !== null && typeof source.models === 'object' ? source.models : {}
        for (const entry of Object.values(table)) {
          if (entry === null || typeof entry !== 'object') continue
          const group = entry.group === 'USD' ? 'USD' : entry.group === 'CNY' ? 'CNY' : null
          const model = modelOf(entry.model)
          if (group === null || model === undefined) continue
          const slot = {}
          for (const cls of ['peak', 'off']) {
            const buckets = entry[cls] !== null && typeof entry[cls] === 'object' ? entry[cls] : {}
            slot[cls] = {
              cacheMiss: count(buckets.cacheMiss),
              cacheHit: count(buckets.cacheHit),
              cacheWrite: count(buckets.cacheWrite),
              output: count(buckets.output),
            }
          }
          models[`${group}:${model}`] = { group, model, peak: slot.peak, off: slot.off }
        }
        const requests = source.requests !== null && typeof source.requests === 'object' ? source.requests : {}
        const excluded = source.excluded !== null && typeof source.excluded === 'object' ? source.excluded : {}
        const last = source.last !== null && typeof source.last === 'object' ? source.last : null
        const lastGroup = last?.group === 'USD' ? 'USD' : last?.group === 'CNY' ? 'CNY' : null
        return {
          models,
          model: modelOf(source.model) ?? null,
          provider: modelOf(source.provider) ?? null,
          group: source.group === 'USD' ? 'USD' : 'CNY',
          requests: { CNY: count(requests.CNY), USD: count(requests.USD) },
          excluded: { requests: count(excluded.requests), tokens: count(excluded.tokens) },
          last: last === null || typeof last.turn !== 'number' || typeof last.step !== 'number'
            ? null
            : {
              turn: last.turn,
              step: last.step,
              key: lastGroup === null || modelOf(last.model) === undefined ? null : `${lastGroup}:${modelOf(last.model)}`,
              group: lastGroup,
              model: modelOf(last.model) ?? settings.defaultModel,
              cls: last.cls === 'off' ? 'off' : 'peak',
              buckets: {
                cacheMiss: count(last.buckets?.cacheMiss),
                cacheHit: count(last.buckets?.cacheHit),
                cacheWrite: count(last.buckets?.cacheWrite),
                output: count(last.buckets?.output),
              },
            },
        }
      },
    },
    init: () => ({
      models: {},
      model: null,
      provider: null,
      group: 'CNY',
      requests: { CNY: 0, USD: 0 },
      excluded: { requests: 0, tokens: 0 },
      last: null,
    }),
    apply: (state, event) => {
      switch (event.type) {
        case 'request/context':
        case 'assistant/message':
        case 'assistant/attempt': {
          const route = routeOf(event)
          let base = state
          if (route.model !== undefined && route.model !== base.model) base = { ...base, model: route.model }
          if (route.provider !== undefined) {
            const group = groupOf(settings, route.provider)
            const next = group ?? null
            if (base.provider !== route.provider) base = { ...base, provider: route.provider }
            if (base.group !== next) base = { ...base, group: next }
          }
          if (event.type === 'request/context') return base
          const usage = usageOf(event)
          if (usage === undefined) return base
          const buckets = bucketsOf(usage)
          if (isZero(buckets)) return base
          const { turn, step } = event.data ?? {}
          if (typeof turn !== 'number' || typeof step !== 'number') return base
          const group = base.group === 'USD' ? 'USD' : base.group === null ? null : 'CNY'
          const model = base.model ?? (group === 'USD' ? settings.usd.defaultModel : settings.defaultModel)
          const slot = group === 'USD'
            ? (isPeakUsd(usdRates()[model] ?? usdRates()[settings.usd.defaultModel], event.time) ? 'peak' : 'off')
            : (isPeak(settings, event.time) ? 'peak' : 'off')
          const key = group === null ? null : `${group}:${model}`
          const previous = base.last !== null && base.last.turn === turn && base.last.step === step
            ? base.last
            : null
          if (previous !== null
            && previous.key === key
            && previous.cls === slot
            && sameBuckets(previous.buckets, buckets)) {
            return base
          }
          let models = base.models
          const requests = { ...base.requests }
          const excluded = { ...base.excluded }
          if (previous !== null) {
            if (previous.key !== null && previous.group !== null) {
              models = shift(models, previous.group, previous.model, previous.cls, previous.buckets, -1)
              requests[previous.group] = Math.max(0, requests[previous.group] - 1)
            } else {
              excluded.requests = Math.max(0, excluded.requests - 1)
              excluded.tokens = Math.max(0, excluded.tokens - totalOf(previous.buckets))
            }
          }
          if (key !== null && group !== null) {
            models = shift(models, group, model, slot, buckets, 1)
            requests[group] += 1
          } else {
            excluded.requests += 1
            excluded.tokens += totalOf(buckets)
          }
          return {
            ...base,
            models,
            requests,
            excluded,
            last: { turn, step, key, group, model, cls: slot, buckets },
          }
        }
        case 'llm/retry-started': {
          const last = state.last
          const same = last !== null && last.turn === event.data?.turn && last.step === event.data?.step
          return same ? { ...state, last: null } : state
        }
        default:
          return state
      }
    },
    wire: {
      viewSchema: {
        parse(value) {
          return value
        },
      },
      view: state => viewOf(state, settings, usdRates()),
      // Carried on Session list rows so the browser half can price a child
      // Session without opening it (a subagent's cost arrives through its row).
      summary: true,
    },
  }
}

/**
 * Price one bucket record with a CNY rate row.
 * @param {any} rates - CNY per 1M tokens at peak.
 * @param {ReturnType<typeof zeroBuckets>} buckets - token buckets.
 * @param {number} ratio - off-peak multiplier.
 * @param {boolean} offPeak - whether this record bills off-peak.
 * @returns {number} CNY.
 */
function priceCny(rates, buckets, ratio, offPeak) {
  const peak = (
    buckets.cacheMiss * rates.cacheMiss
    + buckets.cacheHit * rates.cacheHit
    + buckets.cacheWrite * rates.cacheWrite
    + buckets.output * rates.output
  ) / MTOK
  return offPeak ? peak * ratio : peak
}

/**
 * Price one bucket record with a USD rate row.
 * @param {any} rate - USD per 1M tokens at base price.
 * @param {ReturnType<typeof zeroBuckets>} buckets - token buckets.
 * @param {boolean} peak - whether the model's peak multiplier applies.
 * @returns {number} USD.
 */
function priceUsd(rate, buckets, peak) {
  const base = (
    buckets.cacheMiss * rate.input
    + buckets.cacheHit * rate.cacheRead
    + buckets.cacheWrite * rate.cacheWrite
    + buckets.output * rate.output
  ) / MTOK
  return peak ? base * toNumber(rate.peakFactor, 1) : base
}

/**
 * Price one CNY bucket record as if no input had been cached.
 * @param {any} rates - CNY per 1M tokens at peak.
 * @param {ReturnType<typeof zeroBuckets>} buckets - token buckets.
 * @param {number} ratio - off-peak multiplier.
 * @param {boolean} offPeak - whether this record bills off-peak.
 * @returns {number} CNY.
 */
function priceCnyWithoutCache(rates, buckets, ratio, offPeak) {
  const prompt = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite
  const peak = (prompt * rates.cacheMiss + buckets.output * rates.output) / MTOK
  return offPeak ? peak * ratio : peak
}

/**
 * Price one USD bucket record as if no input had been cached.
 * @param {any} rate - USD per 1M tokens at base price.
 * @param {ReturnType<typeof zeroBuckets>} buckets - token buckets.
 * @param {boolean} peak - whether the model's peak multiplier applies.
 * @returns {number} USD.
 */
function priceUsdWithoutCache(rate, buckets, peak) {
  const prompt = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite
  const base = (prompt * rate.input + buckets.output * rate.output) / MTOK
  return peak ? base * toNumber(rate.peakFactor, 1) : base
}

/**
 * The client-facing value: one priced block per currency the Session actually
 * used, plus what was left out.
 *
 * Each block's `per1k` is one blended number: everything that block paid divided
 * by every token the provider reported in it. It is a realized average, so a
 * chat with heavy cache reuse shows a lower rate than the price sheet's cache-miss
 * row — and `cacheSaving` states the difference so the low number is
 * explainable.
 *
 * @param {any} state - fold state.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {Record<string, any>} [rates] - live USD rates, when available.
 * @returns {object} the wire view.
 */
export function viewOf(state, settings, rates) {
  const usdRates = rates ?? settings.usd.rates
  const groups = {}
  for (const entry of Object.values(state.models ?? {})) {
    if (entry === null || typeof entry !== 'object') continue
    const group = entry.group === 'USD' ? 'USD' : entry.group === 'CNY' ? 'CNY' : null
    if (group === null) continue
    const buckets = zeroBuckets()
    for (const key of BUCKETS) buckets[key] = entry.peak[key] + entry.off[key]
    // A replaced sample can leave an empty row behind; it is not a billed route.
    if (isZero(buckets)) continue
    const model = entry.model
    const known = group === 'CNY'
      ? Object.hasOwn(settings.rates, model)
      : Object.hasOwn(usdRates, model)
    const acc = groups[group] ?? {
      code: group,
      requests: state.requests?.[group] ?? 0,
      total: 0,
      peak: 0,
      offPeak: 0,
      cacheSaving: 0,
      estimated: false,
      tokens: zeroBuckets(),
      models: [],
    }
    groups[group] = acc
    if (!known) acc.estimated = true
    let modelPeak
    let modelOff
    let baseline
    if (group === 'CNY') {
      const row = known ? settings.rates[model] : settings.rates[settings.defaultModel]
      modelPeak = priceCny(row, entry.peak, settings.offPeakRatio, false)
      modelOff = priceCny(row, entry.off, settings.offPeakRatio, true)
      baseline = priceCnyWithoutCache(row, entry.peak, settings.offPeakRatio, false)
        + priceCnyWithoutCache(row, entry.off, settings.offPeakRatio, true)
    } else {
      const row = known ? usdRates[model] : usdRates[settings.usd.defaultModel]
      modelPeak = priceUsd(row, entry.peak, true)
      modelOff = priceUsd(row, entry.off, false)
      baseline = priceUsdWithoutCache(row, entry.peak, true)
        + priceUsdWithoutCache(row, entry.off, false)
    }
    for (const key of BUCKETS) acc.tokens[key] += buckets[key]
    acc.total += modelPeak + modelOff
    acc.peak += modelPeak
    acc.offPeak += modelOff
    acc.cacheSaving += Math.max(0, baseline - (modelPeak + modelOff))
    acc.models.push({
      model,
      known,
      total: modelPeak + modelOff,
      peak: modelPeak,
      offPeak: modelOff,
      tokens: buckets,
    })
  }
  for (const acc of Object.values(groups)) {
    acc.models.sort((left, right) => right.total - left.total)
    const billedInput = acc.tokens.cacheMiss + acc.tokens.cacheHit + acc.tokens.cacheWrite
    const tokensTotal = billedInput + acc.tokens.output
    acc.tokens.total = tokensTotal
    acc.cacheHitPercent = billedInput > 0 ? (acc.tokens.cacheHit / billedInput) * 100 : null
    // One blended rate over every reported token: the single figure the pill
    // shows beside the total. Null rather than 0 while nothing has been billed,
    // so the client can leave the reading out instead of printing a zero rate.
    acc.per1k = tokensTotal > 0 ? (acc.total / tokensTotal) * 1000 : null
    acc.per1m = tokensTotal > 0 ? (acc.total / tokensTotal) * MTOK : null
  }
  const excluded = state.excluded !== null && typeof state.excluded === 'object' ? state.excluded : {}
  return {
    groups,
    excluded: { requests: count(excluded.requests), tokens: count(excluded.tokens) },
    model: state.model ?? null,
    provider: state.provider ?? null,
    usdPlan: settings.usd.plan,
  }
}

/**
 * Normalize the OpenCode allowance reply.
 *
 * The live endpoint answers `{ usage: { rolling, weekly, monthly } }`, each with
 * `{ status, percent, resetsAt }`. `percent` is the share of that window already
 * used; the browser shows it as-is (and may show `100 - percent` as remaining).
 *
 * @param {unknown} body - decoded JSON.
 * @returns {{ rolling: object | null, weekly: object | null, monthly: object | null }} windows.
 */
export function normalizeUsage(body) {
  const windows = { rolling: null, weekly: null, monthly: null }
  const container = body !== null && typeof body === 'object' && body.usage !== null && typeof body.usage === 'object'
    ? body.usage
    : body
  if (container === null || typeof container !== 'object') return windows
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const raw = container[key]
    if (raw === null || typeof raw !== 'object') continue
    const percent = toNumber(raw.percent, Number.NaN)
    windows[key] = {
      status: typeof raw.status === 'string' ? raw.status.slice(0, 64) : null,
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      resetsAt: typeof raw.resetsAt === 'string'
        ? raw.resetsAt
        : (typeof raw.resets_at === 'string' ? raw.resets_at : null),
    }
  }
  return windows
}

/**
 * Build USD rates from the OpenCode models reply.
 *
 * Keeps the published per-million prices, the cache read/write prices, the first
 * peak multiplier (DeepSeek is the only model family with one), and the monthly
 * usage table per plan. A model without a `cost.text` block is skipped and keeps
 * its built-in fallback.
 *
 * @param {unknown} body - `GET <base>/models` reply.
 * @returns {Record<string, any>} rates per model id.
 */
export function ratesFromModels(body) {
  const rates = {}
  const list = body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : []
  for (const model of list) {
    if (model === null || typeof model !== 'object') continue
    const id = modelOf(model.id)
    const text = model.cost?.text
    if (id === undefined || text === null || typeof text !== 'object') continue
    const row = {
      input: toNumber(text.input?.price, 0),
      output: toNumber(text.output?.price, 0),
      cacheRead: toNumber(text.input?.cache?.read, 0),
      cacheWrite: toNumber(text.input?.cache?.write, 0),
      peakFactor: 1,
    }
    const multiplier = Array.isArray(model.cost?.multipliers) && model.cost.multipliers.length > 0
      ? model.cost.multipliers[0]
      : null
    const factor = toNumber(multiplier?.factor, 1)
    if (multiplier !== null && factor > 1) {
      const rule = peakRuleOf(multiplier.when)
      row.peakFactor = factor
      if (rule.days.length > 0) row.peakDays = rule.days
      if (rule.windows.length > 0) row.peakWindowsUtc = rule.windows
    }
    const monthly = model.go?.monthly_usage
    if (monthly !== null && typeof monthly === 'object') row.monthly = monthly
    rates[id] = row
  }
  return rates
}

/**
 * Read the day/hour predicates of one multiplier `when` block.
 * @param {unknown} when - multiplier condition.
 * @returns {{ days: number[], windows: number[][] }} normalized rule.
 */
function peakRuleOf(when) {
  const days = []
  const windows = []
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const readDays = predicate => {
    const list = predicate?.utc_days?.in
    if (!Array.isArray(list)) return
    for (const name of list) {
      const index = dayNames.indexOf(String(name).toLowerCase())
      if (index >= 0 && !days.includes(index)) days.push(index)
    }
  }
  // One `all` group splits the window across predicates (`gte` in one, `lt` in
  // the next), so the bounds are collected across the whole group.
  const readGroup = group => {
    readDays(group)
    const predicates = Array.isArray(group?.all) ? group.all : [group]
    let start = null
    let end = null
    for (const predicate of predicates) {
      if (predicate === null || typeof predicate !== 'object') continue
      const hours = predicate.utc_hours
      if (hours === null || typeof hours !== 'object') continue
      const from = clockHour(hours.gte)
      const to = clockHour(hours.lt)
      if (from !== null) start = start === null ? from : Math.max(start, from)
      if (to !== null) end = end === null ? to : Math.min(end, to)
    }
    if (start !== null && end !== null && start < end) windows.push([start, end])
  }
  if (when === null || typeof when !== 'object') return { days, windows }
  readDays(when)
  if (Array.isArray(when.any)) {
    for (const clause of when.any) readGroup(clause)
  } else {
    readGroup(when)
  }
  return { days, windows }
}

/**
 * Parse `HH:MM` (or `HH`) into a decimal hour.
 * @param {unknown} value - clock string.
 * @returns {number | null} decimal hour.
 */
function clockHour(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 24 || minute > 59) return null
  return hour + minute / 60
}

/**
 * Send a JSON reply through the Host web server.
 * @param {any} response - raw response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 * @returns {void}
 */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

const API_PREFIX = '/chat-cost/api'

/** Allowance shares of the monthly limit published by OpenCode Go. */
const WINDOW_SHARES = { rolling: 0.2, weekly: 0.5, monthly: 1 }

/**
 * Attach the plan's window limits to the raw allowance percentages.
 *
 * OpenCode publishes the monthly dollar limit per model and states that the
 * 5-hour window is 20% of it and the weekly window 50%. The usage endpoint
 * reports the used share of each window; this adds the matching window limit so
 * the panel can explain what a percentage is a percentage of. It deliberately
 * does not convert the rounded percentage back into a dollar amount: the plan
 * tier is not part of the reply, and a derived figure would look more precise
 * than the endpoint is.
 *
 * @param {ReturnType<typeof normalizeUsage>} windows - raw windows.
 * @param {number | null} monthlyLimitUsd - plan limit for the model, when known.
 * @returns {Record<string, any>} windows with `share` and `limitUsd`.
 */
export function estimateWindows(windows, monthlyLimitUsd) {
  const out = {}
  for (const key of ['rolling', 'weekly', 'monthly']) {
    const raw = windows?.[key] ?? null
    if (raw === null) {
      out[key] = null
      continue
    }
    const share = WINDOW_SHARES[key]
    out[key] = {
      status: raw.status,
      percent: raw.percent,
      resetsAt: raw.resetsAt,
      share,
      limitUsd: monthlyLimitUsd === null ? null : monthlyLimitUsd * share,
    }
  }
  return out
}

/** Cap on one upstream reply, so a broken origin cannot exhaust Host memory. */
const MAX_REPLY_BYTES = 1 << 20

/**
 * Read a reply body up to `maxBytes`.
 * @param {Response} response - fetch reply.
 * @param {number} maxBytes - byte cap.
 * @returns {Promise<string | null>} text, or null when the reply is larger.
 */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (response.body === null) return await response.text()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One bounded failure label for a thrown fetch or parse error.
 * @param {unknown} error - thrown value.
 * @returns {string} label.
 */
function failureText(error) {
  return `request-failed: ${String(error?.message ?? error).slice(0, 200)}`
}

/**
 * Fetch helper with one timeout and one reply cap.
 * @param {string} url - absolute URL.
 * @param {string} key - bearer credential.
 * @param {number} timeoutMs - request timeout.
 * @returns {Promise<{ ok: boolean, status: number, body: any }>} decoded reply.
 */
async function fetchJson(url, key, timeoutMs) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      'user-agent': 'deepseek-harness-cost/1.4',
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await readCapped(response, MAX_REPLY_BYTES)
  if (text === null) return { ok: false, status: response.status, body: null }
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

/**
 * Live OpenCode allowance and rate cache.
 *
 * Nothing here touches a model request: the usage endpoint is a plain account
 * read, and the models endpoint is a public price sheet. The credit lives on the
 * Host, resolves per call (so a Settings change applies on the next poll), and is
 * never sent to the browser.
 *
 * @param {any} ctx - plugin context.
 * @param {ReturnType<typeof resolveSettings>} settings - resolved settings.
 * @param {{ current: Record<string, any> }} ratesRef - live USD rates.
 * @returns {object} the runtime.
 */
function createRuntime(ctx, settings, ratesRef) {
  const options = settings.usd
  const live = {
    modelsAt: 0,
    modelsError: null,
    modelsInFlight: null,
    quota: null,
    quotaAt: 0,
    quotaError: null,
    quotaInFlight: null,
  }

  async function resolveKey() {
    try {
      const service = ctx.credentials ?? ctx.get?.('credentials')
      if (service === undefined || typeof service.resolve !== 'function') return undefined
      const resolved = await service.resolve(options.apiKeyRef)
      return typeof resolved?.value === 'string' && resolved.value.length > 0 ? resolved.value : undefined
    } catch {
      return undefined
    }
  }

  async function refreshModels(force = false) {
    const now = Date.now()
    if (!force && live.modelsAt > 0 && now - live.modelsAt < options.modelsTtlSeconds * 1_000) return
    if (live.modelsInFlight !== undefined && live.modelsInFlight !== null) return live.modelsInFlight
    live.modelsInFlight = (async () => {
      const key = await resolveKey()
      if (key === undefined) {
        live.modelsAt = Date.now()
        live.modelsError = 'missing-key'
        return
      }
      try {
        const reply = await fetchJson(`${options.baseUrl}${options.modelsPath}`, key, options.requestTimeoutMs)
        if (!reply.ok) {
          live.modelsError = `http-${reply.status}`
          live.modelsAt = Date.now()
          return
        }
        const rates = ratesFromModels(reply.body)
        if (Object.keys(rates).length > 0) {
          // The live table wins, the built-in rows fill models the endpoint did
          // not return (and keep a price for a model that was delisted).
          ratesRef.current = { ...settings.usd.rates, ...rates }
          live.modelsError = null
        } else {
          live.modelsError = 'empty-model-list'
        }
      } catch (error) {
        live.modelsError = failureText(error)
      } finally {
        live.modelsAt = Date.now()
      }
    })()
    try {
      return await live.modelsInFlight
    } finally {
      live.modelsInFlight = null
    }
  }

  async function fetchQuota(force = false) {
    const now = Date.now()
    if (!force && live.quota !== null && now - live.quotaAt < options.quotaTtlSeconds * 1_000) {
      return { ...live.quota, stale: now - live.quotaAt > options.quotaTtlSeconds * 1_000 }
    }
    if (live.quotaInFlight !== undefined && live.quotaInFlight !== null) return live.quotaInFlight
    live.quotaInFlight = (async () => {
      const key = await resolveKey()
      if (key === undefined) {
        live.quota = { ok: false, at: Date.now(), hasKey: false, windows: normalizeUsage(null), error: 'missing-key' }
        live.quotaAt = Date.now()
        live.quotaError = 'missing-key'
        return live.quota
      }
      let lastError = 'unavailable'
      for (const path of options.usagePaths) {
        try {
          const reply = await fetchJson(`${options.baseUrl}${path}`, key, options.requestTimeoutMs)
          if (reply.status === 401 || reply.status === 403) {
            lastError = `key-rejected-${reply.status}`
            break
          }
          if (!reply.ok) {
            lastError = `http-${reply.status}`
            continue
          }
          const windows = normalizeUsage(reply.body)
          if (windows.rolling === null && windows.weekly === null && windows.monthly === null) {
            lastError = 'unrecognized-usage-shape'
            continue
          }
          live.quota = { ok: true, at: Date.now(), hasKey: true, endpoint: `${options.baseUrl}${path}`, windows }
          live.quotaAt = Date.now()
          live.quotaError = null
          return live.quota
        } catch (error) {
          lastError = failureText(error)
        }
      }
      if (live.quota?.ok === true) {
        live.quotaError = lastError
        live.quota = { ...live.quota, at: Date.now(), stale: true }
      } else {
        live.quota = { ok: false, at: Date.now(), hasKey: true, windows: normalizeUsage(null), error: lastError }
        live.quotaAt = Date.now()
        live.quotaError = lastError
      }
      return live.quota
    })()
    try {
      return await live.quotaInFlight
    } finally {
      live.quotaInFlight = null
    }
  }

  /**
   * The allowance reply for one model: raw percentages plus the plan's window
   * limits.
   * @param {string} model - model id.
   * @returns {object} quota view.
   */
  function quotaView(model) {
    const id = typeof model === 'string' && model !== '' ? model : settings.usd.defaultModel
    const rate = ratesRef.current?.[id]
    const monthlyLimit = options.monthlyLimitUsd
      ?? (rate?.monthly !== null && typeof rate?.monthly === 'object' ? rate.monthly[options.plan] : undefined)
    const limit = typeof monthlyLimit === 'number' && Number.isFinite(monthlyLimit) ? monthlyLimit : null
    return {
      ok: live.quota?.ok === true,
      stale: live.quota?.stale === true,
      hasKey: live.quota?.hasKey !== false,
      error: live.quota?.error ?? live.quotaError,
      fetchedAt: live.quota?.at ?? null,
      endpoint: live.quota?.endpoint ?? null,
      plan: options.plan,
      model: id,
      monthlyLimitUsd: limit,
      windows: estimateWindows(live.quota?.windows ?? null, limit),
      ratesLive: live.modelsAt > 0 && live.modelsError === null,
      ratesError: live.modelsError,
    }
  }

  /**
   * Mount the browser route on the Host web server.
   * @param {any} scope - context carrying webServer and connection.
   * @returns {void}
   */
  function registerRoutes(scope) {
    const webServer = scope.get('webServer') ?? scope.webServer
    const connection = scope.get('connection') ?? scope.connection
    // Fail closed: this route serves account data, so it only exists behind the
    // Connection fence (Host/Origin check plus browser authentication). A Host
    // without that seam gets no route instead of an unauthenticated one.
    if (webServer === undefined || typeof connection?.requestRejection !== 'function') return
    const handler = async (request, response) => {
      try {
        const rejection = connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const url = new URL(request.url ?? '/', 'http://chat-cost.invalid')
        if (!url.pathname.startsWith(API_PREFIX)) {
          sendJson(response, 404, { error: 'unknown route' })
          return
        }
        const route = url.pathname.slice(API_PREFIX.length) || '/'
        const method = request.method ?? 'GET'
        if (method === 'GET' && route === '/quota') {
          const model = url.searchParams.get('model') ?? settings.usd.defaultModel
          await refreshModels(false)
          await fetchQuota(false)
          sendJson(response, 200, { ok: true, at: Date.now(), quota: quotaView(model) })
          return
        }
        if (method === 'POST' && route === '/refresh') {
          await refreshModels(true)
          await fetchQuota(true)
          const model = url.searchParams.get('model') ?? settings.usd.defaultModel
          sendJson(response, 200, { ok: true, at: Date.now(), quota: quotaView(model) })
          return
        }
        sendJson(response, 404, { error: `unknown route ${method} ${route}` })
      } catch (error) {
        try {
          sendJson(response, 500, { error: 'internal' })
        } catch {
          // The socket may already be gone.
        }
      }
    }
    scope.effect(
      () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'chat-cost: allowance API',
    )
  }

  function start() {
    // Warm both caches without holding plugin activation on the network.
    void refreshModels(false)
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer', 'connection'], scope => registerRoutes(scope))
    } else {
      registerRoutes(ctx)
    }
  }

  function stop() {
    live.quota = null
    live.modelsAt = 0
  }

  return { start, stop, refreshModels, fetchQuota, quotaView }
}

/**
 * Register the unit; the registration is an effect on this fiber, so unloading
 * the plugin removes the key.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 * @param {unknown} config - the Loader row's `config`.
 * @returns {Promise<void>} when the unit is registered.
 */
export async function apply(ctx, config) {
  const settings = resolveSettings(config)
  const ratesRef = { current: settings.usd.rates }
  const runtime = createRuntime(ctx, settings, ratesRef)
  runtime.start()
  ctx.effect(() => () => runtime.stop(), 'chat-cost: runtime')
  await ctx.sessionProjections.register(buildDefinition(settings, ratesRef))
}
