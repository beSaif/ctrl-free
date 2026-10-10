// N04 Lines: filter tabs, search, table grouped by product type (review) or area (all).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useT } from '../i18n'
import { usePricing } from '../api/hooks'
import type { Position } from '../api/types'
import { AssistTag, ErrorBox, FilterTabs, IconChevron, LinkButton, Button, Loading, SearchBox, type TabItem } from '../components/ui'
import { cx } from '../lib/cx'
import { FooterTotals } from '../components/FooterTotals'
import { fmt2, fmtQty, fmtUnit } from '../lib/format'
import { isSupplier, lineStatus, matchView, productLabel, quotedPrice, type LineFilter } from '../lib/lines'
import { linesQuery, useCatalog, useLineFilter, useLineQueue } from './linesShared'

export const LINE_GRID = 'grid grid-cols-[56px_minmax(0,1.5fr)_52px_40px_minmax(0,1fr)_92px_104px_112px_184px] gap-x-3'

export function Lines() {
  const { id = '' } = useParams()
  const t = useT()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [filter, q, setFilter] = useLineFilter()
  const [search, setSearch] = useState(q)
  const { rows, queue, counts, positions, isLoading, error } = useLineQueue(id, filter, q)
  const { data: pr } = usePricing(id)
  const cat = useCatalog()
  const [sel, setSel] = useState<string | null>(params.get('sel'))
  const rowRefs = useRef<Record<string, HTMLAnchorElement | null>>({})

  // Large lists open with the biggest groups expanded and the rest collapsed (one click each, or all).
  const groupOf = useMemo(() => {
    const m: Record<string, string> = {}
    let g = ''
    for (const r of rows) {
      if (r.type === 'group') g = r.key
      else m[r.p.lv_id] = g
    }
    return m
  }, [rows])
  const groupKeys = useMemo(() => rows.filter((r) => r.type === 'group').map((r) => r.key), [rows])
  const big = queue.length > 80 && !q
  // expanded/collapsed choices belong to one filter + search; switching starts fresh
  const fk = filter + '|' + q
  const [tog, setTog] = useState<{ k: string; v: Record<string, boolean> }>({ k: fk, v: {} })
  const toggled = tog.k === fk ? tog.v : {}
  const setToggled = (f: (x: Record<string, boolean>) => Record<string, boolean>) => setTog({ k: fk, v: f(toggled) })
  const isCollapsed = (key: string) => {
    if (key in toggled) return toggled[key]
    if (sel && groupOf[sel] === key) return false
    return big && groupKeys.indexOf(key) >= 5
  }
  const allOpen = groupKeys.every((k) => !isCollapsed(k))
  const setAll = (collapsed: boolean) => setToggled(() => Object.fromEntries(groupKeys.map((k) => [k, collapsed])))
  const visibleQueue = queue.filter((p) => !isCollapsed(groupOf[p.lv_id] ?? ''))

  useEffect(() => {
    const h = setTimeout(() => {
      if (search !== q) setFilter(filter, search)
    }, 200)
    return () => clearTimeout(h)
  }, [search, q, filter, setFilter])

  useEffect(() => {
    if (sel) rowRefs.current[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  // J / K move through the list, Enter opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      const vq = visibleQueue
      if (!vq.length) return
      const i = vq.findIndex((p) => p.lv_id === sel)
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        const n = vq[Math.min(vq.length - 1, i + 1)]
        setSel(n.lv_id)
        rowRefs.current[n.lv_id]?.focus()
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const n = vq[Math.max(0, i - 1)]
        setSel(n.lv_id)
        rowRefs.current[n.lv_id]?.focus()
      } else if (e.key === 'Enter' && !e.repeat && sel && el.tagName !== 'A' && el.tagName !== 'BUTTON') {
        nav(`/t/${id}/lines/${sel}${linesQuery(filter, q)}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleQueue, sel, nav, id, filter, q])

  const items: TabItem<LineFilter>[] = [
    { key: 'review', label: t('To review'), count: counts.review },
    { key: 'priced', label: t('Priced'), count: counts.priced },
    { key: 'all', label: t('All'), count: counts.all },
  ]
  if (counts.check) items.push({ key: 'check', label: t('Check this'), count: counts.check })
  if (counts.missing) items.push({ key: 'missing', label: t('Missing info'), count: counts.missing })
  if (counts.notpriced) items.push({ key: 'notpriced', label: t('Not priced'), count: counts.notpriced })

  const hint =
    filter === 'review'
      ? t('Same product type together, largest amount first')
      : filter === 'priced'
        ? t('Least sure match first')
        : filter === 'all'
          ? t('Tender order, by area')
          : t('Tender order')
  const reviewDone = filter === 'review' && counts.review === 0 && !q && positions.length > 0

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 px-6 py-2.5 border-b border-rule">
        <FilterTabs label={t('Filter lines')} items={items} value={filter} onChange={(f) => setFilter(f, q)} />
        <div className="flex-[1_1_200px]" />
        <span className="text-[13px] text-muted">{hint}</span>
        {groupKeys.length > 1 && (
          <button type="button" onClick={() => setAll(allOpen)} className="min-h-8 px-1 border-0 bg-transparent text-[13px] text-accent underline underline-offset-2">
            {allOpen ? t('Collapse all') : t('Expand all')}
          </button>
        )}
        <SearchBox value={search} onChange={setSearch} label={t('Search')} placeholder={t('Search lines or pages')} className="flex-[0_1_220px]" />
      </div>

      <main className="flex-auto">
        {isLoading ? (
          <Loading label={t('Loading')} />
        ) : error ? (
          <ErrorBox error={error} label={t('Could not load the lines.')} />
        ) : reviewDone ? (
          <div className="max-w-[640px] px-6 py-12 flex flex-col gap-3">
            <h1 className="m-0 text-[24px] font-semibold">{t('Review done')}</h1>
            <p className="m-0 text-muted">
              {t('Every line that needed you is confirmed.')} {t('Direct cost is now CHF {d}.', { d: fmt2(pr?.totals.direct) })}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <LinkButton to={`/t/${id}/instructions`} variant="primary">
                {t('Continue to instructions')}
              </LinkButton>
              <Button onClick={() => setFilter('all', '')}>{t('See all {n} lines', { n: positions.length })}</Button>
            </div>
          </div>
        ) : (
          <section aria-label={t('Lines')} className="overflow-x-auto">
            <div className="min-w-[1080px]">
              <div className={cx(LINE_GRID, 'px-6 py-2 border-b border-rule text-[13px] text-muted font-medium')} role="presentation">
                <span>{t('Page')}</span>
                <span>{t('Description (tender text)')}</span>
                <span className="text-right">{t('Qty')}</span>
                <span>{t('Unit')}</span>
                <span>{t('Product')}</span>
                <span className="text-right">{t('Unit price')}</span>
                <span className="text-right">{t('Total')}</span>
                <span>{t('Match')}</span>
                <span>{t('Status')}</span>
              </div>
              {rows.map((r) =>
                r.type === 'group' ? (
                  <button
                    type="button"
                    key={r.key}
                    onClick={() => setToggled((x) => ({ ...x, [r.key]: !isCollapsed(r.key) }))}
                    aria-expanded={!isCollapsed(r.key)}
                    className="flex items-center gap-2.5 w-full min-h-9 px-6 border-0 border-b border-rule bg-panel text-left text-ink hover:bg-rowrule"
                  >
                    <IconChevron open={!isCollapsed(r.key)} />
                    <span className="font-semibold">{r.name}</span>
                    <span className="text-muted">{r.meta}</span>
                    <span className="flex-auto" />
                    {r.req && (
                      <span className="text-[13px]" style={{ color: r.reqFg }}>
                        {r.req}
                      </span>
                    )}
                    <span className="font-mono min-w-[110px] text-right">{fmt2(r.sub)}</span>
                  </button>
                ) : isCollapsed(groupOf[r.p.lv_id] ?? '') ? null : (
                  <LineRow
                    key={r.p.lv_id}
                    p={r.p}
                    selected={r.p.lv_id === sel}
                    to={`/t/${id}/lines/${r.p.lv_id}${linesQuery(filter, q)}`}
                    product={productLabel(r.p, cat)}
                    refCb={(el) => {
                      rowRefs.current[r.p.lv_id] = el
                    }}
                  />
                ),
              )}
              {rows.length === 0 && <div className="px-6 py-8 text-muted">{q ? t('No line matches the search.') : t('No lines here.')}</div>}
              <div className="px-6 py-2.5 text-[13px] text-muted">
                {t('Showing {n} of {total} lines. Amounts in CHF, before transport, overhead and margin. Click a line to open it.', {
                  n: queue.length,
                  total: positions.length,
                })}{' '}
                <span className="hidden lg:inline">{t('Keys: J next, K previous, Enter opens.')}</span>
              </div>
            </div>
          </section>
        )}
      </main>
      <FooterTotals tenderId={id} />
    </div>
  )
}

function LineRow({
  p,
  selected,
  to,
  product,
  refCb,
}: {
  p: Position
  selected: boolean
  to: string
  product: string
  refCb: (el: HTMLAnchorElement | null) => void
}) {
  const t = useT()
  const st = lineStatus(p, t)
  const m = matchView(p, t)
  const quoted = quotedPrice(p)
  const byAssist = p.supplier_quote?.by === 'Assist'
  const pr = p.pricing
  return (
    <Link
      ref={refCb}
      to={to}
      aria-current={selected ? 'true' : undefined}
      className={cx(
        LINE_GRID,
        'items-center w-full min-h-9 px-6 py-1 border-b border-rowrule bg-white text-ink! no-underline hover:bg-panel',
        selected && 'row-selected',
      )}
    >
      <span className="font-mono text-[13px] text-muted">{p.page}</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={p.title_de}>
        {p.title_de}
      </span>
      <span className="font-mono text-right">{fmtQty(pr?.quantity ?? p.quantity)}</span>
      <span className="text-muted">{fmtUnit(p.unit)}</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted" title={product}>
        {product}
      </span>
      <span className="font-mono text-right whitespace-nowrap">
        {byAssist && isSupplier(p) && quoted !== null && (
          <span className="mr-1 align-middle">
            <AssistTag title={t('Filled by Assist from the supplier reply')} />
          </span>
        )}
        {pr ? fmt2(pr.net_unit_cost) : '–'}
      </span>
      <span className="font-mono text-right font-medium">{pr ? fmt2(pr.direct) : '–'}</span>
      <span className="text-[13px]" style={{ color: m.fg, fontWeight: m.strong ? 600 : 400 }}>
        {m.label}
      </span>
      <span className="flex items-center gap-2" style={{ color: st.fg }}>
        <span className="flex-none w-2 h-2" style={{ background: st.marker }} aria-hidden="true" />
        {st.label}
      </span>
    </Link>
  )
}
