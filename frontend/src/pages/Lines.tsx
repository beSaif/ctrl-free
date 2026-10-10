// N04 Lines: filter tabs, search, table grouped by product type (review) or area (all).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useT } from '../i18n'
import { usePricing } from '../api/hooks'
import type { Position } from '../api/types'
import { AssistTag, ErrorBox, FilterTabs, IconChevron, Kbd, LinkButton, Button, Loading, Marker, SearchBox, type TabItem } from '../components/ui'
import { cx } from '../lib/cx'
import { FooterTotals } from '../components/FooterTotals'
import { fmt2, fmtQty, fmtUnit } from '../lib/format'
import { C, isSupplier, lineStatus, matchView, productLabel, quotedPrice, type LineFilter, type LineGroupBy, type StatusView } from '../lib/lines'
import { groupParam, linesQuery, useCatalog, useLineFilter, useLineQueue } from './linesShared'

export const LINE_GRID = 'grid grid-cols-[56px_minmax(0,1.5fr)_52px_40px_minmax(0,1fr)_92px_104px_184px] gap-x-3'

// The person's own expand/collapse choices, per tender, filter, search and grouping, for this browser session
// (so going to a line and back keeps them).
const OPEN_KEY = 'ctrlfree.lines.groups'
type Toggles = Record<string, Record<string, boolean>>
function readToggles(): Toggles {
  try {
    return JSON.parse(sessionStorage.getItem(OPEN_KEY) || '{}') as Toggles
  } catch {
    return {}
  }
}

/** What a group header says about its lines: the status they share (said once, there; quiet on the rows)
 *  and, for the collapsed header, how many lines deviate from it. */
interface GroupStatus {
  quiet: string | null
  shared: StatusView | null
  odd: [string, number][]
}

export function Lines() {
  const { id = '' } = useParams()
  const t = useT()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [filter, q, setFilter, group, setGroup] = useLineFilter()
  const [search, setSearch] = useState(q)
  const { rows, queue, counts, positions, isLoading, error } = useLineQueue(id, filter, q)
  const { data: pr } = usePricing(id)
  const cat = useCatalog()
  const [sel, setSel] = useState<string | null>(params.get('sel'))
  const rowRefs = useRef<Record<string, HTMLAnchorElement | null>>({})
  const gp = groupParam(group)

  // "To review" opens with every group collapsed: the headers are the work list. Other large lists open
  // with the biggest groups expanded and the rest collapsed (one click each, or all). A search opens all.
  // In tender order a section sits inside its system: collapsing the system hides its sections too.
  const { groupOf, parentOf, status } = useMemo(() => {
    const m: Record<string, string> = {}
    const par: Record<string, string> = {}
    const views: Record<string, StatusView[]> = {}
    const supplierGroup: Record<string, boolean> = {}
    let g = ''
    for (const r of rows) {
      if (r.type === 'group') {
        g = r.key
        views[g] = []
        supplierGroup[g] = !!r.req
        if (r.parent) par[r.key] = r.parent
      } else {
        m[r.p.lv_id] = g
        const v = lineStatus(r.p, t)
        views[g]?.push(v)
        if (par[g]) views[par[g]]?.push(v)
      }
    }
    const st: Record<string, GroupStatus> = {}
    const needsQuote = t('Needs supplier quote')
    for (const [k, vs] of Object.entries(views)) {
      const same = vs.length > 0 && vs.every((v) => v.label === vs[0].label)
      // a supplier-request group implies "needs supplier quote"; its header says where the request stands
      const quiet = supplierGroup[k] ? needsQuote : same ? vs[0].label : null
      const odd = new Map<string, number>()
      for (const v of vs) if (v.label !== quiet && !isSilent(v)) odd.set(v.label, (odd.get(v.label) ?? 0) + 1)
      st[k] = { quiet, shared: !supplierGroup[k] && same && !isSilent(vs[0]) ? vs[0] : null, odd: [...odd].sort((a, b) => b[1] - a[1]) }
    }
    return { groupOf: m, parentOf: par, status: st }
  }, [rows, t])
  const groupKeys = useMemo(() => rows.filter((r) => r.type === 'group').map((r) => r.key), [rows])
  const topKeys = groupKeys.filter((k) => !parentOf[k])
  const big = queue.length > 80 && !q
  // expanded/collapsed choices belong to one tender + filter + search + grouping
  const fk = [id, filter, q, group].join('|')
  const [togs, setTogs] = useState<Toggles>(readToggles)
  const toggled = togs[fk] ?? {}
  const setToggled = (f: (x: Record<string, boolean>) => Record<string, boolean>) => setTogs((x) => ({ ...x, [fk]: f(x[fk] ?? {}) }))
  useEffect(() => {
    try {
      sessionStorage.setItem(OPEN_KEY, JSON.stringify(togs))
    } catch {
      /* private mode: keep in memory */
    }
  }, [togs])
  const isCollapsed = (key: string) => {
    if (key in toggled) return toggled[key]
    if (sel && (groupOf[sel] === key || parentOf[groupOf[sel]] === key)) return false
    if (filter === 'review' && !q) return !parentOf[key]
    return big && topKeys.indexOf(key) >= 5
  }
  const isHidden = (key: string) => isCollapsed(key) || (!!parentOf[key] && isCollapsed(parentOf[key]))
  const allOpen = groupKeys.every((k) => !isCollapsed(k))
  const setAll = (collapsed: boolean) => setToggled(() => Object.fromEntries(groupKeys.map((k) => [k, collapsed])))
  // J / K walk into groups that are only collapsed by default (opening them on the way) and skip the ones the person closed
  const closedByHand = (key: string) => toggled[key] === true || (!!parentOf[key] && toggled[parentOf[key]] === true)
  const walkQueue = queue.filter((p) => !closedByHand(groupOf[p.lv_id] ?? ''))
  const focusSel = useRef<string | null>(null)

  useEffect(() => {
    const h = setTimeout(() => {
      if (search !== q) setFilter(filter, search)
    }, 200)
    return () => clearTimeout(h)
  }, [search, q, filter, setFilter])

  useEffect(() => {
    if (!sel) return
    const el = rowRefs.current[sel]
    el?.scrollIntoView({ block: 'nearest' })
    if (el && focusSel.current === sel) {
      el.focus()
      focusSel.current = null
    }
  }, [sel, togs])

  // J / K move through the list, Enter opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      const vq = walkQueue
      if (!vq.length) return
      const i = vq.findIndex((p) => p.lv_id === sel)
      const go = (n: Position) => {
        const g = groupOf[n.lv_id] ?? ''
        if (isHidden(g)) setToggled((x) => ({ ...x, [g]: false, ...(parentOf[g] ? { [parentOf[g]]: false } : {}) }))
        focusSel.current = n.lv_id
        setSel(n.lv_id)
        rowRefs.current[n.lv_id]?.focus()
      }
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        go(vq[Math.min(vq.length - 1, i + 1)])
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        go(vq[Math.max(0, i - 1)])
      } else if (e.key === 'Enter' && !e.repeat && sel && el.tagName !== 'A' && el.tagName !== 'BUTTON') {
        nav(`/t/${id}/lines/${sel}${linesQuery(filter, q, groupParam(group))}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const items: TabItem<LineFilter>[] = [
    { key: 'review', label: t('To review'), count: counts.review },
    { key: 'priced', label: t('Priced'), count: counts.priced },
    { key: 'all', label: t('All'), count: counts.all },
  ]
  if (counts.check) items.push({ key: 'check', label: t('Check this'), count: counts.check })
  if (counts.missing) items.push({ key: 'missing', label: t('Missing info'), count: counts.missing })
  if (counts.notpriced) items.push({ key: 'notpriced', label: t('Not priced'), count: counts.notpriced })

  const hint =
    group === 'order'
      ? t('As printed: system, section, page')
      : filter === 'review'
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
        <GroupBy value={group} onChange={setGroup} hint={hint} />
        <div className="flex-[1_1_200px]" />
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
                <span>{t('Status')}</span>
              </div>
              {rows.map((r) =>
                r.type === 'group' ? (
                  r.parent && isCollapsed(r.parent) ? null : (
                  <button
                    type="button"
                    key={r.key}
                    onClick={() => setToggled((x) => ({ ...x, [r.key]: !isCollapsed(r.key) }))}
                    aria-expanded={!isCollapsed(r.key)}
                    className={cx(
                      'flex items-center gap-2.5 w-full min-h-9 px-6 border-0 border-b text-left text-ink',
                      r.parent ? 'pl-11 border-rowrule bg-white hover:bg-panel' : 'border-rule bg-panel hover:bg-rowrule',
                    )}
                  >
                    <IconChevron open={!isCollapsed(r.key)} />
                    <span className={r.parent ? 'font-medium' : 'font-semibold'}>{r.name}</span>
                    <span className="text-muted">{r.meta}</span>
                    <span className="flex-auto" />
                    {/* lines that differ from the group's status, counted while their rows are hidden */}
                    {isCollapsed(r.key) && status[r.key]?.odd.length > 0 && (
                      <span className="text-[13px] text-muted">
                        {status[r.key].odd.map(([label, n]) => t('{n} × {label}', { n, label })).join(' · ')}
                      </span>
                    )}
                    {r.req ? (
                      <span className="text-[13px] min-w-[150px]" style={{ color: r.reqFg }}>
                        {r.req}
                      </span>
                    ) : status[r.key]?.shared && status[r.key].shared!.label !== r.name ? (
                      <span className="inline-flex items-center gap-2 text-[13px] min-w-[150px]" style={{ color: status[r.key].shared!.fg }}>
                        <Marker color={status[r.key].shared!.marker} />
                        {status[r.key].shared!.label}
                      </span>
                    ) : null}
                    <span className="font-mono min-w-[110px] text-right">{r.sub ? fmt2(r.sub) : '–'}</span>
                  </button>
                  )
                ) : isHidden(groupOf[r.p.lv_id] ?? '') ? null : (
                  <LineRow
                    key={r.p.lv_id}
                    p={r.p}
                    selected={r.p.lv_id === sel}
                    to={`/t/${id}/lines/${r.p.lv_id}${linesQuery(filter, q, gp)}`}
                    pdfTo={`/t/${id}/pdf/${r.p.page}?lv=${r.p.lv_id}`}
                    product={productLabel(r.p, cat)}
                    quiet={status[groupOf[r.p.lv_id]]?.quiet ?? null}
                    refCb={(el) => {
                      rowRefs.current[r.p.lv_id] = el
                    }}
                  />
                ),
              )}
              {rows.length === 0 && <div className="px-6 py-8 text-muted">{q ? t('No line matches the search.') : t('No lines here.')}</div>}
              <div className="flex items-center gap-3 px-6 py-2.5 text-[13px] text-muted">
                {t('Showing {n} of {total} lines · CHF before transport, overhead and margin', { n: queue.length, total: positions.length })}
                <span className="hidden lg:inline-flex items-center gap-1 text-faint" title={t('Keys: J next, K previous, Enter opens.')}>
                  <Kbd>J</Kbd>
                  <Kbd>K</Kbd>
                  <Kbd>Enter</Kbd>
                  <span className="sr-only">{t('Keys: J next, K previous, Enter opens.')}</span>
                </span>
              </div>
            </div>
          </section>
        )}
      </main>
      <FooterTotals tenderId={id} />
    </div>
  )
}

/** Done states ("Priced", "Confirmed") are silent: a quiet marker, the label in the tooltip. */
const isSilent = (v: StatusView) => v.marker === C.stone || v.marker === C.ink

/** "Group by: Type · Tender order" (stored in the URL as g=order). */
function GroupBy({ value, onChange, hint }: { value: LineGroupBy; onChange: (g: LineGroupBy) => void; hint: string }) {
  const t = useT()
  const opts: [LineGroupBy, string][] = [
    ['type', t('Type')],
    ['order', t('Tender order')],
  ]
  return (
    <div role="radiogroup" aria-label={t('Group by')} title={hint} className="flex items-center gap-1 text-[13px]">
      <span className="text-muted mr-1" aria-hidden="true">
        {t('Group by')}
      </span>
      {opts.map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cx(
            'min-h-[30px] px-2.5 border rounded-[2px] bg-white',
            value === k ? 'border-ink text-ink font-semibold' : 'border-rule text-muted hover:border-ink hover:text-ink',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function LineRow({
  p,
  selected,
  to,
  pdfTo,
  product,
  quiet,
  refCb,
}: {
  p: Position
  selected: boolean
  to: string
  pdfTo: string
  product: string
  /** the status the group header already says; not repeated on the row */
  quiet: string | null
  refCb: (el: HTMLAnchorElement | null) => void
}) {
  const t = useT()
  const st = lineStatus(p, t)
  const m = matchView(p, t)
  const sup = isSupplier(p)
  const noProduct = product === '–'
  // One cell, one thing: the line's status when it needs something the header doesn't already say,
  // else a match worth a look (weak or none, or a budget price); strong matches and done lines stay quiet.
  // The full status and match reason are in the tooltip (and on the line itself).
  const showStatus = st.label !== quiet && !isSilent(st)
  const note = showStatus ? null : sup ? (m.label === t('Budget') ? t('Budget price') : null) : m.strong ? matchNote(p, t) : null
  const quoted = quotedPrice(p)
  const byAssist = p.supplier_quote?.by === 'Assist'
  const pr = p.pricing
  return (
    <div className="relative">
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
        <span aria-hidden="true" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={p.title_de}>
          {p.title_de}
        </span>
        <span className="font-mono text-right">{fmtQty(pr?.quantity ?? p.quantity)}</span>
        <span className="text-muted">{fmtUnit(p.unit)}</span>
        {noProduct && sup && !p.supplier_quote ? (
          <span className="text-faint">{t('Not in catalogue')}</span>
        ) : (
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted" title={product}>
            {product}
          </span>
        )}
        <span className="font-mono text-right whitespace-nowrap">
          {byAssist && isSupplier(p) && quoted !== null && (
            <span className="mr-1 align-middle">
              <AssistTag title={t('Filled by Assist from the supplier reply')} />
            </span>
          )}
          {pr ? fmt2(pr.net_unit_cost) : '–'}
        </span>
        <span className="font-mono text-right font-medium">{pr ? fmt2(pr.direct) : '–'}</span>
        <span className="flex items-center gap-2 min-w-0" title={st.label + ' · ' + m.line}>
          {showStatus ? (
            <>
              <Marker color={st.marker} />
              <span style={{ color: st.fg }}>{st.label}</span>
            </>
          ) : note ? (
            <span className="text-[13px] pl-4" style={{ color: sup ? C.muted : m.fg }}>
              {note}
            </span>
          ) : isSilent(st) ? (
            <>
              <Marker color={st.marker} />
              <span className="sr-only">{st.label}</span>
            </>
          ) : (
            <span className="sr-only">{st.label}</span>
          )}
        </span>
      </Link>
      {/* the page number opens the Tender PDF on this line (a sibling, not nested in the row link) */}
      <Link
        to={pdfTo}
        title={t('Show on p. {page} in the Tender PDF', { page: p.page })}
        aria-label={t('{lv} on p. {page} in the Tender PDF', { lv: p.lv_id, page: p.page })}
        className="absolute left-6 top-0 bottom-0 w-[56px] inline-flex items-center font-mono text-[13px] text-muted! underline decoration-stone underline-offset-2 hover:text-accent!"
      >
        {p.page}
      </Link>
    </div>
  )
}

/** "Weak match", "Close match", "No match": the match label in the merged status cell. */
function matchNote(p: Position, t: (s: string) => string): string {
  const m = p.match
  if (!m || !m.product_id) return t('No match')
  const label = m.label || (m.confidence >= 0.85 ? 'Strong' : m.confidence >= 0.75 ? 'Close' : m.confidence >= 0.5 ? 'Weak' : 'None')
  return label === 'None' ? t('No match') : t(label + ' match')
}
