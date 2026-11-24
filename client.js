/**
 * Chat cost meter — browser half.
 *
 * One entry in `conversation.composer.dock` (the row under the composer card,
 * beside the shipped activity and usage pills). It renders whatever the Host's
 * `chatCost` projection priced for the open Session:
 *
 * - a DeepSeek Session shows its CNY total and the realized CNY per 1K tokens;
 * - an OpenCode Go Session shows its USD total and per-1K figure, plus the
 *   subscription allowance windows (5-hour, weekly, monthly) read from OpenCode;
 * - a Session that mixed both shows both currencies, never a made-up exchange
 *   rate, and the allowance windows because OpenCode billed part of it.
 *
 * Subagent and workflow child Sessions keep their own log and their own
 * projection, so the total is the open Session plus every descendant in the
 * session tree: a running child is read live from the Host (`ctx.remote.session
 * .projections` is a synchronous snapshot for a live Session, so the poll costs
 * no I/O), and a settled child is read from its list-row summary. The combined
 * figure is recomputed from summed money and summed tokens per currency, never
 * by averaging per-session rates.
 *
 * Self-contained: it requires `react` and `react-dom` from the host module
 * table and no Harness Client package, so a Harness upgrade cannot blank the
 * entry through a changed import.
 */

window.__ModuleLoader__.load({
  id: 'deepseek-harness-cost',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Locale namespace and the projection key the host unit registers. */
    const NS = 'chat-cost'
    const PROJECTION_KEY = 'chatCost'
    const API = '/chat-cost/api'
    /** Panel geometry: target width, gap above the pill, viewport inset. */
    const PANEL_WIDTH = 360
    const PANEL_GAP = 8
    const VIEWPORT_INSET = 12
    /** How often a running child Session's cost is re-read (live snapshot, no I/O). */
    const CHILD_POLL_MS = 4000
    /** How often the allowance is re-read while idle (the Host caches 30s). */
    const QUOTA_POLL_MS = 60000
    // Set by `apply`: reads a descendant Session's priced view from the Host.
    // Module-scope rather than a slot-injected prop, so a Host that cannot serve
    // the read leaves the meter at the open Session's own cost instead of failing
    // the registration.
    let readChildCost
    /** Depth/count guard so a pathological tree cannot pin the render loop. */
    const MAX_DESCENDANTS = 64

    const EN = {
      'pill.label': 'Chat cost',
      'pill.perK': 'per 1K tokens',
      'panel.title': 'Chat usage',
      'panel.requests': 'Requests',
      'panel.inputMiss': 'Input (uncached)',
      'panel.cacheHit': 'Input (cache hit)',
      'panel.cacheWrite': 'Cache write',
      'panel.cacheRate': 'Cache hit rate',
      'panel.output': 'Output',
      'panel.peak': 'Peak hours',
      'panel.offPeak': 'Off-peak',
      'panel.note': 'DeepSeek prices are the official CNY list; OpenCode Go prices are the USD list from its models endpoint. Peak windows apply per model.',
      'panel.estimated': 'A model without a configured rate was priced with the default rates.',
      'panel.perK': 'Per 1K tokens',
      'panel.perM': 'Per 1M tokens',
      'panel.cacheSaved': 'Cache saved',
      'panel.own': 'This chat',
      'panel.children': 'Subagent sessions',
      'panel.excluded': '{requests} request(s), {tokens} tokens, ran on a provider with no rate card here and are not priced.',
      'panel.deepseek': 'DeepSeek platform',
      'panel.opencode': 'OpenCode Go',
      'quota.title': 'OpenCode Go allowance',
      'quota.rolling': '5-hour',
      'quota.weekly': 'Weekly',
      'quota.monthly': 'Monthly',
      'quota.resets': 'resets in',
      'quota.used': 'used',
      'quota.estimate': 'Percentages come from OpenCode. On the {plan} plan the 5-hour window is 20% and the weekly window 50% of the {limit}/month limit for {model}.',
      'quota.percentOnly': 'Percentages come from OpenCode; this model has no monthly limit configured, so only the percentages are shown.',
      'quota.missingKey': 'OpenCode API key missing',
      'quota.error': 'Allowance unavailable',
      'quota.stale': 'stale',
      'quota.updated': 'updated',
      'quota.refresh': 'Refresh',
      'quota.refreshing': 'Refreshing…',
      'quota.planGo': 'Go',
      'quota.planGoPlus': 'Go Plus',
      'quota.planGoTeams': 'Go Teams',
      'quota.noWindows': 'No allowance reported',
      'panel.close': 'Close',
    }

    // 中文 follows the shell's built-in locale; every other language falls back
    // to the English dictionary, which is also this module's literal fallback.
    const ZH = {
      'pill.label': '会话费用',
      'pill.perK': '每千 tokens',
      'panel.title': '会话用量',
      'panel.requests': '请求数',
      'panel.inputMiss': '输入（未命中缓存）',
      'panel.cacheHit': '输入（缓存命中）',
      'panel.cacheWrite': '缓存写入',
      'panel.cacheRate': '缓存命中率',
      'panel.output': '输出',
      'panel.peak': '高峰时段',
      'panel.offPeak': '空闲时段',
      'panel.note': 'DeepSeek 按官方人民币价目表，OpenCode Go 按模型接口公布的美元价目表；高峰时段按模型规则生效。',
      'panel.estimated': '未配置费率的模型按默认费率估算。',
      'panel.perK': '每千 tokens',
      'panel.perM': '每百万 tokens',
      'panel.cacheSaved': '缓存节省',
      'panel.own': '本会话',
      'panel.children': '子代理会话',
      'panel.excluded': '另有 {requests} 次请求、{tokens} 个 tokens 经未配置费率的提供方发送，未计入费用。',
      'panel.deepseek': 'DeepSeek 平台',
      'panel.opencode': 'OpenCode Go',
      'quota.title': 'OpenCode Go 额度',
      'quota.rolling': '5 小时',
      'quota.weekly': '每周',
      'quota.monthly': '每月',
      'quota.resets': '重置于',
      'quota.used': '已用',
      'quota.estimate': '百分比来自 OpenCode；在 {plan} 套餐中，5 小时窗口为 {model} 每月 {limit} 上限的 20%，每周窗口为 50%。',
      'quota.percentOnly': '百分比来自 OpenCode；该模型未配置每月上限，因此只显示百分比。',
      'quota.missingKey': '缺少 OpenCode API 密钥',
      'quota.error': '额度不可用',
      'quota.stale': '已过期',
      'quota.updated': '更新于',
      'quota.refresh': '刷新',
      'quota.refreshing': '刷新中…',
      'quota.planGo': 'Go',
      'quota.planGoPlus': 'Go Plus',
      'quota.planGoTeams': 'Go Teams',
      'quota.noWindows': '未返回额度',
      'panel.close': '关闭',
    }

    const CSS = `
.dcm-root{display:inline-flex;align-items:center;gap:2px;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));direction:ltr;unicode-bidi:isolate}
.dcm-pill{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}
.dcm-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcm-pill[aria-expanded='true']{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcm-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcm-pill[disabled]{cursor:default;opacity:.7}
.dcm-mark{opacity:.7}
.dcm-sep{color:var(--dsw-alias-separator-primary);margin:0 1px}
.dcm-rate{color:var(--dsw-alias-label-tertiary);font-size:.92em;opacity:.85}
.dcm-warn{color:var(--dsw-alias-state-warn-primary)}
.dcm-error{color:var(--dsw-alias-state-error-primary)}
.dcm-dim{opacity:.65}
.dcm-panel{position:fixed;z-index:1100;box-sizing:border-box;padding:14px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 10px 30px rgba(0,0,0,.18));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;direction:ltr;text-align:left;max-height:calc(100dvh - 24px);overflow-y:auto}
.dcm-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-weight:500}
.dcm-title button{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;padding:0 2px}
.dcm-title button:hover{color:var(--dsw-alias-label-secondary)}
.dcm-rule{margin:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.dcm-section{margin:0 0 4px;color:var(--dsw-alias-label-primary);font-weight:500}
.dcm-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dcm-grid{display:grid;grid-template-columns:minmax(104px,auto) minmax(0,1fr) auto;gap:6px 14px;margin:0}
.dcm-grid dt{min-width:0;margin:0;color:var(--dsw-alias-label-tertiary)}
.dcm-grid dd{min-width:0;margin:0;font-variant-numeric:tabular-nums}
.dcm-tokens{color:var(--dsw-alias-label-tertiary);text-align:right}
.dcm-money{text-align:right;color:var(--dsw-alias-label-secondary)}
.dcm-foot{margin-top:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dcm-quota{display:flex;flex-direction:column;gap:8px;margin:2px 0 0}
.dcm-qrow{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:2px 10px;align-items:center}
.dcm-qlabel{color:var(--dsw-alias-label-secondary)}
.dcm-qpct{font-variant-numeric:tabular-nums;text-align:right;color:var(--dsw-alias-label-secondary)}
.dcm-bar{grid-column:1 / -1;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dcm-bar>span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.dcm-bar>span.dcm-warn{background:var(--dsw-alias-state-warn-primary)}
.dcm-bar>span.dcm-error{background:var(--dsw-alias-state-error-primary)}
.dcm-qmeta{grid-column:1 / -1;display:flex;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.dcm-qmeta span:last-child{text-align:right;font-variant-numeric:tabular-nums}
.dcm-quota-foot{display:flex;justify-content:space-between;gap:12px;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dcm-quota-foot button{border:none;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;cursor:pointer;padding:0}
.dcm-quota-foot button[disabled]{opacity:.6;cursor:default}
`

    const CURRENCIES = {
      CNY: { symbol: '¥', title: 'panel.deepseek', plan: 'DeepSeek' },
      USD: { symbol: '$', title: 'panel.opencode', plan: 'OpenCode Go' },
    }

    /**
     * Money text with a precision that suits the amount.
     * @param {number} value - amount in the group's currency.
     * @param {string} code - `CNY` or `USD`.
     * @returns {string} display text.
     */
    function formatMoney(value, code) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const symbol = CURRENCIES[code]?.symbol ?? ''
      const magnitude = Math.abs(amount)
      let digits
      if (code === 'USD') {
        digits = magnitude === 0 ? 2 : magnitude < 0.0001 ? 6 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2
      } else {
        digits = magnitude === 0 ? 2 : magnitude < 0.1 ? 4 : magnitude < 10 ? 3 : 2
      }
      return `${symbol}${amount.toFixed(digits)}`
    }

    /**
     * Unit-rate text: three significant digits, trailing zeros dropped, never in
     * exponent notation (the rate is read, not computed with).
     * @param {number | null} value - price per 1K tokens.
     * @param {string} code - `CNY` or `USD`.
     * @returns {string | null} display text.
     */
    function formatRate(value, code) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      const symbol = CURRENCIES[code]?.symbol ?? ''
      const rounded = Number(value.toPrecision(3))
      if (rounded === 0) return null
      const digits = Math.min(14, Math.max(2, Math.ceil(-Math.log10(rounded)) + 2))
      const text = rounded.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
      return `${symbol}${text}`
    }

    /**
     * Grouped integer token count.
     * @param {number} value - token count.
     * @returns {string} display text.
     */
    function formatTokens(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return Math.round(amount).toLocaleString('en-US')
    }

    /**
     * Compact percentage reading.
     * @param {number | null} value - percentage.
     * @returns {string | null} display text.
     */
    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return `${value >= 99.95 ? 100 : Math.round(value)}%`
    }

    /**
     * Severity class for a used percentage.
     * @param {number | null} percent - used share.
     * @returns {string} CSS class suffix, or an empty string.
     */
    function severityClass(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return ''
      if (percent >= 95) return ' dcm-error'
      if (percent >= 80) return ' dcm-warn'
      return ''
    }

    /**
     * Countdown text between now and an ISO instant.
     * @param {string | null} iso - reset instant.
     * @param {number} now - current epoch milliseconds.
     * @returns {string | null} display text.
     */
    function resetText(iso, now) {
      if (typeof iso !== 'string') return null
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return null
      const minutes = Math.max(0, Math.round((at - now) / 60000))
      if (minutes < 1) return 'now'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h ${minutes % 60}m`
      return `${Math.floor(hours / 24)}d ${hours % 24}h`
    }

    /**
     * Every session below `rootId` in the session tree, breadth first.
     *
     * The tree comes from the client's session list, whose rows carry `parentId`
     * for subagent and workflow children. A row outside the loaded list is not
     * visited, so a very large tree degrades to its loaded prefix rather than
     * costing a read per node.
     *
     * @param {Record<string, any>} byId - the session list's rows.
     * @param {string} rootId - the open Session.
     * @returns {string[]} descendant ids, parents before children.
     */
    function collectDescendants(byId, rootId) {
      if (byId === null || typeof byId !== 'object') return []
      const children = new Map()
      for (const row of Object.values(byId)) {
        const parent = row?.parentId
        if (typeof parent !== 'string') continue
        const bucket = children.get(parent)
        if (bucket === undefined) children.set(parent, [row.id])
        else bucket.push(row.id)
      }
      const out = []
      const queue = [rootId]
      const seen = new Set(queue)
      while (queue.length > 0 && out.length < MAX_DESCENDANTS) {
        const id = queue.shift()
        for (const child of children.get(id) ?? []) {
          if (seen.has(child)) continue
          seen.add(child)
          out.push(child)
          queue.push(child)
          if (out.length >= MAX_DESCENDANTS) break
        }
      }
      return out
    }

    /** @returns {{ cacheMiss: number, cacheHit: number, cacheWrite: number, output: number, total: number }} zero buckets. */
    function emptyTokens() {
      return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0 }
    }

    /**
     * Add one priced view's groups into a per-currency accumulator.
     * @param {any} acc - accumulator.
     * @param {any} view - one Session's `chatCost` view.
     * @returns {void}
     */
    function accumulate(acc, view) {
      if (view === null || typeof view !== 'object') return
      const groups = view.groups !== null && typeof view.groups === 'object' ? view.groups : {}
      for (const [code, group] of Object.entries(groups)) {
        if (group === null || typeof group !== 'object') continue
        const target = acc.groups.get(code) ?? {
          code,
          requests: 0,
          total: 0,
          peak: 0,
          offPeak: 0,
          cacheSaving: 0,
          estimated: false,
          tokens: emptyTokens(),
          models: new Map(),
        }
        target.requests += Number(group.requests) || 0
        target.total += Number(group.total) || 0
        target.peak += Number(group.peak) || 0
        target.offPeak += Number(group.offPeak) || 0
        target.cacheSaving += Number(group.cacheSaving) || 0
        target.estimated = target.estimated || group.estimated === true
        const tokens = group.tokens ?? {}
        for (const key of ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']) {
          target.tokens[key] += Number(tokens[key]) || 0
        }
        for (const model of Array.isArray(group.models) ? group.models : []) {
          const name = String(model.model)
          const row = target.models.get(name)
            ?? { model: name, known: model.known !== false, total: 0, peak: 0, offPeak: 0, tokens: emptyTokens() }
          row.known = row.known && model.known !== false
          row.total += Number(model.total) || 0
          row.peak += Number(model.peak) || 0
          row.offPeak += Number(model.offPeak) || 0
          const counts = model.tokens ?? {}
          for (const key of ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']) {
            row.tokens[key] += Number(counts[key]) || 0
          }
          target.models.set(name, row)
        }
        acc.groups.set(code, target)
      }
      if (view.excluded !== null && typeof view.excluded === 'object') {
        acc.excluded.requests += Number(view.excluded.requests) || 0
        acc.excluded.tokens += Number(view.excluded.tokens) || 0
      }
    }

    /**
     * Finalize one accumulated currency block: derive the blended rates from the
     * sums so a combined figure can never drift from its parts.
     * @param {any} group - accumulated block.
     * @returns {any} the group view.
     */
    function finalizeGroup(group) {
      const tokens = group.tokens
      const billedInput = tokens.cacheMiss + tokens.cacheHit + tokens.cacheWrite
      const total = billedInput + tokens.output
      const models = [...group.models.values()].sort((left, right) => right.total - left.total)
      for (const row of models) {
        const counts = row.tokens
        row.tokens.total = counts.cacheMiss + counts.cacheHit + counts.cacheWrite + counts.output
      }
      return {
        code: group.code,
        requests: group.requests,
        total: group.total,
        peak: group.peak,
        offPeak: group.offPeak,
        cacheSaving: group.cacheSaving,
        estimated: group.estimated,
        tokens: { ...tokens, total },
        cacheHitPercent: billedInput > 0 ? (tokens.cacheHit / billedInput) * 100 : null,
        per1k: total > 0 ? (group.total / total) * 1000 : null,
        per1m: total > 0 ? (group.total / total) * 1_000_000 : null,
        models,
      }
    }

    /**
     * Combine the open Session's priced view with its children's.
     *
     * Money and tokens are summed per currency first and the derived figures are
     * recomputed from the sums. Averaging the per-session rates instead would be
     * wrong: it is the same weighting mistake as an unweighted mean, once per
     * child. Each currency stays separate — CNY and USD are not convertible here.
     *
     * @param {any} own - the open Session's view.
     * @param {readonly any[]} childViews - descendant views that are available.
     * @returns {any} the combined view, plus `ownTotals`, `childTotals`, `childCount`.
     */
    function combineViews(own, childViews) {
      const children = Array.isArray(childViews) ? childViews.filter(Boolean) : []
      const acc = { groups: new Map(), excluded: { requests: 0, tokens: 0 } }
      accumulate(acc, own)
      for (const view of children) accumulate(acc, view)
      const groups = {}
      for (const [code, group] of acc.groups) groups[code] = finalizeGroup(group)
      const totals = code => (groups[code]?.total ?? 0)
      return {
        groups,
        excluded: acc.excluded,
        model: own?.model ?? null,
        provider: own?.provider ?? null,
        usdPlan: own?.usdPlan ?? 'go',
        ownTotals: own?.groups ?? {},
        childTotals: children.reduce((map, view) => {
          for (const [code, group] of Object.entries(view.groups ?? {})) {
            map[code] = (map[code] ?? 0) + (Number(group.total) || 0)
          }
          return map
        }, {}),
        childCount: children.length,
        total: Object.keys(groups).reduce((sum, code) => sum + totals(code), 0),
      }
    }

    /**
     * Total requests across every currency block.
     * @param {any} view - combined view.
     * @returns {number} requests.
     */
    function totalRequests(view) {
      if (view === null || typeof view !== 'object') return 0
      return Object.values(view.groups ?? {}).reduce((sum, group) => sum + (Number(group.requests) || 0), 0)
    }

    /**
     * Read the allowance once per open Session, then on every committed usage
     * change and a slow backstop. The Host caches the upstream call, so several
     * tabs share one request.
     * @param {string | null} model - USD model id whose monthly limit applies.
     * @param {string} signature - projection usage signature.
     * @returns {{ quota: any, loading: boolean, refresh: () => Promise<void> }} quota seat.
     */
    function useQuota(model, signature) {
      const [state, setState] = React.useState({ quota: null, loading: false, error: null })
      const inFlight = React.useRef(false)
      const read = React.useCallback(async force => {
        if (typeof model !== 'string' || model === '') return
        if (inFlight.current) return
        inFlight.current = true
        setState(previous => ({ ...previous, loading: true }))
        try {
          if (force) {
            await fetch(`${API}/refresh?model=${encodeURIComponent(model)}`, {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
            })
          }
          const response = await fetch(`${API}/quota?model=${encodeURIComponent(model)}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const body = await response.json()
          if (response.ok && body?.ok === true) {
            setState({ quota: body.quota, loading: false, error: null })
          } else {
            setState({ quota: body?.quota ?? null, loading: false, error: body?.error ?? `http-${response.status}` })
          }
        } catch (error) {
          setState(previous => ({ ...previous, loading: false, error: String(error?.message ?? error) }))
        } finally {
          inFlight.current = false
        }
      }, [model])

      React.useEffect(() => {
        if (typeof model !== 'string' || model === '') {
          setState({ quota: null, loading: false, error: null })
          return undefined
        }
        void read(false)
        const timer = setInterval(() => { void read(false) }, QUOTA_POLL_MS)
        return () => clearInterval(timer)
      }, [model, signature, read])

      const refresh = React.useCallback(() => read(true), [read])
      return { quota: state.quota, loading: state.loading, error: state.error, refresh }
    }

    /**
     * A clock that re-renders slowly so reset countdowns move without polling the
     * Host (and without touching the model).
     * @param {number} intervalMs - tick period.
     * @returns {number} current epoch milliseconds.
     */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }

    /**
     * One reading row: label, optional middle reading, optional amount.
     * @param {string} key - React key prefix.
     * @param {string} label - row label.
     * @param {string} middle - middle cell text ('' keeps the column).
     * @param {string} amount - amount cell text ('' keeps the column).
     * @returns {React.ReactNode[]} the row's three cells.
     */
    function row(key, label, middle, amount) {
      return [
        h('dt', { key: `${key}-l` }, label),
        h('dd', { key: `${key}-m`, className: 'dcm-tokens' }, middle),
        h('dd', { key: `${key}-a`, className: 'dcm-money' }, amount),
      ]
    }

    /**
     * One allowance window: label, used percentage, progress bar, reset.
     * @param {any} props - entry, label, now, tr.
     * @returns {React.ReactNode} the row.
     */
    function quotaRow({ key, label, window: entry, now, tr }) {
      const percent = entry?.percent
      const shown = formatPercent(percent)
      const reset = resetText(entry?.resetsAt, now)
      const reading = shown === null ? '' : `${shown} ${tr('quota.used')}`
      return h('div', { className: 'dcm-qrow', key, 'data-quota-window': key, title: `${label}: ${reading}` },
        h('span', { className: 'dcm-qlabel' }, label),
        h('span', { className: 'dcm-qpct' }, shown ?? '—'),
        h('span', { className: 'dcm-sub', style: { gridColumn: '3', textAlign: 'right' } }, reset === null ? '' : `${tr('quota.resets')} ${reset}`),
        h('span', { className: 'dcm-bar', 'aria-hidden': true },
          h('span', {
            className: severityClass(percent).trim(),
            style: { width: `${Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0))}%` },
          })),
        entry?.status && entry.status !== 'ok'
          ? h('span', { className: 'dcm-qmeta' }, h('span', null, entry.status), h('span', null, ''))
          : null,
      )
    }

    /**
     * The panel's content for one combined view and its allowance.
     * @param {any} props - value, quota, refreshing, onRefresh, now, tr.
     * @returns {React.ReactNode[]} content rows.
     */
    function panelContent({ value, quota, refreshing, onRefresh, now, tr }) {
      const blocks = []
      const planKey = value.usdPlan === 'go-plus' ? 'quota.planGoPlus' : value.usdPlan === 'go-teams' ? 'quota.planGoTeams' : 'quota.planGo'
      // Allowance first: it is the reading that changes without a model call.
      if (value.groups.USD !== undefined) {
        const windows = ['rolling', 'weekly', 'monthly']
          .map(key => ({ key, window: quota?.windows?.[key] ?? null }))
          .filter(entry => entry.window !== null)
        blocks.push(h('div', { key: 'quota-section' },
          h('div', { className: 'dcm-section' }, tr('quota.title')),
          windows.length === 0
            ? h('div', { className: 'dcm-sub' },
              quota?.hasKey === false
                ? tr('quota.missingKey')
                : (quota?.error === 'missing-key' ? tr('quota.missingKey') : (quota?.error ?? tr('quota.noWindows'))))
            : h('div', { className: 'dcm-quota' }, windows.map(entry => quotaRow({
              key: entry.key,
              label: tr(`quota.${entry.key}`),
              window: entry.window,
              now,
              tr,
            }))),
          quota?.monthlyLimitUsd !== null && quota?.monthlyLimitUsd !== undefined
            ? h('div', { className: 'dcm-foot' }, tr('quota.estimate')
              .replace('{plan}', tr(planKey))
              .replace('{limit}', formatMoney(quota.monthlyLimitUsd, 'USD'))
              .replace('{model}', quota.model ?? ''))
            : h('div', { className: 'dcm-foot' }, tr('quota.percentOnly')),
          h('div', { className: 'dcm-quota-foot' },
            h('span', null,
              quota?.fetchedAt ? `${tr('quota.updated')} ${new Date(quota.fetchedAt).toLocaleTimeString()}` : '',
              quota?.stale ? ` · ${tr('quota.stale')}` : '',
              quota?.error && quota.ok ? ` · ${quota.error}` : ''),
            h('button', { type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? tr('quota.refreshing') : tr('quota.refresh'))),
        ))
      }
      for (const code of ['CNY', 'USD']) {
        const group = value.groups[code]
        if (group === undefined) continue
        const meta = CURRENCIES[code] ?? { symbol: '', title: 'panel.title', plan: code }
        const tokens = group.tokens
        const cells = []
        const perK = formatRate(group.per1k, code)
        const perM = formatRate(group.per1m, code)
        if (perK !== null) cells.push(...row(`${code}-perk`, tr('panel.perK'), '', perK))
        if (perM !== null) cells.push(...row(`${code}-perm`, tr('panel.perM'), '', perM))
        if (value.childCount > 0) {
          const own = value.ownTotals?.[code]?.total ?? 0
          const children = value.childTotals?.[code] ?? 0
          cells.push(...row(`${code}-own`, tr('panel.own'), '', formatMoney(own, code)))
          cells.push(...row(`${code}-children`, tr('panel.children'), String(value.childCount), formatMoney(children, code)))
        }
        cells.push(...row(`${code}-requests`, tr('panel.requests'), formatTokens(group.requests), ''))
        cells.push(...row(`${code}-miss`, tr('panel.inputMiss'), formatTokens(tokens.cacheMiss), ''))
        cells.push(...row(`${code}-hit`, tr('panel.cacheHit'), formatTokens(tokens.cacheHit), ''))
        if (tokens.cacheWrite > 0) cells.push(...row(`${code}-write`, tr('panel.cacheWrite'), formatTokens(tokens.cacheWrite), ''))
        cells.push(...row(`${code}-output`, tr('panel.output'), formatTokens(tokens.output), ''))
        const hitRate = formatPercent(group.cacheHitPercent)
        if (hitRate !== null) cells.push(...row(`${code}-rate`, tr('panel.cacheRate'), '', hitRate))
        if (group.cacheSaving > 0) cells.push(...row(`${code}-saved`, tr('panel.cacheSaved'), '', formatMoney(group.cacheSaving, code)))
        if (group.offPeak > 0) {
          cells.push(...row(`${code}-peak`, tr('panel.peak'), '', formatMoney(group.peak, code)))
          cells.push(...row(`${code}-offpeak`, tr('panel.offPeak'), '', formatMoney(group.offPeak, code)))
        }
        if (group.models.length > 0) {
          for (const [index, entry] of group.models.entries()) {
            const name = entry.known === false ? `${entry.model}*` : entry.model
            cells.push(...row(`${code}-model-${index}`, name, formatTokens(entry.tokens.total), formatMoney(entry.total, code)))
          }
        }
        blocks.push(h('div', { key: `${code}-section` },
          h('div', { className: 'dcm-section' }, `${tr(meta.title)} · ${code}`),
          h('dl', { className: 'dcm-grid' }, cells),
          group.estimated ? h('div', { className: 'dcm-sub dcm-warn' }, tr('panel.estimated')) : null,
        ))
      }
      if (value.excluded.requests > 0) {
        blocks.push(h('div', { key: 'excluded', className: 'dcm-sub dcm-warn' },
          tr('panel.excluded')
            .replace('{requests}', formatTokens(value.excluded.requests))
            .replace('{tokens}', formatTokens(value.excluded.tokens))))
      }
      return [
        h('div', { key: 'title', className: 'dcm-title' },
          h('span', null, tr('panel.title')),
          h('span', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
            ...Object.keys(value.groups).map(code => h('span', { key: code, style: { fontVariantNumeric: 'tabular-nums' } },
              formatMoney(value.groups[code].total, code))))),
        h('div', { key: 'rule', className: 'dcm-rule' }),
        ...blocks,
        h('div', { key: 'note', className: 'dcm-foot' }, tr('panel.note')),
      ]
    }

    /**
     * The dock entry: one cost pill per used currency, plus the allowance pill
     * when OpenCode Go billed part of the Session.
     * @param {any} props - value, quota, quotaError, refreshing, onRefresh, tr.
     * @returns {React.ReactNode} the pill row and its panel.
     */
    function Meter({ value, quota, refreshing, onRefresh, tr }) {
      const [open, setOpen] = React.useState(false)
      const [placement, setPlacement] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const now = useNow(30000)

      const closePanel = React.useCallback(() => setOpen(false), [])
      const openPanel = React.useCallback(() => {
        const node = triggerRef.current
        const width = Math.min(PANEL_WIDTH, Math.max(240, window.innerWidth - VIEWPORT_INSET * 2))
        if (node !== null) {
          const rect = node.getBoundingClientRect()
          const centered = rect.left + rect.width / 2 - width / 2
          setPlacement({
            width,
            left: Math.max(VIEWPORT_INSET, Math.min(centered, window.innerWidth - width - VIEWPORT_INSET)),
            bottom: Math.max(VIEWPORT_INSET, window.innerHeight - rect.top + PANEL_GAP),
          })
        }
        setOpen(true)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = event => {
          const target = event.target
          if (triggerRef.current !== null && triggerRef.current.contains(target)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          closePanel()
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') closePanel()
        }
        const onViewportChange = () => closePanel()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onViewportChange)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onViewportChange)
        }
      }, [open, closePanel])

      const costPills = []
      for (const code of ['CNY', 'USD']) {
        const group = value.groups[code]
        if (group === undefined) continue
        const amount = formatMoney(group.total, code)
        const text = group.estimated ? `≈${amount}` : amount
        const rate = formatRate(group.per1k, code)
        const rateText = rate === null ? null : `${rate}/1K`
        const label = rateText === null
          ? `${tr('pill.label')} ${amount}`
          : `${tr('pill.label')} ${amount}, ${rateText} ${tr('pill.perK')}`
        costPills.push(h('button', {
          key: `cost-${code}`,
          type: 'button',
          className: 'dcm-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label,
          title: label,
          'data-cost-currency': code,
          onClick: () => { (open ? closePanel : openPanel)() },
        },
        h('span', null, text),
        rateText === null ? null : h('span', { className: 'dcm-sep', 'aria-hidden': true }, '·'),
        rateText === null ? null : h('span', { className: 'dcm-rate', title: tr('pill.perK') }, rateText)))
      }

      let quotaPill = null
      if (value.groups.USD !== undefined) {
        const windows = ['rolling', 'weekly', 'monthly']
          .map(key => ({ key, window: quota?.windows?.[key] ?? null }))
          .filter(entry => entry.window !== null)
        const segments = windows.map((entry, index) => h(React.Fragment, { key: entry.key },
          index === 0 ? null : h('span', { className: 'dcm-sep', 'aria-hidden': true }, '·'),
          h('span', { className: `${severityClass(entry.window.percent)}` },
            `${entry.key === 'rolling' ? '5h' : entry.key === 'weekly' ? '7d' : '30d'} ${formatPercent(entry.window.percent) ?? '—'}`)))
        const title = windows.length === 0
          ? (quota?.hasKey === false ? tr('quota.missingKey') : (quota?.error ?? tr('quota.error')))
          : windows.map(entry => {
            const reset = resetText(entry.window.resetsAt, now)
            const percent = formatPercent(entry.window.percent) ?? '—'
            return `${tr(`quota.${entry.key}`)}: ${percent} ${tr('quota.used')}${reset === null ? '' : ` (${tr('quota.resets')} ${reset})`}`
          }).join('\n')
        quotaPill = h('button', {
          type: 'button',
          className: 'dcm-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': tr('quota.title'),
          title,
          'data-quota': 'window',
          onClick: () => { (open ? closePanel : openPanel)() },
        },
        h('span', { className: 'dcm-mark', 'aria-hidden': true }, '⏳'),
        windows.length === 0
          ? h('span', { className: 'dcm-dim' }, quota?.hasKey === false ? tr('quota.missingKey') : tr('quota.error'))
          : h('span', null, segments))
      }

      const panel = open && placement !== null
        ? createPortal(
          h('div', {
            ref: panelRef,
            className: 'dcm-panel',
            role: 'dialog',
            'aria-label': tr('panel.title'),
            style: {
              left: `${placement.left}px`,
              bottom: `${placement.bottom}px`,
              width: `${placement.width}px`,
            },
          }, panelContent({ value, quota, refreshing, onRefresh, now, tr })),
          document.body,
        )
        : null

      return h('span', { className: 'dcm-root', ref: triggerRef },
        h('style', null, CSS),
        quotaPill,
        costPills,
        panel)
    }

    /**
     * Pick the better of a polled child value and its list-row summary.
     *
     * Both are exact readings of the same log taken at different moments, and a
     * session's cost only moves by whole samples, so the larger total is the
     * newer reading in practice. Preferring it closes the gap left by a poll that
     * landed just before the child settled, without waiting for the next list
     * refresh.
     *
     * @param {any} polled - value read from the Host while the child ran.
     * @param {any} summary - the session list row's summary value.
     * @returns {any} the reading to use, or undefined.
     */
    function newestOf(polled, summary) {
      if (polled === undefined || polled === null) return summary
      if (summary === undefined || summary === null) return polled
      const weight = view => Object.values(view?.groups ?? {}).reduce((sum, group) => sum + (Number(group.tokens?.total) || 0), 0)
      return weight(polled) >= weight(summary) ? polled : summary
    }

    /**
     * Slot entry: the open Session plus every descendant Session, rendered only
     * once something has been billed.
     *
     * @param {object} props - standard slot props and the dock's locale seat.
     * @returns {React.ReactNode} the meter, or null.
     */
    function ChatCostPill(props) {
      const value = props.useProjection(PROJECTION_KEY)
      const byId = props.useSessions(state => state?.byId)
      const sessionId = props.sessionId
      const fetchCost = readChildCost
      const t = props.t
      const tr = React.useCallback(
        key => {
          if (typeof t === 'function') {
            const translated = t(key)
            if (typeof translated === 'string' && translated !== key) return translated
          }
          return EN[key] ?? key
        },
        [t],
      )

      const descendants = React.useMemo(
        () => collectDescendants(byId, typeof sessionId === 'string' ? sessionId : ''),
        [byId, sessionId],
      )
      // Only running children need a live read: a live Session's projection is a
      // synchronous snapshot on the Host, while a settled one is already carried
      // by its list row.
      const runningKey = React.useMemo(
        () => descendants.filter(id => byId?.[id]?.running === true).join('|'),
        [descendants, byId],
      )
      const [polled, setPolled] = React.useState({})
      // A settled child whose list row carries no value yet: one read folds its
      // log on the Host, caches the checkpoint and fills the row, so the figure
      // covers children that predate the plugin instead of silently dropping them.
      const pendingKey = React.useMemo(
        () => descendants.filter(id => byId?.[id]?.running !== true
          && polled[id] === undefined
          && byId?.[id]?.projectionValues?.[PROJECTION_KEY] == null).join('|'),
        [descendants, byId, polled],
      )
      const attempted = React.useRef(new Set())

      React.useEffect(() => {
        if (typeof fetchCost !== 'function') return undefined
        const running = runningKey === '' ? [] : runningKey.split('|')
        const pending = (pendingKey === '' ? [] : pendingKey.split('|'))
          .filter(id => !attempted.current.has(id))
        if (running.length === 0 && pending.length === 0) return undefined
        let cancelled = false
        const read = async ids => {
          for (const id of ids) {
            attempted.current.add(id)
            try {
              const view = await fetchCost(id)
              if (cancelled || view === null || view === undefined) continue
              setPolled(previous => {
                const current = previous[id]
                if (current !== undefined
                  && current.groups?.USD?.total === view.groups?.USD?.total
                  && current.groups?.CNY?.total === view.groups?.CNY?.total
                  && current.groups?.USD?.requests === view.groups?.USD?.requests
                  && current.groups?.CNY?.requests === view.groups?.CNY?.requests) return previous
                return { ...previous, [id]: view }
              })
            } catch {
              // A child that just settled or is not readable through this peer.
            }
          }
        }
        void read([...running, ...pending])
        if (running.length === 0) {
          return () => {
            cancelled = true
          }
        }
        const timer = setInterval(() => { void read(running) }, CHILD_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [runningKey, pendingKey, fetchCost])

      const childViews = React.useMemo(() => {
        const views = []
        for (const id of descendants) {
          const row = byId?.[id]
          const view = newestOf(polled[id], row?.projectionValues?.[PROJECTION_KEY])
          if (view !== undefined && view !== null) views.push(view)
        }
        return views
      }, [descendants, polled, byId])

      const combined = React.useMemo(
        () => (value === undefined || value === null ? null : combineViews(value, childViews)),
        [value, childViews],
      )
      const usdGroup = combined?.groups?.USD
      const usdModel = usdGroup?.models?.[0]?.model ?? (value?.provider === 'opencode-go' ? value?.model : null)
      const signature = React.useMemo(() => {
        if (value === null || value === undefined) return ''
        return Object.entries(value.groups ?? {})
          .map(([code, group]) => `${code}:${group.requests}:${group.tokens?.total ?? 0}`)
          .join('|')
      }, [value])
      const { quota, loading, refresh } = useQuota(usdGroup === undefined ? null : (usdModel ?? ''), signature)
      if (combined === null || totalRequests(combined) === 0) return null
      return h(Meter, { value: combined, quota, refreshing: loading, onRefresh: refresh, tr })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => {
            try {
              return locale.register(NS, { en: EN, zh: ZH })
            } catch {
              // Another live copy of this plugin already owns the namespace.
              return () => {}
            }
          }, 'chat-cost: dictionary')
        }
        // The Host's projection read for any Session: a synchronous snapshot while
        // the Session is live, a stored-log fold while it is cold. Only running
        // children are read this way, and any failure leaves the reader absent
        // rather than failing the registration below.
        try {
          const sessionRemote = ctx.get('remote')?.session
          if (typeof sessionRemote?.projections === 'function') {
            readChildCost = async childId => {
              const result = await sessionRemote.projections({ sessionId: childId })
              return result === null || result === undefined ? null : result.values?.[PROJECTION_KEY] ?? null
            }
          }
        } catch {
          readChildCost = undefined
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'chat-cost',
          order: 2,
          locale: NS,
        }, ChatCostPill))
      },
    }
  },
})
