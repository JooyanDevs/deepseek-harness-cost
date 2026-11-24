/**
 * Unit checks for the Chat cost meter's fold, routing, pricing and browser half.
 *
 * Run: node test/fold.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDefinition,
  estimateWindows,
  groupOf,
  isPeak,
  isPeakUsd,
  normalizeUsage,
  ratesFromModels,
  resolveSettings,
  viewOf,
} from '../index.js'

// --- CNY clock and prices ----------------------------------------------------
const flashPeak = new Date('2026-11-17T10:00:00+08:00').getTime()
const flashOff = new Date('2026-11-17T13:00:00+08:00').getTime()
const saturday = new Date('2026-11-21T10:00:00+08:00').getTime()
const holiday = new Date('2026-11-17T10:00:00+08:00').getTime()

const holidaySettings = resolveSettings({ peak: { holidays: ['2026-11-17'] } })
assert.equal(isPeak(holidaySettings, holiday), false, 'a configured holiday is off-peak')
assert.equal(isPeak(holidaySettings, flashOff), false, '13:00 Beijing is the midday gap')
assert.equal(isPeak(holidaySettings, saturday), false, 'Saturday is off-peak')
const plain = resolveSettings({})
assert.equal(isPeak(plain, flashPeak), true, 'Tuesday 10:00 Beijing is peak')
assert.equal(isPeak(plain, flashOff), false, 'Tuesday 13:00 Beijing is off-peak')
assert.equal(isPeak(plain, new Date('2026-11-17T11:59:00+08:00').getTime()), true, '11:59 is still peak')
assert.equal(isPeak(plain, new Date('2026-11-17T12:00:00+08:00').getTime()), false, '12:00 ends the peak window')
assert.equal(resolveSettings({ peakMode: 'off-peak' }).peakMode, 'off-peak', 'the mode override survives')

// --- USD clock and prices ----------------------------------------------------
// OpenCode publishes DeepSeek peak as Mon-Fri 01:00-04:00 and 06:00-10:00 UTC.
const usdPeak = new Date('2026-11-17T02:00:00Z').getTime()
const usdOff = new Date('2026-11-17T05:00:00Z').getTime()
const usdWeekend = new Date('2026-11-21T02:00:00Z').getTime()
const usdRate = plain.usd.rates['deepseek-v4.1-flash']
assert.equal(isPeakUsd(usdRate, usdPeak), true, 'Tuesday 02:00 UTC is peak for DeepSeek on OpenCode')
assert.equal(isPeakUsd(usdRate, usdOff), false, 'the 04:00-06:00 UTC gap is off-peak')
assert.equal(isPeakUsd(usdRate, usdWeekend), false, 'Saturday is off-peak')

/** Fold a list of synthetic events through one definition. */
function fold(events, config = {}, rates) {
  const settings = resolveSettings(config)
  const definition = buildDefinition(settings, rates === undefined ? undefined : { current: rates })
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: viewOf(state, settings, rates), settings }
}

const usage = (cacheMiss, output, cacheHit = 0, cacheWrite = 0) => ({
  inputTokens: cacheMiss,
  outputTokens: output,
  cacheReadTokens: cacheHit,
  cacheWriteTokens: cacheWrite,
})
const stream = chunk => [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: chunk } }]
const route = (time, provider, model, turn, step, chunk) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, message: { source: { provider, model } }, stream: [], usage: chunk },
})

// --- provider routing -------------------------------------------------------
assert.equal(groupOf(plain, 'deepseek-official'), 'CNY', 'the API-key route bills in CNY')
assert.equal(groupOf(plain, 'deepseek-account'), 'CNY', 'the signed-in route bills in CNY')
assert.equal(groupOf(plain, 'opencode-go'), 'USD', 'the Go subscription bills in USD')
assert.equal(groupOf(plain, 'some-gateway'), null, 'an unknown gateway has no rate card')
assert.equal(groupOf(plain, undefined), 'CNY', 'a log too old to name a route keeps the legacy pricing')
assert.equal(groupOf(resolveSettings({ routes: { 'some-gateway': 'USD' } }), 'some-gateway'), 'USD', 'an explicit route override wins')

// --- replacement semantics --------------------------------------------------
const replaced = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  { type: 'assistant/attempt', time: usdOff, data: { turn: 1, step: 1, stream: stream(usage(1000, 100)) } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(1200, 150)),
])
assert.deepEqual(
  replaced.state.models['USD:deepseek-v4.1-flash'].off,
  { cacheMiss: 1200, cacheHit: 0, cacheWrite: 0, output: 150 },
  'the settled message replaces the streaming sample',
)
assert.equal(replaced.state.requests.USD, 1, 'one billed request')
assert.equal(replaced.view.groups.USD.requests, 1, 'the view counts one request')

const retried = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(100, 10)),
  { type: 'llm/retry-started', time: usdOff, data: { turn: 1, step: 1 } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(200, 20)),
])
assert.equal(retried.state.requests.USD, 2, 'both attempts are billed')
assert.deepEqual(
  retried.state.models['USD:deepseek-v4.1-flash'].off,
  { cacheMiss: 300, cacheHit: 0, cacheWrite: 0, output: 30 },
  'the retry adds instead of replacing',
)

// A streaming sample replaced by a settled message that names another provider
// moves the request across currencies instead of counting it twice.
const moved = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  { type: 'assistant/attempt', time: usdOff, data: { turn: 1, step: 1, stream: stream(usage(100, 10)) } },
  route(flashPeak, 'deepseek-account', 'deepseek-flash', 1, 1, usage(200, 20)),
])
assert.equal(moved.view.groups.USD, undefined, 'the replaced USD sample left the USD block')
assert.equal(moved.view.groups.CNY.requests, 1, 'the replacement is a CNY request')
assert.equal(moved.view.groups.CNY.tokens.total, 220, 'and its tokens are the settled ones')

// --- CNY pricing ------------------------------------------------------------
const cnyMillion = fold([
  { type: 'request/context', time: flashPeak, data: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  route(flashPeak, 'deepseek-account', 'deepseek-flash', 1, 1, usage(1_000_000, 0)),
])
assert.equal(cnyMillion.view.groups.CNY.total, 1, '×1M peak CNY input = ¥1')
assert.equal(cnyMillion.view.groups.CNY.per1k, 0.001, '¥1 over 1M tokens is ¥0.001 per 1K')

const cnyCool = fold([
  { type: 'request/context', time: flashOff, data: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  route(flashOff, 'deepseek-account', 'deepseek-flash', 1, 1, usage(1_000_000, 0)),
])
assert.equal(cnyCool.view.groups.CNY.total, 0.5, '×1M off-peak CNY input = ¥0.5')

// --- USD pricing ------------------------------------------------------------
const usdMillion = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(1_000_000, 0)),
])
assert.equal(usdMillion.view.groups.USD.total, 0.15, '×1M off-peak USD input = $0.15')
assert.equal(usdMillion.view.groups.USD.per1k, 0.00015, 'and $0.00015 per 1K')

const usdPeakView = fold([
  { type: 'request/context', time: usdPeak, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdPeak, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(1_000_000, 0)),
])
assert.equal(usdPeakView.view.groups.USD.total, 0.3, '×1M peak USD input = $0.30')

const usdBuckets = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(0, 1_000_000, 1_000_000, 1_000_000)),
])
const usdBucketsExpected = (1_000_000 * 0.003 + 1_000_000 * 0 + 1_000_000 * 0.6) / 1_000_000
assert.equal(
  Number(usdBuckets.view.groups.USD.total.toFixed(9)),
  Number(usdBucketsExpected.toFixed(9)),
  'cache read, cache write and output each use their own rate',
)

// --- grouping, exclusion and the blended rate -------------------------------
const mixed = fold([
  { type: 'request/context', time: flashPeak, data: { provider: 'deepseek-account', model: 'deepseek-flash' } },
  route(flashPeak, 'deepseek-account', 'deepseek-flash', 1, 1, usage(1_000_000, 0)),
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 2, usage(1_000_000, 0)),
])
assert.deepEqual(Object.keys(mixed.view.groups).sort(), ['CNY', 'USD'], 'both currencies are reported separately')
assert.equal(mixed.view.groups.CNY.total, 1, 'the CNY block contains only the DeepSeek request')
assert.equal(mixed.view.groups.USD.total, 0.15, 'the USD block contains only the OpenCode request')

const unknown = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'some-gateway', model: 'x' } },
  route(usdOff, 'some-gateway', 'x', 1, 1, usage(1000, 10)),
])
assert.deepEqual(unknown.view.groups, {}, 'an unpriced provider produces no money')
assert.deepEqual(unknown.view.excluded, { requests: 1, tokens: 1010 }, 'and is reported as excluded instead')

// An unknown model is priced with the default rates and flagged.
const unknownModel = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'some-new-model' } },
  route(usdOff, 'opencode-go', 'some-new-model', 1, 1, usage(1_000_000, 0)),
])
assert.equal(unknownModel.view.groups.USD.estimated, true, 'unknown USD routes are flagged')
assert.equal(unknownModel.view.groups.USD.total, 0.15, 'and priced with the default model rates')

// --- live rate refresh ------------------------------------------------------
const liveRates = {
  ...plain.usd.rates,
  'deepseek-v4.1-flash': { ...plain.usd.rates['deepseek-v4.1-flash'], input: 3, output: 9, cacheRead: 0.3 },
}
const live = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(1_000_000, 0)),
], {}, liveRates)
assert.equal(live.view.groups.USD.total, 3, 'a refreshed price table reprices the same buckets on read')

// --- the per-1K identity ----------------------------------------------------
for (const code of ['CNY', 'USD']) {
  const group = mixed.view.groups[code]
  assert.ok(
    Math.abs(group.per1k - (group.total / group.tokens.total) * 1000) < 1e-12,
    `${code}: the blended rate is total ÷ tokens × 1000`,
  )
  assert.ok(
    Math.abs((group.per1k * group.tokens.total) / 1000 - group.total) < 1e-12,
    `${code}: rate × tokens reconstructs the total`,
  )
  assert.ok(group.cacheSaving >= 0, `${code}: a saving cannot be negative`)
}

// Cache-heavy USD chat: the realized rate is far below the uncached list price.
const cachedUsd = fold([
  { type: 'request/context', time: usdOff, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
  route(usdOff, 'opencode-go', 'deepseek-v4.1-flash', 1, 1, usage(0, 0, 1_000_000)),
])
assert.equal(cachedUsd.view.groups.USD.total, 0.003, '1M cache-read tokens at off-peak = $0.003')
assert.equal(cachedUsd.view.groups.USD.per1k, 0.000003, 'the realized rate reports what was actually paid')

// --- malformed checkpoints --------------------------------------------------
const definition = buildDefinition(plain)
assert.deepEqual(
  definition.stateSchema.parse({ models: { x: null }, last: 5, requests: 'nope' }),
  {
    models: {},
    model: null,
    provider: null,
    group: 'CNY',
    requests: { CNY: 0, USD: 0 },
    excluded: { requests: 0, tokens: 0 },
    last: null,
  },
  'malformed state normalizes to empty',
)
const steady = definition.init()
assert.equal(definition.apply(steady, { type: 'step/start', time: 0, data: { turn: 1, step: 1 } }), steady, 'uninteresting events keep the state reference')

// --- allowance normalization ------------------------------------------------
const usageReply = normalizeUsage({
  usage: {
    rolling: { status: 'ok', percent: 2, resetsAt: '2026-11-18T18:35:57.000Z' },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-11-23T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 100, resetsAt: '2026-12-18T13:21:49.000Z' },
  },
})
assert.equal(usageReply.rolling.percent, 2, 'the used percentage survives')
assert.deepEqual(
  estimateWindows(usageReply, 100),
  {
    rolling: { status: 'ok', percent: 2, resetsAt: '2026-11-18T18:35:57.000Z', share: 0.2, limitUsd: 20 },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-11-23T00:00:00.000Z', share: 0.5, limitUsd: 50 },
    monthly: { status: 'ok', percent: 100, resetsAt: '2026-12-18T13:21:49.000Z', share: 1, limitUsd: 100 },
  },
  'the plan limit follows OpenCode published window shares',
)
assert.equal(estimateWindows(usageReply, null).rolling.limitUsd, null, 'no monthly limit, no invented dollars')
assert.equal(normalizeUsage(null).rolling, null, 'a missing reply is not an error value')

// --- models endpoint parsing ------------------------------------------------
const modelsReply = {
  data: [
    {
      id: 'deepseek-v4.1-flash',
      cost: {
        text: { input: { price: 0.15, cache: { read: 0.003 } }, output: { price: 0.6 } },
        multipliers: [{
          when: {
            utc_days: { in: ['mon', 'tue', 'wed', 'thu', 'fri'] },
            any: [
              { all: [{ utc_hours: { gte: '01:00' } }, { utc_hours: { lt: '04:00' } }] },
              { all: [{ utc_hours: { gte: '06:00' } }, { utc_hours: { lt: '10:00' } }] },
            ],
          },
          factor: 2,
        }],
      },
      go: { monthly_usage: { go: 100, 'go-plus': 200, 'go-teams': 105 } },
    },
    { id: 'no-cost-model' },
  ],
}
const parsedRates = ratesFromModels(modelsReply)
assert.deepEqual(parsedRates['deepseek-v4.1-flash'], {
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  cacheWrite: 0,
  peakFactor: 2,
  peakDays: [1, 2, 3, 4, 5],
  peakWindowsUtc: [[1, 4], [6, 10]],
  monthly: { go: 100, 'go-plus': 200, 'go-teams': 105 },
}, 'the published prices, peak windows and plan limits survive parsing')
assert.equal(parsedRates['no-cost-model'], undefined, 'a model without prices is skipped, not zero-priced')

// A partial override on a new model keeps the default price level but does not
// inherit DeepSeek's peak rule; a known model keeps its own rule.
const override = resolveSettings({ usd: { prices: { 'new-model': { input: 1, output: 2 } } } })
assert.equal(override.usd.rates['new-model'].peakFactor, 1, 'a new model gets no borrowed peak rule')
assert.equal(override.usd.rates['new-model'].output, 2, 'and keeps the configured output price')
assert.equal(override.usd.rates['deepseek-v4.1-flash'].peakFactor, 2, 'a known model keeps its published peak rule')

// --- browser half -----------------------------------------------------------
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Lift one `function name(params) {…}` declaration out of a source file.
 * @param {string} source - the file text.
 * @param {string} name - the function name.
 * @param {readonly string[]} extraParams - further parameter names to append.
 * @returns {Function} the compiled function.
 */
function liftFunction(source, name, extraParams = []) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `client.js still declares ${name}`)
  let depth = 0
  let index = source.indexOf('{', start)
  const open = index
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  const body = source.slice(open, index + 1)
  const params = source.slice(start + `function ${name}(`.length, open).replace(/\)\s*$/, '')
  const names = [...params.split(',').map(part => part.trim()).filter(Boolean), ...extraParams]
  // eslint-disable-next-line no-new-func -- lifting a pure function for a test
  return new Function(...names, body)
}

const CURRENCIES = {
  CNY: { symbol: '¥' },
  USD: { symbol: '$' },
}
const formatMoneyWith = liftFunction(clientSource, 'formatMoney', ['CURRENCIES'])
const formatRateWith = liftFunction(clientSource, 'formatRate', ['CURRENCIES'])
const formatMoney = (value, code) => formatMoneyWith(value, code, CURRENCIES)
const formatRate = (value, code) => formatRateWith(value, code, CURRENCIES)
const resetText = liftFunction(clientSource, 'resetText')
const severityClass = liftFunction(clientSource, 'severityClass')

assert.equal(formatMoney(0.551, 'CNY'), '¥0.551', 'a CNY total keeps three decimals under ¥10')
assert.equal(formatMoney(12.3456, 'CNY'), '¥12.35', 'and two above it')
assert.equal(formatMoney(0.0042, 'USD'), '$0.0042', 'a small USD total keeps four decimals')
assert.equal(formatMoney(0.404, 'USD'), '$0.404', 'a mid USD total keeps three')
assert.equal(formatRate(0.001, 'CNY'), '¥0.001', 'a plain CNY rate drops trailing zeros')
assert.equal(formatRate(0.0000214, 'CNY'), '¥0.0000214', 'a tiny CNY rate never prints in exponent notation')
assert.equal(formatRate(0.000312, 'USD'), '$0.000312', 'a USD rate follows the same rule')
assert.equal(formatRate(null, 'USD'), null, 'no rate renders nothing')
assert.equal(formatRate(0, 'USD'), null, 'a zero rate renders nothing')
assert.equal(resetText('2026-11-18T18:35:57.000Z', Date.parse('2026-11-18T15:20:00Z')), '3h 16m', 'the countdown keeps hours and minutes')
assert.equal(resetText('2026-11-18T18:35:57.000Z', Date.parse('2026-11-18T18:36:00Z')), 'now', 'a past reset reads now')
assert.equal(severityClass(50), '', 'a healthy window has no warning class')
assert.equal(severityClass(85), ' dcm-warn', '80% starts the warning colour')
assert.equal(severityClass(96), ' dcm-error', '95% starts the error colour')

// --- subagent aggregation ---------------------------------------------------
const maxDescendants = Number(clientSource.match(/const MAX_DESCENDANTS = (\d+)/)?.[1] ?? 64)
const collectDescendants = liftFunction(clientSource, 'collectDescendants', ['MAX_DESCENDANTS'])
const emptyTokens = liftFunction(clientSource, 'emptyTokens')
const accumulateWith = liftFunction(clientSource, 'accumulate', ['emptyTokens'])
const accumulate = (acc, view) => accumulateWith(acc, view, emptyTokens)
const finalizeGroup = liftFunction(clientSource, 'finalizeGroup')
const combineViewsWith = liftFunction(clientSource, 'combineViews', ['accumulate', 'finalizeGroup'])
const combineViews = (own, children) => combineViewsWith(own, children, accumulate, finalizeGroup)
const totalRequests = liftFunction(clientSource, 'totalRequests')

const tree = {
  root: { id: 'root', parentId: undefined },
  childA: { id: 'childA', parentId: 'root', running: true },
  childB: { id: 'childB', parentId: 'root' },
  grand: { id: 'grand', parentId: 'childA' },
  stranger: { id: 'stranger', parentId: 'elsewhere' },
}
assert.deepEqual(
  collectDescendants(tree, 'root', maxDescendants).sort(),
  ['childA', 'childB', 'grand'],
  'the child tree is walked to every depth and no further',
)
assert.deepEqual(collectDescendants(tree, 'childA', maxDescendants), ['grand'], 'a child is its own root')
assert.deepEqual(collectDescendants(tree, 'root', 1), ['childA'], 'the guard caps the walk')
assert.deepEqual(collectDescendants(undefined, 'root'), [], 'no list, no tree')

const groupOfView = (code, total, tokens, requests) => ({
  code,
  requests,
  total,
  peak: total,
  offPeak: 0,
  cacheSaving: 0,
  estimated: false,
  tokens: { ...tokens, total: tokens.cacheMiss + tokens.cacheHit + tokens.cacheWrite + tokens.output },
  cacheHitPercent: null,
  per1k: tokens.cacheMiss + tokens.output > 0 ? (total / (tokens.cacheMiss + tokens.output)) * 1000 : null,
  per1m: null,
  models: [{ model: code === 'CNY' ? 'deepseek-flash' : 'deepseek-v4.1-flash', known: true, total, peak: total, offPeak: 0, tokens }],
})
const viewA = {
  groups: { USD: groupOfView('USD', 0.3, { cacheMiss: 1000, cacheHit: 900_000, cacheWrite: 0, output: 500 }, 4) },
  excluded: { requests: 0, tokens: 0 },
  model: 'deepseek-v4.1-flash',
  provider: 'opencode-go',
  usdPlan: 'go',
}
const viewB = {
  groups: { USD: groupOfView('USD', 0.1, { cacheMiss: 500, cacheHit: 100_000, cacheWrite: 0, output: 100 }, 2) },
  excluded: { requests: 1, tokens: 10 },
  model: 'deepseek-v4.1-flash',
  provider: 'opencode-go',
  usdPlan: 'go',
}
const combined = combineViews(viewA, [viewB])
assert.equal(combined.groups.USD.total.toFixed(10), '0.4000000000', 'money is summed')
assert.equal(combined.groups.USD.tokens.total, 1_002_100, 'tokens are summed across sessions')
assert.equal(combined.groups.USD.requests, 6, 'requests are summed')
assert.equal(combined.excluded.requests, 1, 'excluded requests are summed')
assert.equal(combined.childCount, 1, 'and their count')
assert.equal(combined.childTotals.USD, 0.1, 'children get their own total')
assert.equal(
  combined.groups.USD.per1k,
  (0.4 / 1_002_100) * 1000,
  'the combined per-1K rate comes from the summed money and tokens',
)
const naiveAverage = (viewA.groups.USD.per1k + viewB.groups.USD.per1k) / 2
assert.ok(
  Math.abs(combined.groups.USD.per1k - naiveAverage) > 1e-9,
  'the combined rate is not the average of the two sessions rates',
)
assert.equal(combined.groups.USD.models.length, 1, 'the same model merges into one row')
assert.equal(totalRequests(combined), 6, 'the request total is available for the empty guard')

const alone = combineViews(viewA, [])
assert.equal(alone.groups.USD.total, 0.3, 'no children, same figure')
assert.equal(alone.childCount, 0, 'no children, no split')

// The unit must stay on list rows, which is how a settled child is priced.
assert.notEqual(buildDefinition(plain).wire.summary, false, 'summary stays enabled for child rows')

console.log('fold.test.mjs: all checks passed')
