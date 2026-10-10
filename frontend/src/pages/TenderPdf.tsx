// Tender PDF: the tender page by page with every line drawn where the parser read it, in its status
// colour, and a small chip in the margin with its total or what it still needs. Click a line (or its
// chip) and a popover next to it says what was read, which product and what it costs; "Looks right"
// confirms it and moves on to the next line to review. "Filled" shows the same page of the filled LV.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useLang, useT, type T } from '../i18n'
import { api, filledLvPageUrl, pageImageUrl, useApiMode } from '../api/client'
import { usePatchPosition, usePosition, usePositions, useTender, useUndo } from '../api/hooks'
import { lineExtras } from '../api/learned'
import type { Position } from '../api/types'
import { Button, ErrorBox, IconCheck, IconClose, Kbd, Loading, Spinner } from '../components/ui'
import { ComparisonPanel } from '../components/Equivalence'
import { useAssistCtx } from '../assist/context'
import { cx } from '../lib/cx'
import { fmt2, fmtQty, fmtShortDate, fmtUnit } from '../lib/format'
import { C, hoursSentence, isOpen, isPriceable, isSupplier, labourSentence, lineStatus, materialSentence, productLabel, quotedPrice } from '../lib/lines'
import { useCatalog } from './linesShared'

type Box = [number, number, number, number]
type Mode = 'original' | 'filled'
type Zoom = 'page' | 'width'
type Kind = 'priced' | 'review' | 'supplier' | 'none'

const isBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number')
const A4: [number, number] = [595, 842]
/** room right of the page for the chips, and the popover width */
const GUTTER = 62
const POP_W = 420

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

/** A theme colour (CSS variable or hex) at opacity a. */
function rgba(color: string, a: number) {
  return `color-mix(in srgb, ${color} ${Math.round(a * 1000) / 10}%, transparent)`
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

/** The chip in the page margin: the line total (blue) or, for an unpriced line, what it is waiting for.
 *  The filled LV already prints the prices, so there only the unpriced lines get a chip. */
function chipOf(p: Position, mode: Mode, t: T): { text: string; fg: string } | null {
  const waitsForQuote = isSupplier(p) && isPriceable(p) && quotedPrice(p) === null && !p.confirmed
  if (waitsForQuote) return { text: t('Quote'), fg: C.attn }
  if (p.pricing && isPriceable(p)) return mode === 'filled' ? null : { text: fmt2(p.pricing.direct), fg: C.accent }
  if (!isPriceable(p)) return { text: t('Not priced'), fg: C.faint }
  if (p.status === 'insufficient_information') return { text: t('No qty'), fg: C.muted }
  return { text: t('No match'), fg: C.muted }
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
/** a modal dialog or another popover is open: page keys stay quiet (our own line popover does not count) */
const otherDialogOpen = () => !!document.querySelector('[role="dialog"]:not([data-pdf-pop])')

/** Elements the popover is placed against: each line's overlay and chip, and the page itself. */
interface Anchors {
  ov: Record<string, HTMLButtonElement | null>
  chip: Record<string, HTMLButtonElement | null>
  page: HTMLDivElement | null
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
  const patch = usePatchPosition(id)
  const undo = useUndo(id)
  const [zoom, setZoom] = useState<Zoom>('page')
  // one mutable object for the whole visit: the line overlays and chips register themselves in it
  const [anchors] = useState<Anchors>(() => ({ ov: {}, chip: {}, page: null }))

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
    return { page, sel: sel && sel.page === page ? sel : undefined, mode }
  }
  type View = ReturnType<typeof viewOf>
  const live = () => viewOf(window.location.pathname, window.location.search)
  const cur = viewOf(here.pathname, here.search)
  const { page, sel, mode } = cur
  const onPage = byPage.get(page) ?? []

  const go = (n: number, lv: string | null | undefined, m: Mode) => {
    const q = new URLSearchParams()
    if (lv) q.set('lv', lv)
    if (m === 'filled') q.set('mode', 'filled')
    const s = q.toString()
    nav(`/t/${id}/pdf/${Math.min(pageCount, Math.max(1, n))}${s ? '?' + s : ''}`, { replace: true })
  }
  const goPage = (n: number, v: View = cur) => go(n, v.sel && v.sel.page === n ? v.sel.lv_id : null, v.mode)
  const select = (p: Position | null, v: View = cur) => go(p ? p.page : v.page, p?.lv_id ?? null, v.mode)
  /** where Line detail's "Back to Tender PDF" returns to */
  const backTo = (p: Position, v: View = cur) => `/t/${id}/pdf/${p.page}?lv=${p.lv_id}${v.mode === 'filled' ? '&mode=filled' : ''}`
  const openLine = (p: Position, v: View = cur) => nav(`/t/${id}/lines/${p.lv_id}`, { state: { pdf: backTo(p, v) } })
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

  /** Close the popover; on Esc / × the focus goes back to the line on the page. */
  const close = (refocus: boolean) => {
    const v = live()
    const lv = v.sel?.lv_id
    select(null, v)
    if (refocus && lv) requestAnimationFrame(() => anchors.ov[lv]?.focus({ preventScroll: true }))
  }

  // "Looks right": confirm, then the next line in printed order that still needs review (any page).
  // One at a time: a second Enter before the save returns must not confirm twice or skip a line.
  const confirming = useRef(false)
  const [done, setDone] = useState<string | null>(null)
  const looksRight = async (p: Position) => {
    if (confirming.current || p.confirmed || !isPriceable(p)) return
    confirming.current = true
    setDone(null)
    try {
      const i = lines.indexOf(p)
      const after = [...lines.slice(i + 1), ...lines.slice(0, Math.max(0, i))]
      const nx = after.find((x) => x.lv_id !== p.lv_id && !x.confirmed && isOpen(x)) ?? null
      await patch.mutateAsync({ lv: p.lv_id, body: { confirm: true } })
      const v = live()
      if (v.sel?.lv_id !== p.lv_id) return // the user moved on while it saved
      if (nx) select(nx, v)
      else setDone(p.lv_id)
    } catch {
      /* shown in the popover (patch.error) */
    } finally {
      confirming.current = false
    }
  }
  // Undo a confirmation: take back the confirm entry in the log (so the line is exactly as before),
  // or unconfirm when that entry cannot be undone on its own (part of a batch).
  const unconfirm = async (p: Position) => {
    if (confirming.current) return
    confirming.current = true
    try {
      const log = await api.getLog(id, { lv_id: p.lv_id })
      const last = log.find((e) => !e.undone && (e.action === 'confirm' || e.action === 'unconfirm'))
      if (last && last.action === 'confirm' && last.undoable !== false && !last.batch) await undo.mutateAsync(last.id)
      else await patch.mutateAsync({ lv: p.lv_id, body: { unconfirm: true } })
      setDone(null)
    } catch {
      /* shown in the popover */
    } finally {
      confirming.current = false
    }
  }

  // keyboard: ← → pages, J K lines in printed order (the popover follows), Esc closes the popover.
  // Enter is handled only by the popover and the selected line itself, never from here.
  const onKey = (e: KeyboardEvent) => {
    if (ctx.barOpen || e.metaKey || e.ctrlKey || e.altKey || inEditable(e.target)) return
    if (otherDialogOpen()) return
    if (!window.location.pathname.startsWith(`/t/${id}/pdf`)) return
    const v = live()
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      goPage(v.page + (e.key === 'ArrowLeft' ? -1 : 1), v)
    } else if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
      const nx = step(e.key.toLowerCase() === 'j' ? 1 : -1, v)
      if (nx) {
        e.preventDefault()
        select(nx, v)
      }
    } else if (e.key === 'Escape' && v.sel) {
      e.preventDefault()
      close(true)
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const [fillRef, fillH] = useFillHeight<HTMLDivElement>(!!tender && !pq.isLoading, lang)

  if (pq.isLoading || !tender) return <Loading label={t('Loading')} />
  if (pq.error) return <ErrorBox error={pq.error} label={t('Could not load this tender.')} />

  const busy = patch.isPending || undo.isPending
  const err = patch.error ?? undo.error

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
          anchors={anchors}
          onSelect={(p) => select(p)}
          onLooksRight={(p) => void looksRight(p)}
        />
      </section>
      {sel && (
        <LinePopover
          key={sel.lv_id}
          tenderId={id}
          p={sel}
          mode={mode}
          zoom={zoom}
          anchors={anchors}
          back={backTo(sel)}
          busy={busy}
          error={err}
          nothingLeft={done === sel.lv_id}
          onClose={close}
          onLooksRight={() => void looksRight(sel)}
          onUndo={() => void unconfirm(sel)}
          onOpen={() => openLine(sel)}
        />
      )}
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
    <div data-keep-pop="" className="flex-none flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-rule">
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
  anchors,
  onSelect,
  onLooksRight,
}: {
  tenderId: string
  page: number
  mode: Mode
  zoom: Zoom
  lines: Position[]
  sel: Position | null
  anchors: Anchors
  onSelect: (p: Position | null) => void
  /** Enter on the selected line: the same as "Looks right" in its popover */
  onLooksRight: (p: Position) => void
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

  // the page fits the area, with the chips to its right; it sits left of centre when that leaves the
  // popover room beside it
  const pad = 24
  const fitW = Math.max(240, area.w - pad * 2 - GUTTER)
  const w = zoom === 'width' ? fitW : Math.min(fitW, Math.max(240, ((area.h - pad * 2) * pw) / ph))
  const h = (w * ph) / pw
  const left = Math.max(pad, Math.min((area.w - w - GUTTER) / 2, area.w - w - GUTTER - POP_W - 34))

  // chips: one per line, at its quantity row, pushed down where two rows sit closer than a chip
  const chips = useMemo(() => {
    const chipH = (15 * pw) / Math.max(1, w)
    const out: { p: Position; y: number; c: { text: string; fg: string } }[] = []
    const ys = drawn
      .map(({ p, b }) => {
        const q = p.source?.qty_bbox
        const y = isBox(q) && q[1] >= b[1] - 1 && q[3] <= b[3] + 1 ? (q[1] + q[3]) / 2 : b[3] - 5
        return { p, y }
      })
      .sort((a, b) => a.y - b.y)
    let last = -Infinity
    for (const { p, y } of ys) {
      const c = chipOf(p, mode, t)
      if (!c) continue
      const yy = Math.max(y, last + chipH + 1)
      out.push({ p, y: yy, c })
      last = yy
    }
    return out
  }, [drawn, mode, pw, w, t])

  const [hover, setHover] = useState<string | null>(null)
  useEffect(() => {
    if (!sel) return
    anchors.ov[sel.lv_id]?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, page, drawn])

  const tip = hover && hover !== sel?.lv_id ? drawn.find((d) => d.p.lv_id === hover) : undefined
  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  const enterConfirms = (p: Position) => (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && sel?.lv_id === p.lv_id) {
      e.preventDefault()
      if (!e.repeat) onLooksRight(p)
    }
  }

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
          {lines.length > 0 && ' · ' + t('click a line to check it, J K for the next')}
        </span>
      </div>
      <div ref={areaRef} className="flex-auto min-h-0 overflow-auto">
        {area.w > 0 && (
          <div
            ref={(el) => {
              anchors.page = el
            }}
            className="my-6 relative bg-white border border-rule"
            style={{ width: w, height: h, marginLeft: left }}
          >
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
                    anchors.ov[p.lv_id] = el
                  }}
                  type="button"
                  data-pdf-line=""
                  aria-label={lineAria(p, t)}
                  aria-pressed={on}
                  aria-haspopup="dialog"
                  aria-keyshortcuts={on ? 'Enter' : undefined}
                  onClick={() => onSelect(p)}
                  onKeyDown={enterConfirms(p)}
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
                    border: `${on ? 2.5 : 1.5}px ${k === 'none' ? 'dashed' : 'solid'} ${on ? C.accent : rgba(col, hov ? 0.95 : 0.6)}`,
                    // multiply keeps the page text (and the filled-in prices) crisp under the tint
                    background: on ? rgba(C.accent, 0.08) : rgba(col, (hov ? 0.1 : 0.04) * (k === 'priced' ? 0.6 : 1)),
                    mixBlendMode: 'multiply',
                  }}
                />
              )
            })}
            {chips.map(({ p, y, c }) => {
              const on = sel?.lv_id === p.lv_id
              return (
                <button
                  key={p.lv_id}
                  ref={(el) => {
                    anchors.chip[p.lv_id] = el
                  }}
                  type="button"
                  data-pdf-line=""
                  aria-label={lineAria(p, t)}
                  aria-pressed={on}
                  aria-haspopup="dialog"
                  onClick={() => onSelect(p)}
                  onKeyDown={enterConfirms(p)}
                  onMouseEnter={() => setHover(p.lv_id)}
                  onMouseLeave={() => setHover((x) => (x === p.lv_id ? null : x))}
                  className={cx(
                    'absolute -translate-y-1/2 inline-flex items-center gap-[3px] px-[3px] m-0 border rounded-[2px] font-mono text-[10.5px] leading-[13px] whitespace-nowrap cursor-pointer',
                    on ? 'border-accent bg-white' : 'border-transparent bg-white hover:border-rule',
                  )}
                  style={{ left: `calc(100% + 5px)`, top: pct(y, ph), color: c.fg }}
                >
                  {p.confirmed && <IconCheck size={9} />}
                  {c.text}
                </button>
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

// ---- the popover next to the clicked line ------------------------------------------------

type Side = 'right' | 'left' | 'below' | 'above'
interface Place {
  left: number
  top: number
  side: Side
  /** arrow position along the side that faces the line */
  arrow: number
  maxH: number
}

/** Right of the line's chip; left of the line when the right has no room; else below or above the
 *  line. Always inside the viewport. */
function placeAt(a: { l: number; r: number; t: number; b: number; y: number }, w: number, hNat: number): Place {
  const M = 8
  const G = 11
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxH = vh - 2 * M
  const h = Math.min(hNat, maxH)
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const ARROW_Y = 40
  if (a.r + G + w <= vw - M || a.l - G - w >= M) {
    const side: Side = a.r + G + w <= vw - M ? 'right' : 'left'
    const top = clamp(a.y - ARROW_Y, M, vh - h - M)
    return { side, left: side === 'right' ? a.r + G : a.l - G - w, top, arrow: clamp(a.y - top, 14, h - 14), maxH }
  }
  const left = clamp(a.r - w + 8, M, vw - w - M)
  const below = vh - a.b - G - M
  const above = a.t - G - M
  const side: Side = h <= below || below >= above ? 'below' : 'above'
  const top = side === 'below' ? clamp(a.b + G, M, vh - h - M) : clamp(a.t - G - h, M, vh - h - M)
  return { side, left, top, arrow: clamp(a.r - 30 - left, 14, w - 14), maxH: side === 'below' ? Math.max(200, below) : Math.max(200, above) }
}

function Arrow({ place }: { place: Place }) {
  const s = place.side
  const base = 'absolute w-[11px] h-[11px] bg-white border-ink pointer-events-none'
  if (s === 'right') return <span aria-hidden="true" className={cx(base, 'border-l border-b')} style={{ left: -6, top: place.arrow - 5.5, transform: 'rotate(45deg)' }} />
  if (s === 'left') return <span aria-hidden="true" className={cx(base, 'border-t border-r')} style={{ right: -6, top: place.arrow - 5.5, transform: 'rotate(45deg)' }} />
  if (s === 'below') return <span aria-hidden="true" className={cx(base, 'border-t border-l')} style={{ top: -6, left: place.arrow - 5.5, transform: 'rotate(45deg)' }} />
  return <span aria-hidden="true" className={cx(base, 'border-b border-r')} style={{ bottom: -6, left: place.arrow - 5.5, transform: 'rotate(45deg)' }} />
}

function IconDown({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-ink)" strokeWidth="1.6" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}>
      <path d="M2.5 4.25L6 7.75l3.5-3.5" />
    </svg>
  )
}

/** "6 pc" and where it was read: the quantity row of the tender, as printed. */
function qtySource(p: Position): string | null {
  const ls = p.source?.lines ?? []
  const q = ls.find((l) => l.role === 'qty')
  return q ? q.text.replace(/\s+/g, ' ').trim() : null
}

function LinePopover({
  tenderId,
  p: listP,
  mode,
  zoom,
  anchors,
  back,
  busy,
  error,
  nothingLeft,
  onClose,
  onLooksRight,
  onUndo,
  onOpen,
}: {
  tenderId: string
  p: Position
  mode: Mode
  zoom: Zoom
  anchors: Anchors
  /** Line detail's way back here */
  back: string
  busy: boolean
  error: unknown
  nothingLeft: boolean
  onClose: (refocus: boolean) => void
  onLooksRight: () => void
  onUndo: () => void
  onOpen: () => void
}) {
  const t = useT()
  const lang = useLang()
  const ctx = useAssistCtx()
  const cat = useCatalog()
  const hid = useId()
  const dq = usePosition(tenderId, listP.lv_id)
  // the detail has the tender's quantity row and the comparison; it is set right after a confirm
  const p: Position = dq.data && dq.data.lv_id === listP.lv_id ? dq.data : listP
  const x = lineExtras(dq.data)
  const filled = useQuery({ queryKey: ['lvFilled', tenderId], queryFn: () => api.getFilledLv(tenderId), enabled: mode === 'filled' })
  const [howOpen, setHowOpen] = useState(false)
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Place | null>(null)

  const st = lineStatus(p, t)
  const pr = p.pricing
  const o = p.overrides ?? {}
  const sup = isSupplier(p) && isPriceable(p)
  const quoted = quotedPrice(p)
  const hourly = pr?.unit_price_source === 'labour'
  const pid = o.product_id ?? p.match?.product_id ?? null
  const fp = mode === 'filled' && filled.data ? filledPrice(p, filled.data.k) : null
  const canConfirm = isPriceable(p) && !p.confirmed
  const qtySet = o.quantity != null
  const hoursSet = o.hours != null

  // ---- placement: next to the line, kept in the viewport, follows scroll / zoom / resize
  useLayoutEffect(() => {
    let raf = 0
    const run = () => {
      const ov = anchors.ov[listP.lv_id]
      const chip = anchors.chip[listP.lv_id]
      const pg = anchors.page
      const r = ov?.getBoundingClientRect()
      const c = chip?.getBoundingClientRect()
      const g = pg?.getBoundingClientRect()
      const a = r
        ? {
            l: r.left,
            r: c ? c.right : r.right,
            t: r.top,
            b: r.bottom,
            y: c ? c.top + c.height / 2 : r.bottom - Math.min(7, r.height / 2),
          }
        : g
          ? { l: g.right, r: g.right, t: g.top + 24, b: g.top + 24, y: g.top + 48 }
          : null
      if (!a) return
      const w = Math.min(POP_W, window.innerWidth - 16)
      const h = (inner.current?.scrollHeight ?? 300) + 2
      const n = placeAt(a, w, h)
      setPlace((q) => (q && q.left === n.left && q.top === n.top && q.side === n.side && q.arrow === n.arrow && q.maxH === n.maxH ? q : n))
    }
    const later = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(run)
    }
    run()
    later()
    window.addEventListener('resize', later)
    window.addEventListener('scroll', later, true)
    const ro = new ResizeObserver(later)
    if (inner.current) ro.observe(inner.current)
    const ov = anchors.ov[listP.lv_id]
    if (ov) ro.observe(ov)
    if (anchors.page) ro.observe(anchors.page)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', later)
      window.removeEventListener('scroll', later, true)
      ro.disconnect()
    }
  }, [anchors, listP.lv_id, zoom, mode, howOpen])

  // ---- focus in on open; Esc and a click outside close it
  // (once it is placed: a popover still hidden for measuring cannot take the focus)
  const focused = useRef(false)
  const placed = !!place
  useEffect(() => {
    if (!placed || focused.current) return
    focused.current = true
    outer.current?.focus({ preventScroll: true })
  }, [placed])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ctx.barOpen || otherDialogOpen()) return
      const inside = outer.current?.contains(e.target as Node)
      if (!inside && inEditable(e.target)) return
      e.stopPropagation()
      e.preventDefault()
      onClose(true)
    }
    const onDown = (e: MouseEvent) => {
      const n = e.target as HTMLElement
      if (outer.current?.contains(n)) return
      // another line or its chip opens its own popover; the toolbar (Original · Filled, zoom) keeps this one
      if (n.closest?.('[data-pdf-line], [data-keep-pop]')) return
      if (otherDialogOpen()) return
      onClose(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [ctx.barOpen, onClose])

  // Enter inside the popover is "Looks right", unless it is on a button or link (they do their own thing)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'A' || inEditable(e.target)) return
    e.preventDefault()
    if (!e.repeat && canConfirm && !busy) onLooksRight()
  }

  // ---- what the line still needs, as one sentence and a link
  const lineHref = `/t/${tenderId}/lines/${p.lv_id}`
  let next: { text: string; link: string; to: string } | null = null
  if (!p.confirmed && isPriceable(p)) {
    if (sup && quoted === null)
      next = {
        text: pr ? t('It runs on a budget price until the supplier quotes.') : t('The price is still open.'),
        link: t('Ask supplier or enter quote'),
        to: lineHref + '#supplier',
      }
    else if (p.status === 'insufficient_information') next = { text: t('The tender gives no quantity.'), link: t('Add the quantity'), to: lineHref + '#f-qty' }
    else if (!pid && !hourly) next = { text: t('No product fits yet.'), link: t('Change product'), to: lineHref + '/product' }
    else if (p.status === 'review_required') next = { text: t('The product needs a check.'), link: t('Change product'), to: lineHref + '/product' }
  }

  // ---- one plain sentence on the match / price
  const why = !isPriceable(p)
    ? p.status_reason
    : o.product_id && o.product_id !== p.match?.product_id && !sup
      ? p.match?.product_id
        ? t('Product chosen by hand; the match was {p}.', { p: p.match.product_id })
        : t('Product chosen by hand; the code found no product.')
      : (p.match?.reason ?? p.status_reason)

  const qs = qtySource(p)
  const qtyValue: ReactNode =
    pr || p.quantity != null ? (
      <>
        <span className="font-mono text-ink">
          {fmtQty(pr?.quantity ?? p.quantity)} {fmtUnit(p.unit)}
        </span>{' '}
        <span className="text-muted">
          {qtySet
            ? t('changed by hand (tender: {q})', { q: fmtQty(p.quantity) })
            : qs
              ? t('read from «{src}»', { src: qs })
              : t('read from p. {page}', { page: p.page })}
        </span>
      </>
    ) : (
      <span className="text-attn">{t('No quantity in the tender')}</span>
    )

  const unitNote = sup ? (quoted !== null ? t('Supplier quote') : t('Budget price')) : pr?.price_list ? t('From {l}', { l: pr.price_list.name }) : pr?.unit_price_source === 'manual' || o.unit_price != null ? t('Typed by hand') : t('Catalogue price')

  return createPortal(
    <div
      ref={outer}
      role="dialog"
      aria-labelledby={hid}
      data-pdf-pop=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-40 bg-white border border-ink text-[13.5px] text-ink outline-none"
      style={{
        top: place?.top ?? -9999,
        left: place?.left ?? -9999,
        width: Math.min(POP_W, window.innerWidth - 16),
        visibility: place ? 'visible' : 'hidden',
        boxShadow: '0 10px 28px rgba(18, 18, 18, 0.14), 0 2px 6px rgba(18, 18, 18, 0.08)',
      }}
    >
      <div ref={inner} className="overflow-y-auto px-6 pt-4 pb-1" style={{ maxHeight: place?.maxH ?? 'calc(100vh - 16px)' }}>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[13px] text-muted">{p.lv_id}</span>
          <span className="inline-flex items-center gap-1.5 text-[13px]" style={{ color: st.fg }}>
            <span className="w-2 h-2" style={{ background: st.marker }} aria-hidden="true" />
            {st.label}
          </span>
          <button
            type="button"
            aria-label={t('Close')}
            onClick={() => onClose(true)}
            className="ml-auto -mr-2 inline-flex w-8 h-8 border border-transparent rounded-[2px] items-center justify-center bg-white hover:border-rule"
          >
            <IconClose />
          </button>
        </div>
        <h2 id={hid} className="m-0 mt-1 text-[16px] leading-[1.3] font-semibold">
          {p.title_de}
        </h2>
        {lang === 'en' && p.title_en && <div className="mt-0.5 text-[12.5px] text-muted">{p.title_en}</div>}

        <div className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 leading-[1.4]">
          <span className="text-muted">{t('Quantity')}</span>
          <span className="min-w-0 break-words">{qtyValue}</span>
          <span className="text-muted">{t('Product')}</span>
          <span className="min-w-0 break-words">
            {hourly ? t('Hourly work, no product') : pid ? productLabel(p, cat) : <span className="text-attn">{t('No catalogue match')}</span>}
          </span>
          <span className="text-muted">{t('Total')}</span>
          <span className="min-w-0">
            {pr ? (
              <>
                <span className="font-mono font-semibold">CHF {fmt2(pr.direct)}</span>
                {sup && quoted === null && <span className="text-attn"> · {t('budget price')}</span>}
              </>
            ) : (
              <span className="font-mono font-semibold text-attn">{t('No price yet')}</span>
            )}
          </span>
          {mode === 'filled' && (
            <>
              <span className="text-muted">{t('Selling price')}</span>
              <span className="min-w-0">
                {fp ? (
                  <span className="font-mono">
                    {fmt2(fp.unit)} × {fmtQty(pr?.quantity)} = CHF {fmt2(fp.amount)}
                  </span>
                ) : (
                  <span className="text-muted">{t('marker instead of a price')}</span>
                )}
              </span>
            </>
          )}
        </div>

        {why && <p className="m-0 mt-3 text-[13.5px] leading-[1.55] text-body">{why}</p>}

        <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
          {p.confirmed ? (
            <>
              <span className="inline-flex items-center gap-2 font-medium mr-1">
                <IconCheck />
                {t('Confirmed by {who} · {when}', { who: t(p.confirmed.by === 'You' ? 'you' : p.confirmed.by), when: fmtShortDate(p.confirmed.at, lang) })}
              </span>
              <Button onClick={onUndo} disabled={busy}>
                {t('Undo')}
              </Button>
            </>
          ) : (
            canConfirm && (
              <Button variant="primary" onClick={onLooksRight} disabled={busy} aria-keyshortcuts="Enter">
                {t('Looks right')} <Kbd>Enter</Kbd>
              </Button>
            )
          )}
          <Button onClick={onOpen}>
            {t('Something is wrong')}
          </Button>
        </div>
        {nothingLeft && <p className="m-0 mt-2 text-[13px] text-muted">{t('Nothing left to review in this tender.')}</p>}
        {!!error && (
          <p role="alert" className="m-0 mt-2 text-[13px] text-attn">
            {t('Could not save.')} {error instanceof Error ? error.message : ''}
          </p>
        )}
        {next && (
          <p className="m-0 mt-2.5 text-[13px] text-muted">
            {next.text}{' '}
            <Link to={next.to} state={{ pdf: back }}>
              {next.link}
            </Link>
          </p>
        )}

        <div className="mt-3.5 border-t border-rule">
          <button
            type="button"
            aria-expanded={howOpen}
            onClick={() => setHowOpen(!howOpen)}
            className="w-full flex items-center justify-between gap-2 py-3 border-0 bg-transparent text-left font-semibold text-[13.5px] text-ink"
          >
            {t('How was this worked out?')}
            <IconDown open={howOpen} />
          </button>
          {howOpen && (
            <div className="pb-3 flex flex-col gap-2 text-[12.5px]">
              {pr ? (
                <div className="grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 leading-[1.45]">
                  {!hourly && (
                    <>
                      <span className="text-muted">{t('Unit price')}</span>
                      <span>
                        <span className="font-mono">CHF {fmt2(pr.net_unit_cost)}</span> <span className="text-muted">· {unitNote}</span>
                      </span>
                    </>
                  )}
                  <span className="text-muted">{t('Material')}</span>
                  <span className="font-mono text-body break-words">{hourly ? t('Hourly work: no material') : materialSentence(pr, p.unit, t)}</span>
                  <span className="text-muted">{t('Hours')}</span>
                  <span className="font-mono text-body break-words">
                    {hourly && !hoursSet ? t('{h} h from the tender (hourly work)', { h: fmtQty(pr.quantity) }) : hoursSentence(pr, p.unit, t, hoursSet)}
                  </span>
                  <span className="text-muted">{t('Labour')}</span>
                  <span className="font-mono text-body break-words">{labourSentence(pr, t, hourly)}</span>
                  <span className="font-semibold">{t('Line total')}</span>
                  <span className="font-mono font-semibold">
                    {fmt2(pr.material)} + {fmt2(pr.labour)} = CHF {fmt2(pr.direct)}
                  </span>
                </div>
              ) : (
                <span className="text-muted">{t('Not priced. {r}', { r: p.status_reason ?? '' })}</span>
              )}
              {x.comparison && <ComparisonPanel key={p.lv_id + x.comparison.product_id} cmp={x.comparison} rule={x.makeRule} defaultOpen={false} />}
            </div>
          )}
        </div>
      </div>
      {place && <Arrow place={place} />}
    </div>,
    document.body,
  )
}
