/**
 * Independent audit of the amount the plugin shows.
 *
 * Deliberately shares NO code with the plugin: its own zstd frame reader, its
 * own fold, its own route resolution, its own peak clocks, and price tables
 * transcribed from the two published cards rather than read from the plugin's
 * config. If the plugin and this file agree on a Session, the figure on screen is
 * a function of the provider's own usage records and the published rates, not of
 * the plugin's arithmetic.
 *
 * Run: node test/audit.mjs [--all | <session.v4.jsonl.zstd> ...]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { viewOf, resolveSettings, buildDefinition } from '../index.js'

// --- prices transcribed from the published cards ----------------------------
// CNY per 1M tokens at PEAK time; off-peak is half.
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
const CNY_PRICES = {
  'deepseek-flash': { hit: 0.02, miss: 1, write: 0, out: 4 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, write: 0, out: 13.5 },
  'deepseek-chat': { hit: 0.02, miss: 1, write: 0, out: 4 },
  'deepseek-reasoner': { hit: 0.02, miss: 1, write: 0, out: 4 },
}
// USD per 1M tokens at the base (off-peak) price; DeepSeek doubles inside its
// published UTC peak windows. https://opencode.ai/zen/go/v1/models
const USD_PRICES = {
  'deepseek-v4.1-flash': { miss: 0.15, hit: 0.003, write: 0, out: 0.6, peakFactor: 2, peakDays: [1, 2, 3, 4, 5], peakWindows: [[1, 4], [6, 10]] },
  'deepseek-v4-pro': { miss: 0.66, hit: 0.022, write: 0, out: 1.98, peakFactor: 2, peakDays: [1, 2, 3, 4, 5], peakWindows: [[1, 4], [6, 10]] },
}
const CNY_FALLBACK = 'deepseek-flash'
const USD_FALLBACK = 'deepseek-v4.1-flash'
const ROUTES = { 'deepseek-official': 'CNY', 'deepseek-account': 'CNY', 'opencode-go': 'USD', opencode: 'USD' }

// CNY peak: Monday..Friday, 09:00-12:00 and 14:00-18:00 Beijing (UTC+8, no DST).
const PEAK_DAYS = new Set([1, 2, 3, 4, 5])
const PEAK_WINDOWS = [[9, 12], [14, 18]]
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Read a concatenated-frame zstd log without any plugin helper.
 * @param {string} file - path to a session log.
 * @returns {object[]} parsed events.
 */
function readEvents(file) {
  const bytes = fs.readFileSync(file)
  const starts = []
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 0x28 && bytes[index + 1] === 0xb5 && bytes[index + 2] === 0x2f && bytes[index + 3] === 0xfd) {
      starts.push(index)
    }
  }
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : bytes.length
    try {
      text += zlib.zstdDecompressSync(bytes.subarray(starts[index], end)).toString('utf8')
    } catch {
      // A magic-byte coincidence inside compressed data; the real frame decodes.
    }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Frame boundary inside a line: skip rather than invent data.
    }
  }
  return events
}

/**
 * Whether a wall-clock instant bills at CNY peak rates — the auditor's own clock.
 * @param {number} timeMs - event time.
 * @returns {boolean} peak.
 */
function cnyPeakAt(timeMs) {
  const local = new Date(timeMs + BEIJING_OFFSET_MS)
  if (!PEAK_DAYS.has(local.getUTCDay())) return false
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * Whether an instant falls in a USD model's published peak window.
 * @param {object} price - transcribed USD row.
 * @param {number} timeMs - event time.
 * @returns {boolean} peak.
 */
function usdPeakAt(price, timeMs) {
  if (!(price.peakFactor > 1)) return false
  const date = new Date(timeMs)
  if (!price.peakDays.includes(date.getUTCDay())) return false
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return price.peakWindows.some(([from, to]) => hour >= from && hour < to)
}

/**
 * The provider usage one event reports, read independently of the plugin.
 * @param {any} event - session event.
 * @returns {any} usage or undefined.
 */
function usageOf(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  if (event.type === 'assistant/message' && event.data.usage != null) return event.data.usage
  const stream = event.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Audit one Session: independent per-currency cost, token sums, and the plugin's
 * own answer for the same log.
 * @param {string} file - session log path.
 * @param {readonly object[]} events - parsed events.
 * @returns {object} the audit row.
 */
function audit(file, events) {
  // Independent accounting: last sample per retry segment wins.
  let provider = null
  let model = ''
  const segment = new Map()
  const winners = new Map()
  let providerTokens = 0
  let inconsistent = 0
  for (const event of events) {
    if (event.type === 'request/context') {
      if (typeof event.data?.provider === 'string') provider = event.data.provider
      if (typeof event.data?.model === 'string') model = event.data.model
    }
    if (event.type === 'assistant/message') {
      const source = event.data?.message?.source
      if (typeof source?.provider === 'string') provider = source.provider
      if (typeof source?.model === 'string') model = source.model
      const usage = event.data.usage
      if (usage && typeof usage.totalTokens === 'number') {
        providerTokens += usage.totalTokens
        const sum = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0)
        if (sum !== usage.totalTokens) inconsistent += 1
      }
    }
    if (event.type === 'llm/retry-started') {
      const key = `${event.data.turn}:${event.data.step}`
      segment.set(key, (segment.get(key) ?? 0) + 1)
      continue
    }
    const usage = usageOf(event)
    if (usage == null) continue
    const cell = `${event.data.turn}:${event.data.step}`
    winners.set(`${cell}#${segment.get(cell) ?? 0}`, {
      time: event.time,
      group: provider === null ? 'CNY' : (ROUTES[provider] ?? null),
      model: model || (provider === null || ROUTES[provider] === 'CNY' ? CNY_FALLBACK : USD_FALLBACK),
      miss: usage.inputTokens ?? 0,
      hit: usage.cacheReadTokens ?? 0,
      write: usage.cacheWriteTokens ?? 0,
      out: usage.outputTokens ?? 0,
    })
  }

  const groups = {}
  const excluded = { requests: 0, tokens: 0 }
  for (const sample of winners.values()) {
    const tokens = sample.miss + sample.hit + sample.write + sample.out
    if (sample.group === null) {
      if (tokens > 0) {
        excluded.requests += 1
        excluded.tokens += tokens
      }
      continue
    }
    if (tokens === 0) continue
    const entry = groups[sample.group] ?? { requests: 0, tokens: 0, cost: 0, peak: 0 }
    entry.requests += 1
    entry.tokens += tokens
    let cost
    if (sample.group === 'CNY') {
      const price = CNY_PRICES[sample.model] ?? CNY_PRICES[CNY_FALLBACK]
      const base = (sample.miss * price.miss + sample.hit * price.hit + sample.write * price.write + sample.out * price.out) / 1_000_000
      const peak = cnyPeakAt(sample.time)
      cost = peak ? base : base / 2
      if (peak) entry.peak += cost
    } else {
      const price = USD_PRICES[sample.model] ?? USD_PRICES[USD_FALLBACK]
      const base = (sample.miss * price.miss + sample.hit * price.hit + sample.write * price.write + sample.out * price.out) / 1_000_000
      const peak = usdPeakAt(price, sample.time)
      cost = peak ? base * price.peakFactor : base
      if (peak) entry.peak += cost
    }
    entry.cost += cost
    groups[sample.group] = entry
  }

  // The plugin's answer for the same events.
  const settings = resolveSettings({})
  const definition = buildDefinition(settings)
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  const plugin = viewOf(state, settings)

  return {
    file,
    groups,
    excluded,
    providerTokens,
    inconsistent,
    plugin,
  }
}

const args = process.argv.slice(2)
let files = args
if (files.length === 0 || args.includes('--all')) {
  const root = process.env.DSH_SESSIONS ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')
  const found = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(full)
    }
  }
  walk(root)
  files = found
}

let worst = 0
let rows = 0
const totals = {}
let requests = 0
let tokenMismatches = 0
for (const file of files) {
  let events
  try {
    events = readEvents(file)
  } catch {
    continue
  }
  if (!events.some(event => event.type === 'assistant/message')) continue
  const row = audit(file, events)
  rows += 1
  requests += Object.values(row.groups).reduce((sum, entry) => sum + entry.requests, 0)
  const codes = new Set([...Object.keys(row.groups), ...Object.keys(row.plugin.groups)])
  for (const code of codes) {
    const auditGroup = row.groups[code] ?? { requests: 0, tokens: 0, cost: 0, peak: 0 }
    const pluginGroup = row.plugin.groups[code] ?? { requests: 0, total: 0, tokens: { total: 0 }, per1k: null }
    const total = totals[code] ?? { cost: 0, tokens: 0, requests: 0, peak: 0 }
    total.cost += auditGroup.cost
    total.tokens += auditGroup.tokens
    total.requests += auditGroup.requests
    total.peak += auditGroup.peak
    totals[code] = total
    if (pluginGroup.tokens.total !== auditGroup.tokens) {
      tokenMismatches += 1
      console.log(`! ${path.basename(path.dirname(file))}: ${code} tokens audit/plugin=${auditGroup.tokens}/${pluginGroup.tokens.total}`)
    }
    if (pluginGroup.requests !== auditGroup.requests) {
      tokenMismatches += 1
      console.log(`! ${path.basename(path.dirname(file))}: ${code} requests audit/plugin=${auditGroup.requests}/${pluginGroup.requests}`)
    }
    const diff = Math.abs((pluginGroup.total ?? 0) - auditGroup.cost)
    worst = Math.max(worst, diff)
    console.log(
      `${path.basename(path.dirname(file)).slice(-12)}  ${code}  req=${String(auditGroup.requests).padStart(4)}  `
      + `audit=${code === 'CNY' ? '¥' : '$'}${auditGroup.cost.toFixed(6)}  plugin=${code === 'CNY' ? '¥' : '$'}${(pluginGroup.total ?? 0).toFixed(6)}  `
      + `Δ=${diff.toExponential(2)}  tokens audit/plugin=${auditGroup.tokens}/${pluginGroup.tokens.total}`,
    )
  }
  if (row.excluded.requests !== row.plugin.excluded.requests || row.excluded.tokens !== row.plugin.excluded.tokens) {
    console.log(`! ${path.basename(path.dirname(file))}: excluded audit/plugin=${row.excluded.requests}/${row.plugin.excluded.requests}`)
    tokenMismatches += 1
  }
  if (row.inconsistent > 0) console.log(`! ${path.basename(path.dirname(file))}: ${row.inconsistent} usage records fail input+cache+output = total`)
}

console.log('')
console.log(`sessions audited: ${rows}`)
console.log(`requests:         ${requests}`)
for (const [code, total] of Object.entries(totals)) {
  const symbol = code === 'CNY' ? '¥' : '$'
  console.log(`${code}: tokens=${total.tokens.toLocaleString('en-US')}  cost=${symbol}${total.cost.toFixed(6)}  peak=${symbol}${total.peak.toFixed(6)}  requests=${total.requests}`)
}
console.log(`largest Δ:        ${worst.toExponential(2)}`)
console.log(`sessions where the plugin and the audit disagree: ${tokenMismatches}`)

if (tokenMismatches > 0 || worst > 1e-9) {
  console.log('AUDIT FAILED')
  process.exit(1)
}
console.log('AUDIT PASSED — the plugin prices the provider records exactly as the documented rates do')
