// Tender PDF: the tender page by page with every line drawn where the parser read it, in its status
// colour. Click a line for its price; "Filled" shows the same page of the filled LV, so the estimator
// checks our prices in place on the real document.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useLang, useT, type T } from '../i18n'
import { api, filledLvPageUrl, pageImageUrl, useApiMode } from '../api/client'
import { usePosition, usePositions, useTender } from '../api/hooks'
import { lineExtras } from '../api/learned'
import type { Position } from '../api/types'
import { Button, ErrorBox, Kbd, Loading, Spinner } from '../components/ui'
import { ComparisonPanel } from '../components/Equivalence'
import { useAssistCtx } from '../assist/context'
import { cx } from '../lib/cx'
import { fmt2, fmtQty, fmtUnit } from '../lib/format'
import { C, isOpen, isPriceable, isSupplier, lineStatus, productLabel } from '../lib/lines'
import { useCatalog } from './linesShared'

type Box = [number, number, number, number]
type Mode = 'original' | 'filled'
type Zoom = 'page' | 'width'
type Kind = 'priced' | 'review' | 'supplier' | 'none'

const isBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number')
const A4: [number, number] = [595, 842]

/** Overlay colour group: the lineStatus colours folded into four for the legend. */
function kindOf(p: Position): Kind {
  if (!isPriceable(p)) return 'none'
  if (p.confirmed) return 'priced'
  if (isSupplier(p)) return 'supplier'
  return isOpen(p) ? 'review' : 'priced'
}
const KIND_COLOR: Record<Kind, string> = { priced: C.ink, review: C.attn, supplier: C.accent, none: C.faint }
const KINDS: [Kind, string][] = [
  ['priced', 'Priced'],
  ['review', 'Needs review'],
  ['supplier', 'Supplier quote'],
  ['none', 'Not priced'],
]

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/** Hit area per line on one page, in PDF points. A block that lists several sizes is split at each
 *  size's quantity row, so every line gets its own area. Areas run to the price columns on the right. */
function hitBoxes(ps: Position[], pw: number): Map<string, Box> {
  const out = new Map<string, Box>()
  const groups = new Map<string, Position[]>()
  for (const p of ps) {
    const s = p.source
    const b = isBox(s?.block_bbox) ? s.block_bbox : isBox(s?.qty_bbox) ? s.qty_bbox : null
    if (!b) continue
    const k = b.join(',')
    const g = groups.get(k)
    if (g) g.push(p)
    else groups.set(k, [p])
  }
  for (const g of groups.values()) {
    const s0 = g[0].source!
    const b = (isBox(s0.block_bbox) ? s0.block_bbox : s0.qty_bbox) as Box
    const right = Math.max(b[2], pw - 28)
    const qs = g.map((p) => p.source!.qty_bbox)
    if (g.length === 1 || !qs.every(isBox)) {
      for (const p of g) {
        const q = p.source!.qty_bbox
        const u: Box = isBox(q) ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : b
        out.set(p.lv_id, [u[0], u[1], right, u[3]])
      }
      continue
    }
    let top = b[1]
    for (const p of [...g].sort((x, y) => (x.source!.qty_bbox as Box)[1] - (y.source!.qty_bbox as Box)[1])) {
      const q = p.source!.qty_bbox as Box
      out.set(p.lv_id, [b[0], top, right, Math.max(q[3], top + 6)])
      top = q[3] + 0.5
    }
  }
  return out
}

/** The selling price the filled LV prints for a line (lv_fill.selling_prices), or null when it prints a marker. */
function filledPrice(p: Position, k: number): { unit: number; amount: number } | null {
  const pr = p.pricing
  if (!pr || !isPriceable(p) || !pr.quantity) return null
  const unit = Math.round(((pr.material + pr.labour) * k * 100) / pr.quantity) / 100
  return { unit, amount: Math.round(pr.quantity * unit * 100) / 100 }
}

function useSize<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size] as const
}

/** Height from the element's top to the bottom of the window, so the page fits the viewport. */
function useFillHeight<E extends HTMLElement>(ready: boolean, lang: string) {
  const ref = useRef<E>(null)
  const [h, setH] = useState<number | null>(null)
  useLayoutEffect(() => {
    const read = () => {
      const el = ref.current
      if (el) setH(Math.max(420, window.innerHeight - el.getBoundingClientRect().top - window.scrollY))
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [ready, lang])
  return [ref, h] as const
}

const inEditable = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || e.isContentEditable)
}

export function TenderPdf() {
  const { id = '' } = useParams()
  const t = useT()
  const lang = useLang()
  const nav = useNavigate()
  const here = useLocation()
  const ctx = useAssistCtx()
  useApiMode()
  const { data: tender } = useTender(id)
  const pq = usePositions(id)
  const [zoom, setZoom] = useState<Zoom>('page')

  // lines in printed order; totals and other non-lines stay off the page
  const lines = useMemo(() => {
    const ps = (pq.data?.positions ?? []).filter((p) => p.kind !== 'subtotal')
    return ps.map((p, i) => ({ p, o: p.pdf_order ?? i })).sort((a, b) => a.o - b.o).map((x) => x.p)
  }, [pq.data])
  const byPage = useMemo(() => {
    const m = new Map<number, Position[]>()
    for (const p of lines) {
      const g = m.get(p.page)
      if (g) g.push(p)
      else m.set(p.page, [p])
    }
    return m
  }, [lines])
  const pages = useMemo(() => [...byPage.keys()].sort((a, b) => a - b), [byPage])

  const pageCount = tender?.page_count ?? Math.max(1, ...pages)
  /** Page, selected line and mode from a URL. The key handler reads the live URL, so a key pressed
   *  again before React re-rendered still acts on the page the user sees. */
  const viewOf = (path: string, search: string) => {
    const q = new URLSearchParams(search)
    const lv = q.get('lv')
    const sel = lv ? lines.find((p) => p.lv_id === lv) : undefined
    const n = Number(path.match(/\/pdf\/(\d+)/)?.[1])
    const page = Math.min(pageCount, Math.max(1, n || sel?.page || pages[0] || 1))
    const mode: Mode = q.get('mode') === 'filled' ? 'filled' : 'original'
    return { page, sel, mode }
  }
  type View = ReturnType<typeof viewOf>
  const cur = viewOf(here.pathname, here.search)
  const { page, sel, mode } = cur
  const onPage = byPage.get(page) ?? []
  const selIdx = sel ? lines.indexOf(sel) : -1

  const go = (n: number, lv: string | null | undefined, m: Mode) => {
    const q = new URLSearchParams()
    if (lv) q.set('lv', lv)
    if (m === 'filled') q.set('mode', 'filled')
    const s = q.toString()
    nav(`/t/${id}/pdf/${Math.min(pageCount, Math.max(1, n))}${s ? '?' + s : ''}`, { replace: true })
  }
  const goPage = (n: number, v: View = cur) => go(n, v.sel && v.sel.page === n ? v.sel.lv_id : null, v.mode)
  const select = (p: Position | null, v: View = cur) => go(p ? p.page : v.page, p?.lv_id ?? null, v.mode)
  const openLine = (p: Position, v: View = cur) =>
    nav(`/t/${id}/lines/${p.lv_id}`, { state: { pdf: `/t/${id}/pdf/${p.page}?lv=${p.lv_id}${v.mode === 'filled' ? '&mode=filled' : ''}` } })
  const step = (d: 1 | -1, v: View = cur) => {
    const i = v.sel ? lines.indexOf(v.sel) : -1
    if (i >= 0) return lines[i + d] ?? null
    // nothing selected: first or last line on this page, else the nearest page with lines
    const own = byPage.get(v.page) ?? []
    if (own.length) return d === 1 ? own[0] : own[own.length - 1]
    const pg = d === 1 ? pages.find((x) => x > v.page) : [...pages].reverse().find((x) => x < v.page)
    const ls = pg ? (byPage.get(pg) ?? []) : []
    return (d === 1 ? ls[0] : ls[ls.length - 1]) ?? null
  }

  // keyboard: ← → pages, J K lines in printed order, Enter opens the selected line, Esc clears
  const focusSel = useRef(false)
  const onKey = (e: KeyboardEvent) => {
    if (ctx.barOpen || e.metaKey || e.ctrlKey || e.altKey || inEditable(e.target)) return
    if (document.querySelector('[role="dialog"]')) return
    if (!window.location.pathname.startsWith(`/t/${id}/pdf`)) return
    const v = viewOf(window.location.pathname, window.location.search)
    const tag = (e.target as HTMLElement | null)?.tagName
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      goPage(v.page + (e.key === 'ArrowLeft' ? -1 : 1), v)
    } else if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
      const nx = step(e.key.toLowerCase() === 'j' ? 1 : -1, v)
      if (nx) {
        e.preventDefault()
        focusSel.current = true
        select(nx, v)
      }
    } else if (e.key === 'Escape' && v.sel) {
      e.preventDefault()
      select(null, v)
    } else if (e.key === 'Enter' && v.sel && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault()
      openLine(v.sel, v)
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const [fillRef, fillH] = useFillHeight<HTMLDivElement>(!!tender && !pq.isLoading, lang)

  if (pq.isLoading || !tender) return <Loading label={t('Loading')} />
  if (pq.error) return <ErrorBox error={pq.error} label={t('Could not load this tender.')} />

  return (
    <div ref={fillRef} className="flex min-h-0" style={{ height: fillH ?? undefined }}>
      <PageRail pages={pages} byPage={byPage} page={page} onPick={(n) => goPage(n)} />
      <section aria-label={t('Tender PDF')} className="flex-auto min-w-0 flex flex-col">
        <Toolbar
          page={page}
          pageCount={pageCount}
          mode={mode}
          zoom={zoom}
          onPage={(n) => goPage(n)}
          onMode={(m) => go(page, sel?.lv_id, m)}
          onZoom={setZoom}
        />
        <PageView
          tenderId={id}
          page={page}
          mode={mode}
          zoom={zoom}
          lines={onPage}
          sel={sel ?? null}
          takeFocus={() => {
            const v = focusSel.current
            focusSel.current = false
            return v
          }}
          onSelect={(p) => select(p)}
          onOpen={(p) => openLine(p)}
        />
      </section>
      <SidePanel
        tenderId={id}
        page={page}
        mode={mode}
        lines={onPage}
        sel={sel ?? null}
        index={selIdx}
        total={lines.length}
        prev={sel ? step(-1) : null}
        next={sel ? step(1) : null}
        onSelect={(p) => select(p)}
        onOpen={(p) => openLine(p)}
      />
    </div>
  )
}

function PageRail({ pages, byPage, page, onPick }: { pages: number[]; byPage: Map<number, Position[]>; page: number; onPick: (n: number) => void }) {
  const t = useT()
  const refs = useRef<Record<number, HTMLButtonElement | null>>({})
  useEffect(() => {
    refs.current[page]?.scrollIntoView({ block: 'nearest' })
  }, [page])
  return (
    <nav aria-label={t('Pages with lines')} className="flex-none w-[164px] border-r border-rule flex flex-col min-h-0">
      <span className="px-4 pt-3 pb-2 text-[12.5px] text-muted">{t('Pages with lines')}</span>
      <ul className="m-0 p-0 list-none overflow-y-auto flex-auto min-h-0 pb-3">
        {pages.map((n) => {
          const ls = byPage.get(n) ?? []
          const open = ls.filter(isOpen).length
          const on = n === page
          return (
            <li key={n}>
              <button
                ref={(el) => {
                  refs.current[n] = el
                }}
                type="button"
                aria-current={on ? 'page' : undefined}
                aria-label={
                  t('p. {page}', { page: n }) +
                  ', ' +
                  (ls.length === 1 ? t('{n} line', { n: 1 }) : t('{n} lines', { n: ls.length })) +
                  (open ? ', ' + t('{n} to review', { n: open }) : '')
                }
                onClick={() => onPick(n)}
                className={cx(
                  'w-full grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 min-h-8 px-4 border-0 bg-white text-left text-[13px] hover:bg-panel',
                  on && 'row-selected',
                )}
              >
                <span className={cx('font-mono', on ? 'text-ink font-semibold' : 'text-ink')}>{t('p. {page}', { page: n })}</span>
                <span className="font-mono text-muted">{ls.length}</span>
                <span className="inline-flex items-center gap-1 font-mono text-[12px] text-attn" aria-hidden="true">
                  {open > 0 && (
                    <>
                      <span className="w-1.5 h-1.5 bg-attn" />
                      {open}
                    </>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <span className="px-4 py-2 border-t border-rule text-[12px] text-muted leading-[1.5] flex flex-col">
        <span>{t('Lines per page')}</span>
        <span className="inline-flex items-center gap-1.5 text-attn">
          <span className="w-1.5 h-1.5 bg-attn" aria-hidden="true" />
          {t('to review')}
        </span>
      </span>
    </nav>
  )
}

function PageInput({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  const t = useT()
  const [v, setV] = useState(String(page))
  const commit = () => {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1) onPage(Math.round(n))
    else setV(String(page))
  }
  return (
    <label className="inline-flex items-center gap-1.5 text-[13px] text-muted">
      <span>{t('Page')}</span>
      <input
        value={v}
        inputMode="numeric"
        aria-label={t('Go to page')}
        onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') setV(String(page))
        }}
        onBlur={commit}
        className="w-[52px] min-h-8 px-1.5 border border-rule rounded-[2px] bg-white text-ink font-mono text-[13px] text-right hover:border-ink"
      />
      <span className="font-mono">{t('of {n}', { n: pageCount })}</span>
    </label>
  )
}

function Toggle2<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex border border-rule rounded-[2px]">
      {options.map(([v, l], i) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx(
            'min-h-8 px-2.5 border-0 text-[13px]',
            i > 0 && 'border-l border-rule',
            value === v ? 'bg-ink text-white font-medium' : 'bg-white text-ink hover:bg-panel',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

function Toolbar({
  page,
  pageCount,
  mode,
  zoom,
  onPage,
  onMode,
  onZoom,
}: {
  page: number
  pageCount: number
  mode: Mode
  zoom: Zoom
  onPage: (n: number) => void
  onMode: (m: Mode) => void
  onZoom: (z: Zoom) => void
}) {
  const t = useT()
  return (
    <div className="flex-none flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-rule">
      <Button size="xs" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-keyshortcuts="ArrowLeft">
        {t('Previous page')} <Kbd>←</Kbd>
      </Button>
      <Button size="xs" onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-keyshortcuts="ArrowRight">
        {t('Next page')} <Kbd>→</Kbd>
      </Button>
      <PageInput key={page} page={page} pageCount={pageCount} onPage={onPage} />
      <span className="flex-auto" />
      <Toggle2
        label={t('Show')}
        value={mode}
        onChange={onMode}
        options={[
          ['original', t('Original')],
          ['filled', t('Filled')],
        ]}
      />
      <Toggle2
        label={t('Zoom')}
        value={zoom}
        onChange={onZoom}
        options={[
          ['page', t('Fit page')],
          ['width', t('Fit width')],
        ]}
      />
    </div>
  )
}

function Legend() {
  const t = useT()
  return (
    <div aria-label={t('Colours')} className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-muted">
      {KINDS.map(([k, l]) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block w-3 h-2.5"
            style={{ border: `1.5px ${k === 'none' ? 'dashed' : 'solid'} ${KIND_COLOR[k]}`, background: rgba(KIND_COLOR[k], 0.1) }}
          />
          {t(l)}
        </span>
      ))}
    </div>
  )
}

function lineAria(p: Position, t: T) {
  const st = lineStatus(p, t)
  const total = p.pricing ? t('line total CHF {total}', { total: fmt2(p.pricing.direct) }) : t('no price')
  return `${p.lv_id}, ${p.title_de}. ${st.label}, ${total}.`
}

function PageView({
  tenderId,
  page,
  mode,
  zoom,
  lines,
  sel,
  takeFocus,
  onSelect,
  onOpen,
}: {
  tenderId: string
  page: number
  mode: Mode
  zoom: Zoom
  lines: Position[]
  sel: Position | null
  /** true once after J/K: move the focus to the selected line */
  takeFocus: () => boolean
  onSelect: (p: Position | null) => void
  onOpen: (p: Position) => void
}) {
  const t = useT()
  const [areaRef, area] = useSize<HTMLDivElement>()
  const [natural, setNatural] = useState<Record<number, [number, number]>>({})
  const filled = useQuery({ queryKey: ['lvFilled', tenderId], queryFn: () => api.getFilledLv(tenderId), enabled: mode === 'filled' })
  const s = filled.data
  const fromLines = lines.find((p) => p.source?.page_size?.length === 2)?.source?.page_size
  const size: [number, number] = fromLines ? [fromLines[0], fromLines[1]] : (natural[page] ?? A4)
  const [pw, ph] = size

  const version = s ? `${s.lv_sum}-${s.filled}-${s.open}-${s.offer}` : ''
  const filledUrl = s ? filledLvPageUrl(tenderId, page + s.cover_pages, 2) : null
  const src = mode === 'filled' ? (filledUrl ? `${filledUrl}&v=${encodeURIComponent(version)}` : null) : pageImageUrl(tenderId, page, 2)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const waiting = mode === 'filled' && filled.isLoading
  const loading = !!src && loaded !== src && failed !== src

  // the next and previous tender pages come from the disk cache: fetch them ahead
  useEffect(() => {
    if (mode !== 'original') return
    for (const n of [page + 1, page - 1]) {
      const u = n >= 1 ? pageImageUrl(tenderId, n, 2) : null
      if (u) new Image().src = u
    }
  }, [tenderId, page, mode])

  const boxes = useMemo(() => hitBoxes(lines.filter((p) => p.source?.page === page), pw), [lines, page, pw])
  const drawn = useMemo(
    () =>
      lines
        .filter((p) => boxes.has(p.lv_id))
        .map((p) => ({ p, b: boxes.get(p.lv_id)! }))
        // bigger areas first, so a smaller one on top of it stays clickable
        .sort((a, b) => (b.b[2] - b.b[0]) * (b.b[3] - b.b[1]) - (a.b[2] - a.b[0]) * (a.b[3] - a.b[1])),
    [lines, boxes],
  )
  const skipped = lines.length - drawn.length

  const pad = 24
  const fitW = Math.max(240, area.w - pad * 2)
  const w = zoom === 'width' ? fitW : Math.min(fitW, Math.max(240, ((area.h - pad * 2) * pw) / ph))
  const h = (w * ph) / pw

  const [hover, setHover] = useState<string | null>(null)
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => {
    if (!sel) return
    const el = btnRefs.current[sel.lv_id]
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    if (takeFocus()) el.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, page, drawn])

  const tip = hover ? drawn.find((d) => d.p.lv_id === hover) : undefined
  const pct = (v: number, of: number) => `${(v / of) * 100}%`

  return (
    <div className="flex-auto min-h-0 flex flex-col bg-panel">
      <div className="flex-none flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 border-b border-rule bg-white">
        <Legend />
        <span className="flex-auto" />
        <span className="text-[12.5px] text-muted">
          {lines.length === 0
            ? t('No lines on this page.')
            : t(lines.length === 1 ? '1 line on this page' : '{n} lines on this page', { n: lines.length })}
          {skipped > 0 && ' · ' + t('{n} without a place on the page', { n: skipped })}
        </span>
      </div>
      <div ref={areaRef} className="flex-auto min-h-0 overflow-auto" onClick={(e) => e.target === e.currentTarget && sel && onSelect(null)}>
        {area.w > 0 && (
          <div className="mx-auto my-6 relative bg-white border border-rule" style={{ width: w, height: h }}>
            {src && failed !== src && (
              <img
                src={src}
                alt={t('Tender page {page}', { page })}
                draggable={false}
                onLoad={(e) => {
                  const im = e.currentTarget
                  setLoaded(src)
                  if (!fromLines && im.naturalWidth) setNatural((n) => ({ ...n, [page]: [im.naturalWidth, im.naturalHeight] }))
                }}
                onError={() => setFailed(src)}
                className={cx('absolute inset-0 w-full h-full select-none transition-opacity', loading && 'opacity-30')}
              />
            )}
            {(!src || failed === src) && !waiting && (
              <div className="absolute inset-x-6 top-6 text-[13px] text-muted">
                {mode === 'filled' && !filledUrl
                  ? t('The filled tender is not available here (demo data).')
                  : t('The page image is not available here (demo data).')}
              </div>
            )}
            {(waiting || loading) && (
              <div className="absolute left-1/2 top-24 -translate-x-1/2 px-3 py-2 bg-white border border-rule">
                <Spinner label={waiting ? t('Writing the prices into the tender') : mode === 'filled' ? t('Loading the filled page') : t('Loading the page')} />
              </div>
            )}
            {drawn.map(({ p, b }) => {
              const k = kindOf(p)
              const col = KIND_COLOR[k]
              const on = sel?.lv_id === p.lv_id
              const hov = hover === p.lv_id
              return (
                <button
                  key={p.lv_id}
                  ref={(el) => {
                    btnRefs.current[p.lv_id] = el
                  }}
                  type="button"
                  aria-label={lineAria(p, t)}
                  aria-pressed={on}
                  onClick={() => onSelect(p)}
                  onDoubleClick={() => onOpen(p)}
                  onKeyDown={(e: ReactKeyboardEvent) => {
                    if (e.key === 'Enter' && on) {
                      e.preventDefault()
                      onOpen(p)
                    }
                  }}
                  onMouseEnter={() => setHover(p.lv_id)}
                  onMouseLeave={() => setHover((x) => (x === p.lv_id ? null : x))}
                  onFocus={() => setHover(p.lv_id)}
                  onBlur={() => setHover((x) => (x === p.lv_id ? null : x))}
                  className="absolute p-0 m-0 rounded-[2px] cursor-pointer"
                  style={{
                    left: pct(b[0] - 4, pw),
                    top: pct(b[1] - 1.5, ph),
                    width: pct(b[2] - b[0] + 8, pw),
                    height: pct(b[3] - b[1] + 3, ph),
                    border: `${on ? 2.5 : 1.5}px ${k === 'none' ? 'dashed' : 'solid'} ${on ? col : rgba(col, hov ? 0.95 : 0.6)}`,
                    // multiply keeps the page text (and the filled-in prices) crisp under the tint
                    background: rgba(col, (on ? 0.14 : hov ? 0.1 : 0.04) * (k === 'priced' ? 0.6 : 1)),
                    mixBlendMode: 'multiply',
                  }}
                />
              )
            })}
            {tip && (
              <div
                role="presentation"
                className="absolute z-10 pointer-events-none max-w-[340px] px-2.5 py-1.5 bg-white border border-ink text-[12.5px] flex flex-col gap-0.5"
                style={{
                  left: pct(tip.b[0] - 4, pw),
                  ...(tip.b[1] > 80 ? { bottom: pct(ph - tip.b[1] + 4, ph) } : { top: pct(tip.b[3] + 4, ph) }),
                }}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono font-semibold">{tip.p.lv_id}</span>
                  <span className="font-mono ml-auto">{tip.p.pricing ? 'CHF ' + fmt2(tip.p.pricing.direct) : '–'}</span>
                </span>
                <span className="truncate">{tip.p.title_de}</span>
                <span style={{ color: lineStatus(tip.p, t).fg }}>{lineStatus(tip.p, t).label}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SidePanel({
  tenderId,
  page,
  mode,
  lines,
  sel,
  index,
  total,
  prev,
  next,
  onSelect,
  onOpen,
}: {
  tenderId: string
  page: number
  mode: Mode
  lines: Position[]
  sel: Position | null
  index: number
  total: number
  prev: Position | null
  next: Position | null
  onSelect: (p: Position | null) => void
  onOpen: (p: Position) => void
}) {
  const t = useT()
  return (
    <aside aria-label={t('Line on the page')} className="flex-none w-[380px] border-l border-rule flex flex-col min-h-0 overflow-y-auto">
      {sel ? (
        <LinePanel tenderId={tenderId} p={sel} mode={mode} index={index} total={total} prev={prev} next={next} onSelect={onSelect} onOpen={onOpen} />
      ) : (
        <div className="px-5 pt-5 pb-4 flex flex-col gap-1.5 border-b border-rule">
          <h2 className="m-0 text-[15px] font-semibold">{t('Click a line on the page')}</h2>
          <p className="m-0 text-[13px] text-muted leading-[1.5]">
            {t('Every line ctrl-free read is drawn where it stands in the tender, in its status colour. Click one to see its quantity, product and price.')}
          </p>
          <p className="m-0 text-[12.5px] text-muted">
            {t('Keys: ← → pages, J K lines in printed order, Enter opens the line, Esc clears.')}
          </p>
        </div>
      )}
      <div className="px-5 pt-4 pb-6 flex flex-col gap-1.5">
        <h3 className="m-0 text-[13px] font-semibold">
          {t('On p. {page}', { page })} <span className="font-normal text-muted">· {lines.length === 1 ? t('{n} line', { n: 1 }) : t('{n} lines', { n: lines.length })}</span>
        </h3>
        {lines.length === 0 && <span className="text-[13px] text-muted">{t('No lines on this page. Pages with lines are listed on the left.')}</span>}
        <ul className="m-0 p-0 list-none flex flex-col">
          {lines.map((p) => {
            const st = lineStatus(p, t)
            const on = sel?.lv_id === p.lv_id
            return (
              <li key={p.lv_id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSelect(on ? null : p)}
                  className={cx(
                    'w-full grid grid-cols-[10px_58px_minmax(0,1fr)_auto] items-center gap-2 min-h-8 px-2 border-0 border-b border-rowrule bg-white text-left text-[13px] hover:bg-panel',
                    on && 'row-selected',
                  )}
                  title={st.label}
                >
                  <span className="w-2 h-2" style={{ background: KIND_COLOR[kindOf(p)] }} aria-hidden="true" />
                  <span className="font-mono text-muted">{p.lv_id}</span>
                  <span className="truncate">{p.title_de}</span>
                  <span className="font-mono text-right">{p.pricing ? fmt2(p.pricing.direct) : '–'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
  )
}

function LinePanel({
  tenderId,
  p,
  mode,
  index,
  total,
  prev,
  next,
  onSelect,
  onOpen,
}: {
  tenderId: string
  p: Position
  mode: Mode
  index: number
  total: number
  prev: Position | null
  next: Position | null
  onSelect: (p: Position | null) => void
  onOpen: (p: Position) => void
}) {
  const t = useT()
  const lang = useLang()
  const cat = useCatalog()
  const dq = usePosition(tenderId, p.lv_id)
  const filled = useQuery({ queryKey: ['lvFilled', tenderId], queryFn: () => api.getFilledLv(tenderId), enabled: mode === 'filled' })
  const x = lineExtras(dq.data)
  const st = lineStatus(p, t)
  const pr = p.pricing
  const sys = p.system.replace(/^\d+(\.\d+)*\s+/, '')
  const fp = mode === 'filled' && filled.data ? filledPrice(p, filled.data.k) : null
  const row = (label: string, value: React.ReactNode, strong = false) => (
    <>
      <span className={cx('py-1.5 border-b border-rowrule', strong ? 'font-semibold' : 'text-muted')}>{label}</span>
      <span className={cx('py-1.5 border-b border-rowrule text-right', strong && 'font-semibold')}>{value}</span>
    </>
  )
  return (
    <div className="px-5 pt-5 pb-5 flex flex-col gap-3 border-b border-rule">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[12.5px] text-muted">
          {p.lv_id} · {t('p. {page}', { page: p.page })} · {sys}
        </span>
        <h2 className="m-0 text-[16px] leading-[1.3] font-semibold">{p.title_de}</h2>
        {lang === 'en' && p.title_en && <span className="text-[13px] text-muted">{p.title_en}</span>}
        <span className="flex items-center gap-2 text-[13px]" style={{ color: st.fg }}>
          <span className="w-2 h-2" style={{ background: st.marker }} aria-hidden="true" />
          {st.label}
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[13.5px]">
        {row(t('Quantity'), <span className="font-mono">{pr || p.quantity != null ? `${fmtQty(pr?.quantity ?? p.quantity)} ${fmtUnit(p.unit)}` : '–'}</span>)}
        {row(t('Product'), <span className="inline-block max-w-[210px] truncate align-bottom" title={productLabel(p, cat)}>{productLabel(p, cat)}</span>)}
        {row(t('Unit price'), <span className="font-mono">{pr ? fmt2(pr.net_unit_cost) : '–'}</span>)}
        {row(t('Hours'), <span className="font-mono">{pr ? fmt2(pr.hours) + ' h' : '–'}</span>)}
        {row(t('Line total'), <span className="font-mono">{pr ? 'CHF ' + fmt2(pr.direct) : '–'}</span>, true)}
      </div>
      {mode === 'filled' && (
        <span className="text-[13px] text-muted">
          {fp
            ? t('In the filled LV: CHF {unit} × {qty} = CHF {amount} (selling price).', { unit: fmt2(fp.unit), qty: fmtQty(pr?.quantity), amount: fmt2(fp.amount) })
            : t('In the filled LV this line carries a marker instead of a price.')}
        </span>
      )}
      {!pr && p.status_reason && <span className="text-[13px] text-muted">{p.status_reason}</span>}
      {x.comparison && <ComparisonPanel key={p.lv_id + x.comparison.product_id} cmp={x.comparison} rule={x.makeRule} defaultOpen={false} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
        <Button variant="primary" size="sm" onClick={() => onOpen(p)}>
          {t('Open line')}
        </Button>
        <button type="button" onClick={() => onSelect(null)} className="ml-auto border-0 bg-transparent p-0 text-[12.5px] text-muted underline underline-offset-2 hover:text-ink">
          {t('Clear selection')} <span className="font-mono">Esc</span>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" onClick={() => prev && onSelect(prev)} disabled={!prev} aria-keyshortcuts="K">
          {t('Previous')} <Kbd>K</Kbd>
        </Button>
        <Button size="xs" onClick={() => next && onSelect(next)} disabled={!next} aria-keyshortcuts="J">
          {t('Next')} <Kbd>J</Kbd>
        </Button>
        <span className="text-[12.5px] text-muted">{index >= 0 ? t('Line {i} of {n} in printed order', { i: index + 1, n: total }) : ''}</span>
      </div>
    </div>
  )
}
