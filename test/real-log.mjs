/**
 * Cross-check the fold against a real Session log.
 *
 * The same log is reduced twice: once through the plugin's projection unit, and
 * once through an independent "last sample per (turn, step, retry segment) wins"
 * grouping, with the provider route resolved independently. Both must agree on
 * every token bucket and every currency total, which is the property a
 * double-counted, dropped, or mis-routed sample would break.
 *
 * Run: node test/real-log.mjs <session.v4.jsonl.zstd> [more logs...]
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'
import { buildDefinition, resolveSettings, viewOf, isPeak, isPeakUsd } from '../index.js'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const ROUTES = { 'deepseek-official': 'CNY', 'deepseek-account': 'CNY', 'opencode-go': 'USD', opencode: 'USD' }

/**
 * Read a concatenated-frame zstd log (one frame per append batch).
 * @param {string} file - path to a `session.v4.jsonl.zstd`.
 * @returns {object[]} parsed events.
 */
function readLog(file) {
  const bytes = fs.readFileSync(file)
  const offsets = []
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === ZSTD_MAGIC[0] && bytes[index + 1] === ZSTD_MAGIC[1]
      && bytes[index + 2] === ZSTD_MAGIC[2] && bytes[index + 3] === ZSTD_MAGIC[3]) offsets.push(index)
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : bytes.length
    try {
      text += zlib.zstdDecompressSync(bytes.subarray(offsets[index], end)).toString('utf8')
    } catch {
      // A false-positive magic inside compressed data; the real frame decodes.
    }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A frame boundary split a line; skip it rather than inventing data.
    }
  }
  return events
}

const BUCKETS = ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']

/**
 * The independent reduction: last usage sample per retry segment wins.
 * @param {object[]} events - parsed session events.
 * @returns {Map<string, { buckets: object, time: number, group: string | null, model: string }>} surviving samples.
 */
function referenceSamples(events) {
  /** @type {Map<string, { buckets: object, time: number, group: string | null, model: string }>} */
  const winners = new Map()
  const segments = new Map()
  let model = null
  let provider = null
  for (const event of events) {
    if (event.type === 'request/context') {
      if (typeof event.data?.model === 'string') model = event.data.model
      if (typeof event.data?.provider === 'string') provider = event.data.provider
    }
    if (event.type === 'assistant/message') {
      if (typeof event.data?.message?.source?.model === 'string') model = event.data.message.source.model
      if (typeof event.data?.message?.source?.provider === 'string') provider = event.data.message.source.provider
    }
    if (event.type === 'llm/retry-started') {
      const key = `${event.data.turn}:${event.data.step}`
      segments.set(key, (segments.get(key) ?? 0) + 1)
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    let usage = event.type === 'assistant/message' ? event.data?.usage : undefined
    if (usage === undefined) {
      const stream = event.data?.stream
      if (Array.isArray(stream)) {
        for (let index = stream.length - 1; index >= 0; index -= 1) {
          const record = stream[index]
          if (record?.type === 'chunk' && record.chunk?.type === 'usage') {
            usage = record.chunk.usage
            break
          }
        }
      }
    }
    if (usage === undefined || usage === null) continue
    const segment = `${event.data.turn}:${event.data.step}`
    const key = `${segment}#${segments.get(segment) ?? 0}`
    winners.set(key, {
      time: event.time,
      group: provider === null ? 'CNY' : (ROUTES[provider] ?? null),
      model: model ?? 'unknown',
      buckets: {
        cacheMiss: usage.inputTokens ?? 0,
        cacheHit: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        output: usage.outputTokens ?? 0,
      },
    })
  }
  return winners
}

const files = process.argv.slice(2)
assert.ok(files.length > 0, 'pass at least one session log path')
const settings = resolveSettings({})

let checked = 0
for (const file of files) {
  const events = readLog(file)
  const definition = buildDefinition(settings)
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  const view = viewOf(state, settings)

  // Expected totals from the independent reduction.
  const expected = {}
  const expectedCost = {}
  for (const sample of referenceSamples(events).values()) {
    if (sample.group === null) continue
    const group = sample.group
    const entry = expected[group] ?? {
      peak: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
      off: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
    }
    const slot = group === 'CNY'
      ? (isPeak(settings, sample.time) ? 'peak' : 'off')
      : (isPeakUsd(settings.usd.rates[sample.model] ?? settings.usd.rates[settings.usd.defaultModel], sample.time) ? 'peak' : 'off')
    for (const key of BUCKETS) entry[slot][key] += sample.buckets[key]
    expected[group] = entry
    let cost
    if (group === 'CNY') {
      const rate = settings.rates[sample.model] ?? settings.rates[settings.defaultModel]
      cost = (
        sample.buckets.cacheMiss * rate.cacheMiss
        + sample.buckets.cacheHit * rate.cacheHit
        + sample.buckets.cacheWrite * rate.cacheWrite
        + sample.buckets.output * rate.output
      ) / 1_000_000
      if (slot === 'off') cost *= settings.offPeakRatio
    } else {
      const rate = settings.usd.rates[sample.model] ?? settings.usd.rates[settings.usd.defaultModel]
      cost = (
        sample.buckets.cacheMiss * rate.input
        + sample.buckets.cacheHit * rate.cacheRead
        + sample.buckets.cacheWrite * rate.cacheWrite
        + sample.buckets.output * rate.output
      ) / 1_000_000
      if (slot === 'peak') cost *= rate.peakFactor ?? 1
    }
    expectedCost[group] = (expectedCost[group] ?? 0) + cost
  }

  // Actual totals from the plugin's fold.
  for (const group of new Set([...Object.keys(expected), ...Object.keys(view.groups)])) {
    const actual = { peak: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }, off: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 } }
    for (const entry of Object.values(state.models)) {
      if (entry.group !== group) continue
      for (const slot of ['peak', 'off']) {
        for (const key of BUCKETS) actual[slot][key] += entry[slot][key]
      }
    }
    const want = expected[group] ?? { peak: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 }, off: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 } }
    for (const slot of ['peak', 'off']) {
      for (const key of BUCKETS) {
        assert.equal(actual[slot][key], want[slot][key], `${file}: ${group} ${slot}.${key} mismatch`)
      }
    }
    const total = view.groups[group]?.total ?? 0
    const cost = expectedCost[group] ?? 0
    assert.ok(Math.abs(total - cost) < 1e-9, `${file}: ${group} cost ${total} vs ${cost}`)
    const tokens = view.groups[group]?.tokens.total ?? 0
    if (tokens > 0) {
      assert.ok(
        Math.abs(view.groups[group].per1k - (total / tokens) * 1000) < 1e-12,
        `${file}: ${group} per-1K rate disagrees with total/tokens`,
      )
      assert.ok(view.groups[group].cacheSaving >= 0, `${file}: ${group} a saving cannot be negative`)
    }
  }

  // Provider usage is internally consistent: input + cached + output = total.
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === undefined || typeof usage.totalTokens !== 'number') continue
    const sum = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0)
    assert.equal(sum, usage.totalTokens, `${file}: usage total mismatch at seq ${event.seq}`)
  }

  checked += 1
  const summary = Object.entries(view.groups)
    .map(([group, entry]) => {
      const symbol = group === 'CNY' ? '¥' : '$'
      return `${group}=${symbol}${entry.total.toFixed(6)} tokens=${entry.tokens.total} per1K=${symbol}${entry.per1k === null ? 'n/a' : entry.per1k.toPrecision(3)}`
    })
    .join('  ')
  console.log(`${file.split('\\').pop()}  events=${events.length}  ${summary}  excluded=${view.excluded.requests}`)
}

console.log(`real-log.mjs: ${checked} log(s) agree with the independent reduction`)
