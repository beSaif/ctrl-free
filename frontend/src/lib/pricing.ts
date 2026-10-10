// Pricing helpers shared by Pricing, Overview, Export and Change product.
import type { T } from '../i18n'
import type { PricingResponse, PricingSettings, Scenario, Totals } from '../api/types'
import { fmt0 } from './format'

export const OPTION_ORDER = ['Aggressive', 'Target', 'Standard', 'Conservative']

export const PROJECT_COST_FALLBACK = [
  { key: 'engineering', amount: 60900, hours: 420, rate: 145 },
  { key: 'commissioning', amount: 24800, hours: 160, rate: 155 },
  { key: 'hygiene', amount: 18000 },
  { key: 'documentation', amount: 12000 },
]

const PC_LABEL: Record<string, string> = {
  engineering: 'Engineering',
  commissioning: 'Commissioning',
  hygiene: 'Hygiene inspection',
  documentation: 'Documentation',
}

export function projectCostItems(totals: Totals | undefined, settings: PricingSettings | undefined, t: T) {
  const items = totals?.project_cost_items?.length ? totals.project_cost_items : PROJECT_COST_FALLBACK
  const keys = settings ? Object.keys(settings.project_costs) : items.map((i) => i.key)
  return keys.map((key) => {
    const it = items.find((i) => i.key === key) ?? { key, amount: 0 }
    const name = t(PC_LABEL[key] ?? key)
    const given = (it as { label?: string }).label
    const label = it.hours && it.rate ? `${name} ${it.hours} h × CHF ${it.rate}` : given ? t(given) : name
    return { key, label, amount: it.amount, on: !!settings?.project_costs[key] }
  })
}

export function allProjectCosts(totals: Totals | undefined) {
  const items = totals?.project_cost_items?.length ? totals.project_cost_items : PROJECT_COST_FALLBACK
  return items.reduce((a, i) => a + i.amount, 0)
}

export function standardMargin(s?: PricingSettings) {
  return s?.margins?.Standard ?? 5.5
}

/** Price at standard margin if the direct cost moved by `delta` (transport and overhead apply on top). */
export function standardPriceFor(p: PricingResponse | undefined, delta: number): number | null {
  if (!p) return null
  const s = p.settings
  const cost = p.totals.cost + delta * (1 + s.transport_pct / 100) * (1 + s.overhead_pct / 100)
  return Math.ceil(cost / (1 - standardMargin(s) / 100) / 1000) * 1000
}

export function sortScenarios(sc: Scenario[]) {
  return [...sc].sort((a, b) => {
    const ia = OPTION_ORDER.indexOf(a.name)
    const ib = OPTION_ORDER.indexOf(b.name)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/** The option shown before the estimator picks one: Target (as designed), else the best expected profit. */
export const DEFAULT_PREVIEW = 'Target'
export function previewScenario(sc: Scenario[], chosen?: string | null): Scenario | undefined {
  return sc.find((x) => x.name === chosen) ?? sc.find((x) => x.name === DEFAULT_PREVIEW) ?? bestScenario(sc) ?? sc[0]
}

export function bestScenario(sc: Scenario[]): Scenario | undefined {
  return sc.find((s) => s.best) ?? sc.reduce<Scenario | undefined>((a, b) => (!a || b.expected > a.expected ? b : a), undefined)
}

const pts = (v: number) => Math.round(Math.abs(v) * 100)

/** "Why 63%: it starts at 55%, plus 5 because we want the job, ..." built from the settings. */
export function winWords(s: PricingSettings, ch: Scenario, totals: Totals, t: T): string {
  const std = standardMargin(s)
  const ref = totals.cost / (1 - std / 100)
  const stdPrice = Math.ceil(ref / 1000) * 1000
  const rel = (ch.bid / ref - 1) * 100
  const parts: string[] = [t('Why {p}: it starts at {ref}', { p: Math.round(ch.win * 100) + '%', ref: Math.round(s.ref_win * 100) + '%' })]
  if (s.appetite > 0) parts.push(t('plus {n} because we want the job', { n: pts(s.appetite) }))
  if (s.appetite < 0) parts.push(t('minus {n} because the job is not a priority', { n: pts(s.appetite) }))
  if (s.competition > 0) parts.push(t('plus {n} for light competition', { n: pts(s.competition) }))
  if (s.competition < 0) parts.push(t('minus {n} for strong competition', { n: pts(s.competition) }))
  if (Math.abs(rel) >= 0.05) {
    const n = (s.sensitivity * Math.abs(rel) * 100).toFixed(0)
    parts.push(
      rel < 0
        ? t('plus {n} because this price is {r}% below the standard price', { n, r: (-rel).toFixed(1) })
        : t('minus {n} because this price is {r}% above the standard price', { n, r: rel.toFixed(1) }),
    )
  }
  return parts.join(', ') + ' ' + t('(CHF {price} at {m}%).', { price: fmt0(stdPrice), m: std.toFixed(1) })
}

// ---- the win-chance model, client side (same formula as backend/app/pricing.py scenarios) ----

/** win(price) = clamp(ref_win + appetite + competition − sensitivity × % above the standard price). */
export function winAt(s: PricingSettings, cost: number, price: number): number {
  const ref = cost / (1 - standardMargin(s) / 100)
  const rel = (price / ref - 1) * 100
  const raw = s.ref_win + s.appetite + s.competition - s.sensitivity * rel
  return Math.min(s.max_win ?? 0.95, Math.max(s.min_win ?? 0.05, raw))
}

/** The price options for a cost: offer price rounded up to 1'000, win chance, profit, expected profit. */
export function scenariosAt(cost: number, s: PricingSettings): Scenario[] {
  const rnd = s.round_to || 1000
  const order = OPTION_ORDER.filter((n) => s.margins[n] !== undefined)
  const names = [...order, ...Object.keys(s.margins).filter((n) => !order.includes(n))]
  const sc: Scenario[] = names.map((name) => {
    const m = s.margins[name]
    const bid = Math.ceil(cost / (1 - m / 100) / rnd) * rnd
    const p = winAt(s, cost, bid)
    return { name, margin_pct: m, bid, win: p, profit: bid - cost, expected: p * (bid - cost) }
  })
  const best = sc.reduce<Scenario | undefined>((a, b) => (!a || b.expected > a.expected ? b : a), undefined)
  sc.forEach((x) => (x.best = x === best))
  return sc
}

export interface CurvePoint {
  price: number
  margin: number
  win: number
  expected: number
}

/** Win chance and expected profit for every price between two margins (unrounded prices). */
export function priceCurve(s: PricingSettings, cost: number, mLo: number, mHi: number, n = 160): CurvePoint[] {
  const lo = cost / (1 - mLo / 100)
  const hi = cost / (1 - mHi / 100)
  return Array.from({ length: n + 1 }, (_, i) => {
    const price = lo + ((hi - lo) * i) / n
    const win = winAt(s, cost, price)
    return { price, margin: (1 - cost / price) * 100, win, expected: win * (price - cost) }
  })
}

/** The competition call one step stronger (dir −1) or lighter (dir +1), if there is one. */
export function competitionStep(v: number, dir: -1 | 1): { value: number; label: string } | null {
  const sorted = [...COMPETITION].sort((a, b) => a.value - b.value)
  const i = sorted.findIndex((o) => Math.abs(o.value - v) < 1e-9)
  if (i < 0) return null
  return sorted[i + dir] ?? null
}

/** Flattened settings ("factors.site_efficiency") without the bookkeeping fields. */
export function flatSettings(s: PricingSettings): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  const skip = new Set(['changed_by', 'notes', 'chosen', 'min_win', 'max_win', 'round_to'])
  for (const [k, v] of Object.entries(s)) {
    if (skip.has(k) || v === null || v === undefined) continue
    if (typeof v === 'object') for (const [kk, vv] of Object.entries(v as Record<string, number | boolean>)) out[`${k}.${kk}`] = vv
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** Keys whose value differs from the default, in a stable order. */
export function changedKeys(s: PricingSettings, d: PricingSettings): string[] {
  const fs = flatSettings(s)
  const fd = flatSettings(d)
  return Object.keys(fs).filter((k) => (typeof fs[k] === 'number' ? Math.abs((fs[k] as number) - ((fd[k] as number) ?? NaN)) > 1e-9 || fd[k] === undefined : fs[k] !== !!fd[k]))
}

/** Who changed a setting and when (changed_by is nested like the setting on the server, flat in the demo data). */
export function changedByOf(s: PricingSettings, key: string): { by: string; at: string } | null {
  const cb = (s.changed_by ?? {}) as Record<string, unknown>
  const flat = cb[key] as { by?: string; at?: string } | undefined
  const [g, sub] = key.split('.')
  const nested = sub ? ((cb[g] as Record<string, { by?: string; at?: string } | null> | undefined)?.[sub] ?? undefined) : undefined
  const c = (flat && flat.by ? flat : nested) ?? null
  return c && c.by ? { by: c.by, at: c.at ?? '' } : null
}

export const COMPETITION = [
  { value: 0.05, label: 'Light' },
  { value: 0, label: 'Normal' },
  { value: -0.05, label: 'Strong' },
  { value: -0.1, label: 'Very strong' },
]
export const APPETITE = [
  { value: -0.05, label: 'Not a priority' },
  { value: 0, label: 'Neutral' },
  { value: 0.05, label: 'We want it' },
  { value: 0.1, label: 'Must win' },
]
export const SENSITIVITY = [
  { value: 0.03, label: 'Low' },
  { value: 0.05, label: 'Normal' },
  { value: 0.08, label: 'High' },
]

export function callLabel(list: { value: number; label: string }[], v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  return list.find((x) => Math.abs(x.value - v) < 1e-9)?.label ?? null
}
