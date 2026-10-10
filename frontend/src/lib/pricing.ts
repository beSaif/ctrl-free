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
