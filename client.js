/**
 * dsh-model-quick-picker — 浏览器半身。
 *
 * 影子替换官方模型选择器（conversation.input.model，priority -10，lowest renders），
 * 并在 conversation.input.right 追加一个显示「当前供应商附加信息」的小标。
 *
 * 设计要点：
 * - 双栏（左供应商 / 右模型）+ 常显搜索 + 最近使用 + 推理等级，面板定高，
 *   由底边定位（top = triggerTop - 8 - height），高度必须恒定否则悬停切换
 *   供应商时面板顶边抖动。
 * - 附加信息三个适配器（relay / channel / official）全部能力探测：失败返回
 *   null，什么都不渲染。附加信息永远只是装饰，不能拖垮选择器。
 * - 渲染包错误边界：崩溃只让本插件退场，绝不弄丢模型入口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-quick-picker',
  factory(require) {
    const React = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const { useState, useRef, useMemo, useEffect, useCallback, useSyncExternalStore } = React

    // 图标用 ?. 防御：primitives 版本更名时返回 undefined，React 对
    // <undefined /> 会抛错导致整个 seat abdicate——这是硬性教训。
    const IconChevronDown = P?.IconChevronDownOutlineRegular ?? P?.IconChevronDownOutlineMedium
    const IconChevronRight = P?.IconChevronRightOutlineRegular ?? P?.IconChevronRightOutlineMedium
    const IconSearch = P?.IconSearchOutlineRegular ?? P?.IconSearchOutlineMedium
    const IconThink = P?.IconThinkOutlineRegular ?? P?.IconThinkOutlineMedium
    const IconClock = P?.IconNowrapFillRegular // 最近使用用小时钟更贴切则换
    const IconRecent = P?.IconRefreshOutlineRegular ?? P?.IconRefreshOutlineMedium
    const IconWarning = P?.IconWarningOutlineRegular ?? P?.IconWarningOutlineMedium

    const PLUGIN_ID = 'model-quick-picker'
    const RECENT_KEY = 'dsh-model-quick-picker.recent'
    const RECENT_MAX = 6

    // ─────────────────────────────────────────────────────────────────────
    // 附加信息：数据源适配器
    //
    // resolveExtras(routeId) → { label, detail, tone? } | null
    //
    // relay    — usage-billing 的 /api/billing/relay-quotas（键 route === 目录 group.id，
    //            所以能直接 join，零映射成本）。
    // channel  — our-free-model channel-pack 的 RPC credits.balances（键 provider === 渠道路由 id）。
    //            口径与 our-free-model 设置页「剩余积分 N」完全一致：balance.total 求和。
    // official — usage-billing 的 /api/billing/balance（键是中文显示名，需别名表）。
    // ─────────────────────────────────────────────────────────────────────

    const CHANNEL_IDS = new Set([
      'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
      'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
    ])

    // 与 our-free-model client.js 的 CHANNEL_CREDITS 逐字段一致（unit 决定 label）。
    const CHANNEL_CREDITS = {
      codearts: { claim: true },
      buddy: { claim: true, status: true },
      workbuddy: {},
      lobsterai: { claim: true },
      qoder: { claim: true },
      qodercn: { claim: true },
      trae: { claim: true },
      cline: { unit: 'dollars' },
      loomy: { claim: true },
      raccoon: {},
      minimax: { claim: true, status: true },
      zcode: { claim: true, unit: 'tokens' },
      gemini: { unit: 'quota', quota: true },
    }

    // 官方余额按显示名匹配（ProviderBalance.provider 是显示名如 "DeepSeek"），
    // 路由 id → 显示名的别名表；没收录的路由查不到就静默不显示。
    const OFFICIAL_ALIASES = {
      'deepseek': ['DeepSeek', 'deepseek'],
      'deepseek-official': ['DeepSeek', 'deepseek'],
      'deepseek-account': ['DeepSeek', 'deepseek'],
    }

    const extrasCache = new Map() // source → { at, data }
    const EXTRAS_TTL = 60_000

    async function fetchJson(path, timeoutMs = 8000) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(path, { redirect: 'error', signal: ctrl.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
      } finally {
        clearTimeout(timer)
      }
    }

    function cacheGet(source) {
      const hit = extrasCache.get(source)
      if (hit && Date.now() - hit.at < EXTRAS_TTL) return hit.data
      return undefined
    }
    function cacheSet(source, data) {
      extrasCache.set(source, { at: Date.now(), data })
    }

    async function loadRelayQuotas() {
      const cached = cacheGet('relay')
      if (cached !== undefined) return cached
      try {
        const doc = await fetchJson('/api/billing/relay-quotas')
        const rows = Array.isArray(doc?.quotas) ? doc.quotas : []
        cacheSet('relay', rows)
        return rows
      } catch {
        cacheSet('relay', [])
        return []
      }
    }

    async function loadOfficialBalances() {
      const cached = cacheGet('official')
      if (cached !== undefined) return cached
      try {
        const doc = await fetchJson('/api/billing/balance')
        const rows = Array.isArray(doc?.balances) ? doc.balances : []
        cacheSet('official', rows)
        return rows
      } catch {
        cacheSet('official', [])
        return []
      }
    }

    /**
     * channel-pack 的 credits.balances RPC —— 与 our-free-model 设置页
     * 「剩余积分 N」同一个数据源、同一个口径。ctx 从调用方传进来。
     * 返回 { accounts: [{accountId, nickname, balance, error?}] } | null。
     */
    async function loadChannelBalances(ctx, provider) {
      const cacheKey = `channel:${provider}`
      const cached = cacheGet(cacheKey)
      if (cached !== undefined) return cached
      let connection
      try { connection = ctx?.connection } catch { connection = undefined }
      if (connection === undefined && typeof ctx?.get === 'function') {
        try { connection = ctx.get('connection') } catch { connection = undefined }
      }
      // connection 没挂载（非 shell 组合）或还没就绪：不缓存，下次再试
      if (connection === undefined || connection?.rpc?.call === undefined) {
        return null
      }
      const ctrl = new AbortController()
      // 首次调用可能触发远端余额查询（秒级，设置页用的是 90s），给 20s
      const timer = setTimeout(() => ctrl.abort(), 20_000)
      try {
        const result = await connection.rpc.call('/api', 'channel-pack', {
          method: 'credits.balances',
          payload: { provider },
        }, ctrl.signal)
        const value = result?.ok === true ? result.value : null
        if (value === null) {
          // 失败（账号未登录/渠道不支持等）缓存 null 避免反复打
          cacheSet(cacheKey, null)
          console.warn(`[model-quick-picker] credits.balances(${provider}) 失败:`,
            result?.error?.message ?? result?.error?.code ?? 'unknown')
        } else {
          cacheSet(cacheKey, value)
        }
        return value
      } catch (error) {
        // 超时/异常：不缓存，让下次重试
        console.warn(`[model-quick-picker] credits.balances(${provider}) 异常:`, String(error))
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    function moneyText(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' || currency === undefined ? '¥' : `${currency} `
      return `${symbol}${value.toFixed(2)}`
    }

    /**
     * 从 credits.balances 响应汇总一行徽章文本。
     *
     * 口径与 our-free-model 设置页 ChannelCard 表头完全一致（逐行核对过）：
     * - balancesTotal = Σ balance.total（只算 Number.isFinite 的行）
     * - 全部不可读 → 返回 null（设置页显示 —，我们不渲染）
     * - balance 形状：积分/Token 渠道是对象 {total, packages[]}；美元渠道（cline）是 number
     * - label 按 CHANNEL_CREDITS[unit] 分流：tokens→Token / dollars→$ / 缺省→积分
     */
    function channelBadgeText(provider, snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return null
      const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
      if (accounts.length === 0) return null
      const capability = CHANNEL_CREDITS[provider]
      if (capability === undefined) return null
      if (capability.unit === 'dollars') {
        const dollarKnown = accounts.filter((row) => typeof row?.balance === 'number' && Number.isFinite(row.balance))
        if (dollarKnown.length === 0) return null
        const total = dollarKnown.reduce((sum, row) => sum + row.balance, 0)
        return { label: '余额', detail: `$${total.toFixed(2)}` }
      }
      const known = accounts.filter((row) => Number.isFinite(row?.balance?.total))
      if (known.length === 0) return null
      if (capability.quota) {
        // gemini：设置页逐包显示「包名 剩余%」，徽章里给条数摘要
        return { label: '配额', detail: `${known.length} 项` }
      }
      const total = known.reduce((sum, row) => sum + row.balance.total, 0)
      const isToken = capability.unit === 'tokens'
      return { label: isToken ? 'Token' : '积分', detail: kilo(total) }
    }

/** 与 our-free-model 同口径的数字缩写（1.2K / 3.4M）。 */
    function kilo(value) {
      const n = Math.round(Number(value) || 0)
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      return String(n)
    }

    function quotaWindowText(windows) {
      if (!Array.isArray(windows) || windows.length === 0) return null
      const row = windows.find((w) => typeof w?.remainingPercent === 'number')
        ?? windows.find((w) => typeof w?.usedPercent === 'number')
      if (row === undefined) return null
      const pct = typeof row.remainingPercent === 'number'
        ? row.remainingPercent
        : 100 - row.usedPercent
      if (!Number.isFinite(pct)) return null
      return `额度 ${Math.round(pct)}%`
    }

    /**
     * 附加信息主入口。永不抛错；读不出一律 null。
     * @returns {Promise<{label:string,detail:string}|null>}
     */
    async function resolveExtras(ctx, routeId) {
      if (typeof routeId !== 'string' || routeId === '') return null
      try {
        if (CHANNEL_IDS.has(routeId)) {
          if (CHANNEL_CREDITS[routeId] === undefined) return null // workbuddy/raccoon 无积分能力
          const snapshot = await loadChannelBalances(ctx, routeId)
          return channelBadgeText(routeId, snapshot)
        }
        const relays = await loadRelayQuotas()
        const relay = relays.find((row) => row?.route === routeId)
        if (relay !== undefined && relay.status !== 'unknown') {
          const parts = []
          const balance = moneyText(relay.balance, relay.currency)
          if (balance !== null) parts.push(`余额 ${balance}`)
          const win = quotaWindowText(relay.windows)
          if (win !== null) parts.push(win)
          if (parts.length > 0) return { label: '中转', detail: parts.join(' · ') }
          return null
        }
        const aliases = OFFICIAL_ALIASES[routeId]
        if (aliases !== undefined) {
          const rows = await loadOfficialBalances()
          const row = rows.find((b) => aliases.includes(b?.provider) && b?.isAvailable === true)
          if (row !== undefined) {
            const balance = moneyText(row.totalBalance, row.currency)
            if (balance !== null) return { label: '官方', detail: `余额 ${balance}` }
          }
        }
        return null
      } catch {
        return null
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 样式（跟随宿主主题 token；面板用不透明底，避免丢 blur 后透底）
    // ─────────────────────────────────────────────────────────────────────

    const STYLES = {
      panel: {
        position: 'fixed',
        zIndex: 1100,
        display: 'flex',
        flexDirection: 'column',
        width: 560,
        height: 448, // 定高：底边定位的硬约束（含底部常驻的思考等级横排）
        borderRadius: 'var(--dsw-radius-md, 10px)',
        background: 'var(--dsw-alias-bg-layer-1, #232324)',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
        boxShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,0.45))',
        color: 'var(--dsw-alias-label-primary, #fff)',
        fontFamily: 'inherit',
        fontSize: 13,
        overflow: 'hidden',
        userSelect: 'none',
      },
      searchRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
        flex: 'none',
      },
      searchInput: {
        flex: 1,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
      },
      columns: {
        flex: 1,
        display: 'flex',
        minHeight: 0,
      },
      colLeft: {
        width: 200,
        flex: 'none',
        overflowY: 'auto',
        borderRight: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
        padding: '4px 0',
      },
      colRight: {
        flex: 1,
        overflowY: 'auto',
        padding: '4px 0',
      },
      providerRow: {
        width: '100%',
        padding: '6px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 0,
      },
      providerRowHover: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
      },
      providerRowActive: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.1))',
      },
      providerName: {
        fontSize: 13,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary, #fff)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      providerMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        lineHeight: '15px',
        color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45))',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      modelRow: {
        width: '100%',
        padding: '5px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        borderRadius: 0,
      },
      modelName: {
        fontSize: 13,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-primary, #fff)',
      },
      check: {
        color: 'var(--dsw-alias-state-business-primary, #4d9fff)',
        flex: 'none',
        fontSize: 12,
      },
      sectionTitle: {
        padding: '6px 12px 2px',
        fontSize: 11,
        lineHeight: '15px',
        color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45))',
      },
      empty: {
        padding: '20px 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-dimmed, rgba(255,255,255,0.35))',
        textAlign: 'center',
      },
      statusRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-state-warn-label, #e0a23c)',
      },
      // 底部推理等级：横排直选，不再进次级菜单
      effortBar: {
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.6))',
        flexWrap: 'wrap',
      },
      effortLabel: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flex: 'none',
        marginRight: 2,
      },
      effortChip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: '17px',
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
        color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.6))',
        font: 'inherit',
        whiteSpace: 'nowrap',
        transition: 'background 80ms ease, border-color 80ms ease',
      },
      effortChipActive: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.14))',
        borderColor: 'var(--dsw-alias-state-business-primary, #4d9fff)',
        color: 'var(--dsw-alias-label-primary, #fff)',
        fontWeight: 600,
      },
      trigger: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: 'min(360px, 45cqw)',
        height: 28,
        padding: '0 6px 0 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        // 与相邻的 composer 控件（模型/权限）保持同一观感，但按用户要求
        // 加一圈可见的描边，让「这是一个可点的选择区」更明确。
        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))',
        background: 'transparent',
        color: 'var(--dsh-composer-model-text-display, inherit)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      triggerText: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.6))',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))',
        whiteSpace: 'nowrap',
        maxWidth: 260,
        overflow: 'hidden',
      },
      chipDetail: {
        color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45))',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    }

    function StyleInjector() {
      return h('style', null, `
.mqp-panel::-webkit-scrollbar, .mqp-col::-webkit-scrollbar { width: 8px; }
.mqp-panel::-webkit-scrollbar-thumb, .mqp-col::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(255,255,255,0.12));
  border-radius: 4px;
}
.mqp-panel { scrollbar-width: thin; }
.mqp-col { scrollbar-width: thin; }

/* 触发器 hover 反馈（与官方 composer 控件同一观感） */
.mqp-trigger { transition: background 120ms ease; }
.mqp-trigger:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); }
.mqp-trigger:active { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.14)); }

/* 面板展开动画：从触发器方向轻微上浮 + 淡入，120ms，不抢眼 */
@keyframes mqp-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.mqp-panel { animation: mqp-in 120ms ease-out; transform-origin: bottom left; }

/* 行 hover 反馈 */
.mqp-row { transition: background 80ms ease; }
.mqp-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06)); }
`)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 组件
    // ─────────────────────────────────────────────────────────────────────

    function CheckMark() {
      return h('span', { style: STYLES.check }, '✓')
    }

    function ProviderRow({ group, modelCount, extras, active, hovered, onHover, loading }) {
      const style = {
        ...STYLES.providerRow,
        ...(hovered ? STYLES.providerRowHover : {}),
        ...(active ? STYLES.providerRowActive : {}),
      }
      return h('button', {
        className: 'mqp-row',
        style,
        onMouseEnter: onHover,
        onFocus: onHover,
        type: 'button',
      },
        h('span', { style: STYLES.providerName }, group.name),
        h('span', { style: STYLES.providerMeta },
          loading
            ? '…'
            : h(React.Fragment, null,
                h('span', null, `${modelCount}`),
                extras !== undefined && extras !== null
                  ? h('span', null, `· ${extras.detail}`)
                  : null,
              ),
        ),
      )
    }

    function ModelRow({ model, active, onClick }) {
      return h('button', {
        className: 'mqp-row',
        style: { ...STYLES.modelRow, ...(active ? STYLES.providerRowActive : {}) },
        onClick,
        type: 'button',
      },
        h('span', { style: STYLES.modelName }, model.name ?? model.id),
        active ? h(CheckMark) : null,
      )
    }

    function SearchBox({ value, onChange, inputRef }) {
      return h('div', { style: STYLES.searchRow },
        IconSearch !== undefined
          ? h(IconSearch, { size: 14, style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } })
          : null,
        h('input', {
          ref: inputRef,
          style: STYLES.searchInput,
          placeholder: '搜索模型…',
          value,
          onChange: (e) => onChange(e.target.value),
          onKeyDown: (e) => {
            // 让 Escape 关面板、Enter 选中，其余按键留在输入框
            if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              e.stopPropagation()
              e.target.blur()
              // 转发给面板键盘处理
              const panel = e.target.closest('.mqp-panel')
              panel?.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }))
            }
          },
        }),
      )
    }

    /**
     * 主面板。
     * props: { open, anchorRect, directory, load, select, ctx, onClose, locked }
     * directory = directory.store（uSES 消费）
     */
    function PickerPanel(props) {
      const { anchorRect, directory, select, ctx, onClose, locked } = props
      const state = useSyncExternalStore(
        (fn) => directory.subscribe(fn),
        () => directory.getSnapshot(),
      )

      const [query, setQuery] = useState('')
      const [hoverProvider, setHoverProvider] = useState(null) // null = 跟随 current
      const [extrasMap, setExtrasMap] = useState({}) // routeId → {label,detail} | null | undefined
      const panelRef = useRef(null)
      const listRef = useRef(null)

      const groups = useMemo(() => {
        const list = Array.isArray(state?.groups) ? state.groups : []
        // 官方排序：deepseek-account、deepseek-official 优先，其余保持目录顺序
        const rank = (id) => (id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2)
        return [...list].sort((a, b) => rank(a.id) - rank(b.id))
      }, [state])

      const failures = useMemo(() => (Array.isArray(state?.failures) ? state.failures : []), [state])
      const current = state?.current ?? null
      // select() 在等待远程结果期间把选择写进 pending（乐观值），
      // 用它驱动高亮，点击后立刻看到反馈，不必等一次往返。
      const pending = state?.pending ?? null

      // 附加信息懒加载：打开面板时并发拉，不轮询
      useEffect(() => {
        if (!props.open) return
        let cancelled = false
        for (const group of groups) {
          setExtrasMap((prev) => {
            if (prev[group.id] !== undefined) return prev
            resolveExtras(ctx, group.id).then((value) => {
              if (!cancelled) setExtrasMap((p) => ({ ...p, [group.id]: value }))
            })
            return { ...prev, [group.id]: null } // 先占位 null（= 查询中不渲染）
          })
        }
        return () => { cancelled = true }
      }, [props.open, groups, ctx])

      // 悬停切换供应商；键盘/点击后固定
      const activeProviderId = hoverProvider ?? current?.provider ?? groups[0]?.id ?? null
      const activeGroup = groups.find((g) => g.id === activeProviderId) ?? null

      // 搜索过滤（跨供应商：命中时右栏展开为「供应商 › 模型」平铺）
      const searching = query.trim() !== ''
      const q = query.trim().toLowerCase()
      const searchResults = useMemo(() => {
        if (!searching) return []
        const out = []
        for (const group of groups) {
          for (const model of group.models) {
            const id = String(model.id).toLowerCase()
            const name = String(model.name ?? model.id).toLowerCase()
            if (id.includes(q) || name.includes(q) || group.name.toLowerCase().includes(q)) {
              out.push({ group, model })
            }
          }
        }
        return out
      }, [searching, q, groups])

      // 右栏列表（非搜索态）：当前供应商的模型
      const rightRows = useMemo(() => {
        if (searching) return searchResults
        if (activeGroup === null) return []
        return activeGroup.models.map((model) => ({ group: activeGroup, model }))
      }, [searching, searchResults, activeGroup])

      // 最近使用
      const recent = useMemo(() => {
        try {
          const raw = localStorage.getItem(RECENT_KEY)
          const list = raw === null ? [] : JSON.parse(raw)
          if (!Array.isArray(list)) return []
          const out = []
          for (const item of list.slice(0, RECENT_MAX)) {
            const group = groups.find((g) => g.id === item.provider)
            const model = group?.models.find((m) => m.id === item.model)
            if (group && model) out.push({ group, model })
          }
          return out
        } catch {
          return []
        }
      }, [groups, props.open]) // eslint-disable-line react-hooks/exhaustive-deps

      const pushRecent = useCallback((provider, model) => {
        try {
          const raw = localStorage.getItem(RECENT_KEY)
          let list = raw === null ? [] : JSON.parse(raw)
          if (!Array.isArray(list)) list = []
          list = [{ provider, model }, ...list.filter((x) => !(x.provider === provider && x.model === model))]
          localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
        } catch { /* 存不了就算了 */ }
      }, [])

      const doSelect = useCallback(async (group, model) => {
        if (locked) return
        const selection = { provider: group.id, model: model.id }
        // 该模型有等级 → 默认档；无等级不带字段
        const result = await select(selection)
        pushRecent(group.id, model.id)
        onClose()
        return result
      }, [locked, select, pushRecent, onClose])

      const selectEffort = useCallback(async (effortId) => {
        if (locked) return
        // ⚠ 必须用 current（当前生效的供应商/模型），不能用 activeGroup：
        // 底部等级条描述的是 current 模型的档位，而 activeGroup 是左栏悬停项，
        // 两者可以不同（悬停另一个供应商但没点选模型）。
        const provider = current?.provider
        const model = current?.model
        if (provider === undefined || model === undefined || model === null) return
        // 不关面板：等级是可反复试的旋钮，用户常要连着换几档比较。
        // 面板保持打开，选中态由 store 更新驱动高亮。
        await select({ provider, model, reasoningEffort: effortId })
      }, [locked, current, select])

      // 定位：底边对齐触发器上方 8px
      const panelStyle = useMemo(() => {
        if (anchorRect === null) return { ...STYLES.panel, display: 'none' }
        const width = 560
        const height = 448
        let left = anchorRect.left
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
        const top = Math.max(8, anchorRect.top - 8 - height)
        return { ...STYLES.panel, left, top, width, height }
      }, [anchorRect])

      // 键盘：↑↓ 移动，Enter 选中，Escape 关闭
      const onKeyDown = useCallback((e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
        const rows = searching ? searchResults : rightRows
        if (rows.length === 0) return
        const activeIdx = rows.findIndex((r) =>
          r.group.id === current?.provider && r.model.id === current?.model)
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const next = Math.min(rows.length - 1, activeIdx + 1)
          const target = rows[Math.max(0, next)]
          setHoverProvider(target.group.id)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          const next = Math.max(0, activeIdx - 1)
          const target = rows[next]
          setHoverProvider(target.group.id)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const idx = activeIdx >= 0 ? activeIdx : 0
          const target = rows[idx]
          if (target) doSelect(target.group, target.model)
        }
      }, [searching, searchResults, rightRows, current, doSelect, onClose])

      // 点击面板外关闭。
      //
      // ⚠ 必须放过触发器自己：本监听器挂在 document 的 **capture** 阶段，
      // mousedown 先于触发器的 click 到达，若在这里关闭，紧接着 click 里的
      // openPanel() 又会重新打开——于是「再点一次触发器」永远关不掉。
      useEffect(() => {
        if (!props.open) return
        const handler = (e) => {
          const target = e.target
          if (target instanceof Element && target.closest('.mqp-trigger') !== null) return
          if (panelRef.current !== null && !panelRef.current.contains(target)) onClose()
        }
        document.addEventListener('mousedown', handler, true)
        return () => document.removeEventListener('mousedown', handler, true)
      }, [props.open, onClose])

      if (!props.open) return null

      const effort = current !== null
        ? state?.groups?.find((g) => g.id === current.provider)?.models
            ?.find((m) => m.id === current.model)?.reasoning
        : undefined

      return h('div', {
        ref: panelRef,
        style: panelStyle,
        className: 'mqp-panel',
        onKeyDown,
      },
        h(StyleInjector),
        h(SearchBox, { value: query, onChange: setQuery }),
        h('div', { style: STYLES.columns, ref: listRef },
          // ── 左栏 ──
          !searching
            ? h('div', { style: STYLES.colLeft, className: 'mqp-col' },
                recent.length > 0
                  ? h('div', { style: STYLES.sectionTitle }, '最近')
                  : null,
                recent.map(({ group, model }) =>
                  h('button', {
                    key: `r:${group.id}:${model.id}`,
                    type: 'button',
                    className: 'mqp-row',
                    style: {
                      ...STYLES.modelRow,
                      ...(group.id === current?.provider && model.id === current?.model ? STYLES.providerRowActive : {}),
                    },
                    onClick: () => doSelect(group, model),
                  },
                    h('span', { style: { ...STYLES.modelName, fontSize: 12 } },
                      `${model.name ?? model.id}`),
                    h('span', { style: STYLES.providerMeta }, group.name),
                  )),
                recent.length > 0
                  ? h('div', { style: { ...STYLES.sectionTitle, borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 4, paddingTop: 8 } }, '供应商')
                  : null,
                groups.map((group) =>
                  h(ProviderRow, {
                    key: group.id,
                    group,
                    modelCount: group.models.length,
                    extras: extrasMap[group.id],
                    active: group.id === activeProviderId,
                    hovered: group.id === hoverProvider,
                    onHover: () => setHoverProvider(group.id),
                  })),
                failures.length > 0
                  ? h('div', { style: STYLES.statusRow },
                      h(IconWarning === undefined ? 'span' : IconWarning, { size: 12 }),
                      h('span', null, `${failures.length} 个供应商加载失败`),
                    )
                  : null,
              )
            : null,
          // ── 右栏 ──
          h('div', { style: STYLES.colRight, className: 'mqp-col' },
            rightRows.length === 0
              ? h('div', { style: STYLES.empty },
                  searching ? '没有匹配的模型' : '该供应商暂无可用模型')
              : rightRows.map(({ group, model }) =>
                  h(ModelRow, {
                    key: `${group.id}:${model.id}`,
                    model,
                    active: group.id === current?.provider && model.id === current?.model,
                    onClick: () => doSelect(group, model),
                    })),
          ),
        ),
        // ── 底部：推理等级横排直选（不进次级菜单，点选不关面板） ──
        effort?.efforts?.length > 0
          ? h('div', { style: STYLES.effortBar },
              h('span', { style: STYLES.effortLabel },
                IconThink !== undefined ? h(IconThink, { size: 16 }) : null,
                h('span', null, '思考等级'),
              ),
              effort.efforts.map((e) => {
                // 选中态优先读 pending（select() 在等待期间写入的乐观值），
                // 再退回 current；否则点击后要等一次远程往返才看到高亮移动。
                const chosen = pending?.reasoningEffort ?? current?.reasoningEffort
                const active = chosen === e.id
                  || (chosen === undefined && effort.defaultEffort === e.id)
                const busy = state?.status === 'selecting' && pending?.reasoningEffort === e.id
                return h('button', {
                  key: e.id,
                  type: 'button',
                  className: 'mqp-effort',
                  style: {
                    ...STYLES.effortChip,
                    ...(active ? STYLES.effortChipActive : {}),
                    ...(busy ? { opacity: 0.6 } : {}),
                  },
                  title: e.description ?? e.name ?? e.id,
                  onClick: () => selectEffort(e.id),
                }, e.name ?? e.id)
              }),
            )
          : null,
      )
    }

    // ─────────────────────────────────────────────────────────────────────
    // 模型 seat 组件（conversation.input.model）
    // ─────────────────────────────────────────────────────────────────────

    function ModelSeat(props) {
      const { locked, available, directory, load, select, ctx, t } = props
      const state = useSyncExternalStore(
        (fn) => directory.subscribe(fn),
        () => directory.getSnapshot(),
      )
      const [open, setOpen] = useState(false)
      const [anchorRect, setAnchorRect] = useState(null)
      const triggerRef = useRef(null)

      const label = useMemo(() => {
        if (state?.current !== null && state?.current !== undefined) {
          const group = state.groups?.find((g) => g.id === state.current.provider)
          const model = group?.models.find((m) => m.id === state.current.model)
          return model?.name ?? state.current.model
        }
        return '模型'
      }, [state])

      const togglePanel = useCallback(() => {
        // 第二次点击触发器 = 关闭（toggle）
        if (open) { setOpen(false); return }
        // 打开时才量锚点并触发目录加载；副作用留在 updater 之外，
        // 避免 StrictMode 下 updater 被调用两次而重复执行。
        const rect = triggerRef.current?.getBoundingClientRect?.() ?? null
        setAnchorRect(rect === null ? null : { left: rect.left, top: rect.top, width: rect.width, height: rect.height })
        load?.()
        setOpen(true)
      }, [open, load])

      if (locked || !available) return null

      return h(React.Fragment, null,
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'mqp-trigger',
          style: STYLES.trigger,
          onClick: togglePanel,
          title: label,
          'aria-expanded': open ? 'true' : 'false',
        },
          h('span', { style: STYLES.triggerText }, label),
          IconChevronDown !== undefined
            // ⚠ primitives 的图标只解构 { size, className, strokeWidth }，
            // 传入的 style 会被丢弃（svg 上没有 style 属性）——所以旋转必须由
            // 外层 span 承载，不能挂在图标组件上。
            ? h('span', {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  flex: 'none',
                  opacity: 0.7,
                  transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 140ms ease',
                },
              }, h(IconChevronDown, { size: 14 }))
            : null,
        ),
        open
          ? h(PickerPanel, {
              open,
              anchorRect,
              directory,
              select,
              ctx,
              locked,
              onClose: () => setOpen(false),
            })
          : null,
      )
    }

    // ─────────────────────────────────────────────────────────────────────
    // composer 小标（conversation.input.right）
    // ─────────────────────────────────────────────────────────────────────

    function ProviderChip(props) {
      const { store, ctx } = props
      // store 不可用（服务未就绪）时安静退场，不依赖错误边界
      const usable = store !== null && store !== undefined
        && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function'
      const state = useSyncExternalStore(
        React.useCallback((fn) => usable ? store.subscribe(fn) : () => {}, [store, usable]),
        React.useCallback(() => usable ? store.getSnapshot() : null, [store, usable]),
      )
      const current = state?.current ?? null
      const [extras, setExtras] = useState(undefined) // undefined = 查询中不渲染

      const routeId = current?.provider

      useEffect(() => {
        if (routeId === undefined || routeId === null) return
        let cancelled = false
        setExtras(undefined)
        resolveExtras(ctx, routeId).then((value) => {
          if (!cancelled) {
            setExtras(value)
            if (value === null) {
              console.info(`[model-quick-picker] 小标无数据: route=${routeId}（无匹配适配器或数据源未返回）`)
            } else {
              console.info(`[model-quick-picker] 小标: route=${routeId} -> ${value.label} ${value.detail}`)
            }
          }
        })
        return () => { cancelled = true }
      }, [routeId, ctx])

      if (!usable || current === null || extras === undefined || extras === null) return null

      return h('span', { style: STYLES.chip, title: `${extras.label} · ${extras.detail}` },
        h('span', null, extras.label),
        h('span', { style: STYLES.chipDetail }, extras.detail),
      )
    }

    // ─────────────────────────────────────────────────────────────────────
    // 错误边界：崩溃只让本插件退场
    // ─────────────────────────────────────────────────────────────────────

    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        // 静默：console 留一条便于排查，但不打扰用户
        console.warn('[model-quick-picker] render error:', error)
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 注册
    // ─────────────────────────────────────────────────────────────────────

    return {
      // ⚠ inject 声明的是 **Cordis 服务名**，不是包名。
      // 证据：官方 @deepseek-ai/dsh-client-ui-model-selection 的 client.js 里
      //   const inject = ["commandUi","locale","sessions","slots","remote","remote.session"]
      //   exports.inject = inject
      // 包名只出现在 package.json 的 dsh.client 声明里（模块图排序用），两者不可混用。
      // 我的插件用到：slots（注册槽位）、sessions + modelDirectories + remote*（
      // directoryFor(sessionId) 这条链路需要，见 ModelDirectoryResolver 自身 inject）。
      inject: ['slots', 'sessions', 'modelDirectories', 'remote', 'remote.session'],
      apply(ctx) {
        // 整个注册过程包一层：任何异常都只让本插件退场（console 留痕），
        // 绝不能冒泡成 FAILED fiber —— 那会牵连整个 client 组合。
        try {
          // 1) 影子替换官方模型选择器：single slot 一个 cell，priority -10
          //    低于官方的 0（lowest renders），winners 取第一个 live entry。
          ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
            name: 'conversation.input.model',
            priority: -10,
            inject: (sessionId) => {
              const directory = ctx.modelDirectories.directoryFor(sessionId)
              const available = ctx.sessions.subagentAddress(sessionId) === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => {})
                },
                select: (selection) => available ? directory.select(selection) : Promise.resolve(undefined),
                ctx,
              }
            },
          }, (props) => h(Guard, null, h(ModelSeat, props))))
        } catch (error) {
          console.error('[model-quick-picker] 模型选择器注册失败:', error)
        }

        try {
          // 2) composer 小标：list slot，独立 id，与 usage-billing 的 chip 并存
          ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
            name: 'conversation.input.right',
            id: 'model-quick-picker-chip',
            order: 2,
            inject: (sessionId) => {
              const directory = ctx.modelDirectories.directoryFor(sessionId)
              // ⚠ 必须传 store：组件用 useSyncExternalStore 消费
              //   directory.subscribe / directory.getSnapshot，
              // 这两个方法是 store 上的，传实例会直接抛错。
              return { store: directory.store, ctx }
            },
          }, (props) => h(Guard, null, h(ProviderChip, props))))
        } catch (error) {
          console.error('[model-quick-picker] 积分小标注册失败:', error)
        }
      },
    }
  },
})
