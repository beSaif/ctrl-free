// Line (position) logic shared by the list, the detail and the header counts.
import type { T } from '../i18n'
import type { CatalogRow, Position, PositionPrice, QuoteGroup } from '../api/types'
import { fmt2, fmtNum, fmtQty, fmtUnit } from './format'

export const C = {
  ink: 'var(--color-ink)',
  muted: 'var(--color-muted)',
  faint: 'var(--color-faint)',
  stone: 'var(--color-stone)',
  accent: 'var(--color-accent)',
  attn: 'var(--color-attn)',
}

export function isSupplier(p: Position): boolean {
  if (p.product?.supplier_quote_required) return true
  const src = p.pricing?.unit_price_source
  return p.status === 'supplier_quote_required' || src === 'supplier_package' || src === 'supplier_quote'
}

export function quotedPrice(p: Position): number | null {
  return p.supplier_quote?.unit_price ?? null
}

/** Budget (catalogue) unit price of the product. */
export function budgetPrice(p: Position, cat?: Record<string, CatalogRow>): number | null {
  const pid = p.overrides?.product_id ?? p.match?.product_id
  const row = p.product ?? (pid && cat ? cat[pid] : undefined)
  if (row?.net_cost_chf !== undefined) return row.net_cost_chf
  return p.pricing?.calculated?.net_unit_cost ?? null
}

export function isPriceable(p: Position) {
  return p.status !== 'out_of_scope' && p.status !== 'non_priceable'
}

/** A line needs the estimator: the server's needs_review, so the Lines tab, the overview, the tender
 *  list and the export checklist all count the same lines (a supplier line leaves review once a quote is in). */
export function isOpen(p: Position): boolean {
  if (p.needs_review !== undefined && p.needs_review !== null) return !!p.needs_review
  if (p.confirmed) return false
  return !!p.flagged || (isSupplier(p) && isPriceable(p) && quotedPrice(p) === null)
}

/** The line can still be confirmed: open, or a supplier line whose quote was entered but not confirmed yet. */
export function canConfirm(p: Position): boolean {
  if (p.confirmed) return false
  return isOpen(p) || (isSupplier(p) && isPriceable(p))
}

export function wasChanged(p: Position): boolean {
  const o = p.overrides ?? {}
  return o.quantity != null || o.unit_price != null || o.hours != null || (o.product_id != null && o.product_id !== p.match?.product_id)
}

export interface StatusView {
  label: string
  fg: string
  marker: string
}

export function lineStatus(p: Position, t: T): StatusView {
  const sup = isSupplier(p)
  const quoted = quotedPrice(p) !== null
  if (p.confirmed) {
    return { label: sup && !quoted ? t('Confirmed on budget price') : t('Confirmed'), fg: C.ink, marker: C.ink }
  }
  if (p.status === 'out_of_scope' || p.status === 'non_priceable') return { label: t('Not priced'), fg: C.faint, marker: C.faint }
  if (p.status === 'insufficient_information') return { label: t('Missing info'), fg: C.attn, marker: C.attn }
  if (p.status === 'review_required') return { label: t('Check this'), fg: C.attn, marker: C.attn }
  if (sup && quoted) return { label: t('Quote entered, confirm'), fg: C.accent, marker: C.accent }
  if (sup) return { label: t('Needs supplier quote'), fg: C.attn, marker: C.attn }
  if (p.flagged) return { label: t('Flagged for review'), fg: C.attn, marker: C.attn }
  if (p.status === 'assumption_applied') return { label: t('Priced, with a guess'), fg: C.attn, marker: C.attn }
  return { label: t('Priced'), fg: C.muted, marker: C.stone }
}

export function matchView(p: Position, t: T): { label: string; fg: string; strong: boolean; line: string } {
  if (isSupplier(p) && isPriceable(p) && p.status !== 'insufficient_information') {
    if (p.supplier_quote) return { label: t('Quote'), fg: C.muted, strong: false, line: t('Priced with the supplier quote') }
    if ((p.pricing?.direct ?? 0) > 0)
      return { label: t('Budget'), fg: C.muted, strong: false, line: t('Catalogue has only a budget figure for this product') }
    return { label: t('Not in catalogue'), fg: C.muted, strong: false, line: t('Not in the catalogue: ask a supplier for a price') }
  }
  const m = p.match
  if (!m || !m.product_id) return { label: t('None'), fg: C.attn, strong: true, line: t('No product matched') }
  const label = m.label || (m.confidence >= 0.85 ? 'Strong' : m.confidence >= 0.75 ? 'Close' : m.confidence >= 0.5 ? 'Weak' : 'None')
  const close = label !== 'Strong'
  const k = 'match.' + label
  const shown = t(k) === k ? label : t(k)
  return {
    label: shown,
    fg: close ? C.ink : C.muted,
    strong: close,
    line: t('{label} match: {reason}', { label: shown, reason: m.reason ?? '' }),
  }
}

export function productLabel(p: Position, cat?: Record<string, CatalogRow>): string {
  const pid = p.overrides?.product_id ?? p.match?.product_id
  const row = p.product ?? (pid && cat ? cat[pid] : undefined)
  return row?.description ?? pid ?? '–'
}

export function title(p: Position, lang: 'en' | 'de'): { main: string; sub: string } {
  return { main: p.title_de, sub: lang === 'en' ? (p.title_en ?? '') : '' }
}

/** Plain sentences for the open lines, one per kind of open work (Overview step 1). */
export function reviewBreakdown(open: Position[], totalDirect: number, t: T): string[] {
  const d = (p: Position) => p.pricing?.direct ?? 0
  const budget = open.filter((p) => isSupplier(p) && quotedPrice(p) === null && p.pricing?.unit_price_source === 'supplier_package')
  const rest = open.filter((p) => !budget.includes(p))
  const noCat = rest.filter((p) => p.status === 'supplier_quote_required' && !p.pricing)
  const noQty = rest.filter((p) => p.status === 'insufficient_information')
  const guess = rest.filter((p) => p.status === 'assumption_applied')
  const check = rest.filter((p) => p.status === 'review_required')
  const other = rest.length - noCat.length - noQty.length - guess.length - check.length
  const out: string[] = []
  if (budget.length) {
    const b = budget.reduce((a, p) => a + d(p), 0)
    out.push(
      t(budget.length === 1 ? '1 runs on a budget price: CHF {amount} of direct cost ({share}).' : '{n} run on budget prices: CHF {amount} of direct cost ({share}).', {
        n: budget.length,
        amount: fmtNum(b, 0),
        share: Math.round(totalDirect ? (b / totalDirect) * 100 : 0) + '%',
      }),
    )
  }
  const add = (n: number, one: string, many: string) => n > 0 && out.push(t(n === 1 ? one : many, { n }))
  add(noCat.length, '1 is not in the catalogue and needs a supplier price.', '{n} are not in the catalogue and need a supplier price.')
  add(noQty.length, '1 has no quantity in the tender.', '{n} have no quantity in the tender.')
  add(guess.length, '1 is priced with an assumption: check it.', '{n} are priced with an assumption: check them.')
  add(check.length, '1 needs a product checked.', '{n} need a product checked.')
  add(other, '1 more is flagged or has a quote to confirm.', '{n} more are flagged or have a quote to confirm.')
  return out
}

// ---- grouping for the list ------------------------------------------------------------

export type LineFilter = 'review' | 'priced' | 'all' | 'check' | 'missing' | 'notpriced'
/** 'type': each filter's working order (product type, money at risk); 'order': as printed in the tender. */
export type LineGroupBy = 'type' | 'order'

/** A group row; `parent` is set on a section heading inside a system (tender order). */
export type Row =
  | { type: 'group'; key: string; name: string; meta: string; req?: string; reqFg?: string; sub: number; parent?: string }
  | { type: 'line'; p: Position }

const direct = (p: Position) => p.pricing?.direct ?? 0
const sum = (ps: Position[]) => ps.reduce((a, p) => a + direct(p), 0)
const byAmount = (a: Position, b: Position) => direct(b) - direct(a)
const matchRank = (p: Position) => (p.match?.label === 'Strong' ? 1 : 0)

export function matchesSearch(p: Position, q: string) {
  if (!q.trim()) return true
  const s = q.trim().toLowerCase().replace(/^p\.\s*/, '')
  return `${p.lv_id} ${p.title_de} ${p.title_en ?? ''} ${p.text_de} ${p.page} ${p.system}`.toLowerCase().includes(s)
}

export function filterCounts(ps: Position[]) {
  return {
    review: ps.filter(isOpen).length,
    priced: ps.filter((p) => !isSupplier(p) && (p.status === 'calculated' || p.status === 'assumption_applied')).length,
    all: ps.length,
    check: ps.filter((p) => p.status === 'review_required').length,
    missing: ps.filter((p) => p.status === 'insufficient_information').length,
    notpriced: ps.filter((p) => !isPriceable(p)).length,
  }
}

const inFilter: Record<LineFilter, (p: Position) => boolean> = {
  review: isOpen,
  priced: (p) => !isSupplier(p) && (p.status === 'calculated' || p.status === 'assumption_applied'),
  all: () => true,
  check: (p) => p.status === 'review_required',
  missing: (p) => p.status === 'insufficient_information',
  notpriced: (p) => !isPriceable(p),
}

function pagesLabel(ls: Position[], t: T) {
  const lo = Math.min(...ls.map((p) => p.page))
  const hi = Math.max(...ls.map((p) => p.page))
  return lo === hi ? t('p. {page}', { page: lo }) : t('pp. {a} to {b}', { a: lo, b: hi })
}

/** Tender order: the filter's lines as printed, under the PDF's system and section headings (letter + name). */
function orderRows(all: Position[], ps: Position[], filter: LineFilter, t: T, nLines: (n: number) => string) {
  const at = new Map(all.map((p, i) => [p.lv_id, p.pdf_order ?? i]))
  const ls = ps.filter(inFilter[filter]).sort((a, b) => at.get(a.lv_id)! - at.get(b.lv_id)!)
  // consecutive runs, so a heading appears where the PDF has it
  const runs = (xs: Position[], same: (a: Position, b: Position) => boolean) =>
    xs.reduce<Position[][]>((acc, p) => {
      const last = acc[acc.length - 1]
      if (last && same(last[0], p)) last.push(p)
      else acc.push([p])
      return acc
    }, [])
  const rows: Row[] = []
  const queue: Position[] = []
  for (const sys of runs(ls, (a, b) => a.system === b.system)) {
    const sk = 'o-' + at.get(sys[0].lv_id)
    rows.push({ type: 'group', key: sk, name: sys[0].system || t('Other'), meta: nLines(sys.length) + ' · ' + pagesLabel(sys, t), sub: sum(sys) })
    for (const sec of runs(sys, (a, b) => (a.section ?? '') === (b.section ?? ''))) {
      const s0 = sec[0]
      if (s0.section || s0.section_name)
        rows.push({
          type: 'group',
          key: 'o-' + at.get(s0.lv_id) + '-s',
          name: [s0.section, s0.section_name].filter(Boolean).join(' '),
          meta: nLines(sec.length) + ' · ' + pagesLabel(sec, t),
          sub: sum(sec),
          parent: sk,
        })
      sec.forEach((p) => (rows.push({ type: 'line', p }), queue.push(p)))
    }
  }
  return { rows, queue }
}

export function buildRows(
  all: Position[],
  quotes: QuoteGroup[],
  filter: LineFilter,
  q: string,
  t: T,
  lang: 'en' | 'de' = 'en',
  groupBy: LineGroupBy = 'type',
): { rows: Row[]; queue: Position[] } {
  const ps = all.filter((p) => matchesSearch(p, q))
  const nLines = (n: number) => (n === 1 ? t('{n} line', { n }) : t('{n} lines', { n }))
  if (groupBy === 'order') return orderRows(all, ps, filter, t, nLines)
  const rows: Row[] = []
  const queue: Position[] = []
  const lineRows = (ls: Position[]) => ls.forEach((p) => (rows.push({ type: 'line', p }), queue.push(p)))

  if (filter === 'review') {
    const open = ps.filter(isOpen)
    const allById = new Map(all.map((p) => [p.lv_id, p]))
    const used = new Set<string>()
    const gs = quotes
      .map((g) => ({ g, ls: open.filter((p) => isSupplier(p) && g.lv_ids.includes(p.lv_id)).sort(byAmount) }))
      .filter((x) => x.ls.length)
    const whole = (g: QuoteGroup) => g.lv_ids.reduce((a, id) => a + (allById.get(id) ? direct(allById.get(id)!) : 0), 0)
    gs.sort((x, y) => whole(y.g) - whole(x.g))
    for (const { g, ls } of gs) {
      ls.forEach((p) => used.add(p.lv_id))
      rows.push({
        type: 'group',
        key: 'q-' + g.id,
        name: lang === 'de' && g.title_de ? g.title_de : t(g.title),
        meta: nLines(ls.length) + ' · ' + t('one supplier request'),
        req: g.sent ? t('Request sent') : t('Request not sent'),
        reqFg: g.sent ? C.accent : C.attn,
        sub: sum(ls),
      })
      lineRows(ls)
    }
    const rest = open.filter((p) => !used.has(p.lv_id))
    const buckets: [string, string, (p: Position) => boolean][] = [
      ['sup', 'Ask supplier', (p) => isSupplier(p) && isPriceable(p)],
      ['check', 'Check this', (p) => p.status === 'review_required'],
      ['missing', 'Missing info', (p) => p.status === 'insufficient_information'],
      ['guess', 'Priced, with a guess', (p) => p.status === 'assumption_applied' && !p.flagged],
      ['flag', 'Flagged for review', () => true],
    ]
    const left = new Set(rest.map((p) => p.lv_id))
    for (const [key, name, test] of buckets) {
      const ls = rest.filter((p) => left.has(p.lv_id) && test(p)).sort(byAmount)
      if (!ls.length) continue
      ls.forEach((p) => left.delete(p.lv_id))
      rows.push({ type: 'group', key, name: t(name), meta: nLines(ls.length), sub: sum(ls) })
      lineRows(ls)
    }
  } else if (filter === 'priced') {
    lineRows(
      ps
        .filter((p) => !isSupplier(p) && (p.status === 'calculated' || p.status === 'assumption_applied'))
        .sort((a, b) => matchRank(a) - matchRank(b) || byAmount(a, b)),
    )
  } else if (filter === 'all') {
    const systems: string[] = []
    ps.forEach((p) => {
      if (!systems.includes(p.system)) systems.push(p.system)
    })
    for (const s of systems) {
      const ls = ps.filter((p) => p.system === s)
      const label = s.replace(/^\d+(\.\d+)*\s+/, '')
      rows.push({ type: 'group', key: 's-' + s, name: label, meta: nLines(ls.length), sub: sum(ls) })
      lineRows(ls)
    }
  } else {
    const test =
      filter === 'check'
        ? (p: Position) => p.status === 'review_required'
        : filter === 'missing'
          ? (p: Position) => p.status === 'insufficient_information'
          : (p: Position) => !isPriceable(p)
    lineRows(ps.filter(test))
  }
  return { rows, queue }
}

// ---- sentences ("every number is a sentence") -----------------------------------------------

const FACTOR_LABELS: Record<string, string> = {
  site_efficiency: 'site efficiency',
  mounting_height_school: 'ceiling height',
  mounting_height_sports_hall: 'ceiling height, sports hall',
  school_logistics: 'school logistics',
  timber_interface: 'timber interface',
}

export function factorLabel(key: string, t: T) {
  return t(FACTOR_LABELS[key] ?? key.replace(/_/g, ' '))
}

export function roleLabel(role: string | null, t: T) {
  return role ? t(role.replace(/_/g, ' ')) : t('no role')
}

export function factorsSentence(pr: PositionPrice, t: T): string {
  return pr.factors.map((f) => `${f.op} ${f.value.toFixed(2)} ${factorLabel(f.key, t)}`).join(', ')
}

export function materialSentence(pr: PositionPrice, unit: string | null, t: T): string {
  return t('{qty} {unit} × CHF {price} × (1 + {waste}% waste) = CHF {total}', {
    qty: fmtQty(pr.quantity),
    unit: fmtUnit(unit),
    price: fmt2(pr.net_unit_cost),
    waste: fmtNum(pr.waste_pct, pr.waste_pct % 1 ? 1 : 0),
    total: fmt2(pr.material),
  })
}

export function hoursSentence(pr: PositionPrice, unit: string | null, t: T, typed: boolean): string {
  if (typed) return t('{hours} h, typed by you', { hours: fmt2(pr.hours) })
  const f = pr.factors.map((x) => `${x.op} ${x.value.toFixed(2)} ${factorLabel(x.key, t)}`).join(' ')
  return `${fmtQty(pr.quantity)} ${fmtUnit(unit)} × ${fmt2(pr.base_hours_per_unit)} h ${f} = ${fmt2(pr.hours)} h`
}

export function labourSentence(pr: PositionPrice, t: T, hourly = false): string {
  return t(hourly ? '{hours} h × CHF {rate}/h ({role}, hourly work) = CHF {total}' : '{hours} h × CHF {rate}/h ({role}) = CHF {total}', {
    hours: fmt2(pr.hours),
    rate: fmtNum(pr.rate, 0),
    role: roleLabel(pr.role, t),
    total: fmt2(pr.labour),
  })
}
