// N07 Pricing in two steps. Costs: "what does this job cost us" (project costs, margins, overhead,
// allowances, site factors, cost build-up) with the price always in view. Strategy: "what price do we
// offer" (your read, win chance vs price, the options). Every control PUTs to the server (debounced);
// the UI updates optimistically from the last server totals and settles on the server's numbers.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { usePricing, usePutPricing, useResetPricing, useTender } from '../api/hooks'
import type { PricingPut, PricingResponse, PricingSettings, Scenario, TenderDetail, Totals } from '../api/types'
import { Button, ErrorBox, LinkButton, Loading, Stepper, Toggle } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt0, fmt2, fmtShortDate } from '../lib/format'
import { C } from '../lib/lines'
import {
  APPETITE,
  COMPETITION,
  SENSITIVITY,
  bestScenario,
  callLabel,
  changedByOf,
  changedKeys,
  previewScenario,
  projectCostItems,
  scenariosAt,
  sortScenarios,
  standardMargin,
} from '../lib/pricing'
import { StrategyStep } from './PricingStrategy'

export type Draft = PricingPut

function merge(s: PricingSettings, d: Draft): PricingSettings {
  return {
    ...s,
    ...d,
    margins: { ...s.margins, ...(d.margins ?? {}) },
    factors: { ...s.factors, ...(d.factors ?? {}) },
    project_costs: { ...s.project_costs, ...(d.project_costs ?? {}) },
    notes: { ...s.notes, ...(d.notes ?? {}) },
  } as PricingSettings
}

function mergeDraft(a: Draft, b: Draft): Draft {
  return {
    ...a,
    ...b,
    ...(a.margins || b.margins ? { margins: { ...a.margins, ...b.margins } } : {}),
    ...(a.factors || b.factors ? { factors: { ...a.factors, ...b.factors } } : {}),
    ...(a.project_costs || b.project_costs ? { project_costs: { ...a.project_costs, ...b.project_costs } } : {}),
    ...(a.notes || b.notes ? { notes: { ...a.notes, ...b.notes } } : {}),
  }
}

/** Recompute cost and scenarios from the last server totals with the local settings (instant feedback). */
function localTotals(server: PricingResponse, s: PricingSettings): Totals {
  const tot = server.totals
  const items = tot.project_cost_items ?? []
  const pc = items.length ? items.reduce((a, i) => a + (s.project_costs[i.key] ? i.amount : 0), 0) : tot.project_costs
  const base = tot.direct + pc + tot.small_material + tot.supplier_contingency
  const transport = (base * s.transport_pct) / 100
  const overhead = ((base + transport) * s.overhead_pct) / 100
  const cost = base + transport + overhead
  const ref = cost / (1 - standardMargin(s) / 100)
  return { ...tot, project_costs: pc, transport, overhead, cost, standard_price: Math.ceil(ref / 1000) * 1000, scenarios: scenariosAt(cost, s) }
}

/** Everything both steps share: settings with the local draft, totals, the options and the change function. */
export interface PricingCtx {
  id: string
  t: T
  server: PricingResponse
  tender?: TenderDetail
  s: PricingSettings
  D: PricingSettings
  tot: Totals
  scen: Scenario[]
  best?: Scenario
  shown: Scenario
  busy: boolean
  changed: string[]
  change: (d: Draft, delay?: number) => void
  resetKeys: (keys: string[]) => void
  flush: () => Promise<void>
}

const STEPS = ['costs', 'strategy'] as const
type Step = (typeof STEPS)[number]
const stepKey = (id: string) => `ctrlfree.pricingStep.${id}`

/** /t/:id/pricing opens the step you used last for this tender (Costs the first time). */
export function Pricing() {
  const { id = '', step } = useParams()
  const loc = useLocation()
  if (step === 'costs' || step === 'strategy') return <PricingSteps id={id} step={step} />
  let last: Step = 'costs'
  try {
    if (sessionStorage.getItem(stepKey(id)) === 'strategy') last = 'strategy'
  } catch {
    /* private mode */
  }
  return <Navigate replace to={`/t/${id}/pricing/${last}${loc.hash}`} />
}

function PricingSteps({ id, step }: { id: string; step: Step }) {
  const t = useT()
  const { data: server, isLoading, error } = usePricing(id)
  const { data: tender } = useTender(id)
  const put = usePutPricing(id)
  const reset = useResetPricing(id)
  const [draft, setDraft] = useState<Draft>({})
  const pending = useRef<Draft>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(stepKey(id), step)
    } catch {
      /* private mode */
    }
  }, [id, step])

  const flush = useCallback(async () => {
    const body = pending.current
    pending.current = {}
    if (!Object.keys(body).length) return
    try {
      await put.mutateAsync(body)
    } catch {
      /* rejected: the controls fall back to the server's values */
    } finally {
      if (!Object.keys(pending.current).length) setDraft({})
    }
  }, [put])

  const change = useCallback(
    (d: Draft, delay = 350) => {
      setDraft((x) => mergeDraft(x, d))
      pending.current = mergeDraft(pending.current, d)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), delay)
    },
    [flush],
  )
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (Object.keys(pending.current).length) void flush()
    },
    // flush on unmount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const s = useMemo(() => (server ? merge(server.settings, draft) : null), [server, draft])
  // the local estimate only while a change is on its way; otherwise exactly the server's numbers,
  // so this page shows the same offer price as the overview, the footer and the export
  const hasDraft = Object.keys(draft).length > 0
  const tot = useMemo(() => (server && s ? (hasDraft ? localTotals(server, s) : server.totals) : null), [server, s, hasDraft])
  const busy = put.isPending || reset.isPending || hasDraft

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !server || !s || !tot) return <ErrorBox error={error} label={t('Could not load pricing.')} />

  const D = server.defaults
  const scen = sortScenarios(tot.scenarios)
  const ctx: PricingCtx = {
    id,
    t,
    server,
    tender,
    s,
    D,
    tot,
    scen,
    best: bestScenario(scen),
    shown: previewScenario(scen, s.chosen)!,
    busy,
    changed: changedKeys(s, D),
    change,
    resetKeys: (keys) => {
      if (timer.current) clearTimeout(timer.current)
      pending.current = {}
      setDraft({})
      reset.mutate(keys.length ? keys : undefined)
    },
    flush,
  }

  return (
    <div className="flex-auto flex flex-col">
      <StepBar ctx={ctx} step={step} />
      {step === 'costs' ? <CostsStep ctx={ctx} /> : <StrategyStep ctx={ctx} />}
    </div>
  )
}

function StepBar({ ctx, step }: { ctx: PricingCtx; step: Step }) {
  const { id, t, changed, shown, s } = ctx
  const items: { k: Step; n: number; label: string; sub: string; info: string }[] = [
    { k: 'costs', n: 1, label: t('Costs'), sub: t('what does this job cost us'), info: 'CHF ' + fmt0(ctx.tot.cost) },
    {
      k: 'strategy',
      n: 2,
      label: t('Strategy'),
      sub: t('what price do we offer'),
      info: s.chosen ? 'CHF ' + fmt0(shown.bid) : t('price not chosen'),
    },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 border-b border-rule">
      <nav aria-label={t('Pricing steps')} className="flex flex-wrap gap-1">
        {items.map((it) => (
          <NavLink
            key={it.k}
            to={`/t/${id}/pricing/${it.k}`}
            aria-current={it.k === step ? 'page' : undefined}
            className={cx(
              'inline-flex items-baseline gap-2 min-h-11 px-3 pt-2.5 border-b-2 no-underline',
              it.k === step ? 'border-ink text-ink!' : 'border-transparent text-muted! hover:text-ink!',
            )}
          >
            <span className="font-mono text-[12.5px]">{it.n}</span>
            <span className={cx(it.k === step && 'font-semibold')}>{it.label}</span>
            <span className="text-[13px] text-muted max-[900px]:hidden">{it.sub}</span>
            <span className={cx('font-mono text-[12.5px]', it.k === 'strategy' && !s.chosen ? 'text-attn' : 'text-muted')}>{it.info}</span>
          </NavLink>
        ))}
      </nav>
      <span className="flex-auto" />
      <span className="text-[13px] text-muted max-[1560px]:hidden">{t('Your choices here apply to this tender only.')}</span>
      <span className="text-[13px]" style={{ color: changed.length ? C.accent : C.faint }} title={t('Your choices here apply to this tender only.')}>
        {changed.length ? t('{n} changed from defaults', { n: changed.length }) : t('All values are defaults')}
      </span>
      <Button size="xs" className="min-h-[34px]" onClick={() => ctx.resetKeys([])} disabled={!changed.length}>
        {t('Reset all')}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- setting labels, values, effects

const MARGIN_LABEL: Record<string, string> = {
  Aggressive: 'Aggressive margin',
  Target: 'Target margin',
  Standard: 'Standard margin',
  Conservative: 'Conservative margin',
}
const FACTOR_LABEL: Record<string, string> = {
  site_efficiency: 'Site efficiency (hours ÷)',
  school_logistics: 'School logistics',
  mounting_height_school: 'Mounting height, school',
  mounting_height_sports_hall: 'Mounting height, sports hall',
  timber_interface: 'Timber interface',
}
const KEY_LABEL: Record<string, string> = {
  competition: 'How strong is the competition?',
  appetite: 'How much do we want this job?',
  sensitivity: 'How price sensitive is this client?',
  ref_win: 'Win chance at the standard price',
  overhead_pct: 'Overhead',
  transport_pct: 'Transport and equipment',
  material_waste_pct: 'Material waste',
  small_material_pct: 'Small material',
  supplier_contingency_pct: 'Supplier package contingency',
  include_small_material: 'Add small material to the price',
  include_supplier_contingency: 'Add the contingency on supplier packages',
}
/** Settings that live on the Strategy step (they move the win chance, not the cost). */
const STRATEGY_KEYS = new Set(['competition', 'appetite', 'sensitivity', 'ref_win'])

function settingLabel(key: string, ctx: PricingCtx): string {
  const { t } = ctx
  const [g, sub] = key.split('.')
  if (g === 'margins') return t(MARGIN_LABEL[sub] ?? sub)
  if (g === 'factors') return t(FACTOR_LABEL[sub] ?? sub)
  if (g === 'project_costs') return projectCostItems(ctx.tot, ctx.s, t).find((i) => i.key === sub)?.label ?? sub
  return t(KEY_LABEL[key] ?? key)
}

function settingValue(key: string, v: number | boolean | undefined, t: T): string {
  if (v === undefined) return ''
  if (typeof v === 'boolean') return v ? t('On') : t('Off')
  const [g, sub] = key.split('.')
  if (g === 'factors') return sub === 'site_efficiency' ? v.toFixed(2) : '× ' + v.toFixed(2)
  if (key === 'ref_win') return Math.round(v * 100) + '%'
  if (key === 'competition' || key === 'appetite' || key === 'sensitivity') {
    const list = key === 'competition' ? COMPETITION : key === 'appetite' ? APPETITE : SENSITIVITY
    return t(callLabel(list, v) ?? String(v))
  }
  return v.toFixed(1) + '%'
}

function flatGet(s: PricingSettings, key: string): number | boolean | undefined {
  const [g, sub] = key.split('.')
  const v = (s as unknown as Record<string, unknown>)[g]
  return (sub ? (v as Record<string, number | boolean> | undefined)?.[sub] : v) as number | boolean | undefined
}

interface Effect {
  /** CHF on the shown offer (or on one option's price for a margin); null while the server works it out */
  chf: number | null
  /** win chance points (the read and the reference win chance) */
  pts?: number
  /** option the CHF applies to when it is not the shown offer */
  on?: string
}

/** What a changed setting does to the offer, against its default. Exact, before rounding up to 1'000. */
function effectOf(key: string, ctx: PricingCtx): Effect | null {
  const { s, D, tot, shown, server } = ctx
  const [g, sub] = key.split('.')
  if (g === 'margins') {
    const m = s.margins[sub]
    const md = D.margins[sub] ?? m
    return { chf: tot.cost / (1 - m / 100) - tot.cost / (1 - md / 100), on: sub === shown.name ? undefined : sub }
  }
  if (key === 'competition' || key === 'appetite' || key === 'ref_win') return { chf: 0, pts: Math.round(((flatGet(s, key) as number) - (flatGet(D, key) as number)) * 100) }
  if (key === 'sensitivity') return null
  if (!server.effects) return null // offline demo data has no per-setting effects
  const e = server.effects[key]
  return { chf: e === undefined ? null : e / (1 - shown.margin_pct / 100) }
}

function EffectText({ e, ctx }: { e: Effect | null; ctx: PricingCtx }) {
  const { t, busy } = ctx
  if (!e) return <span className="text-faint">–</span>
  if (e.pts !== undefined)
    return (
      <span className="font-mono" title={t('Win chance')}>
        {t(e.pts >= 0 ? '+{n} points' : '−{n} points', { n: Math.abs(e.pts) })}
      </span>
    )
  if (e.chf === null) return <span className="font-mono text-faint cf-pending">CHF …</span>
  const sign = e.chf > 0.5 ? '+ ' : e.chf < -0.5 ? '− ' : '± '
  return (
    <span
      className={cx('font-mono', busy && 'cf-pending')}
      title={(e.on ? t('on the {name} price', { name: t(e.on) }) : t('on the offer')) + ' · ' + t('Against the default, before rounding up to 1’000')}
    >
      {sign}CHF {fmt0(Math.abs(e.chf))}
    </span>
  )
}

// ---------------------------------------------------------------- Costs step

function CostsStep({ ctx }: { ctx: PricingCtx }) {
  const { t, s, tot, change, busy, id } = ctx
  const loc = useLocation()
  useEffect(() => {
    // deep links such as /pricing/costs#site-factors (from a line's hours)
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [loc.hash])

  const r = (x: number, step: number) => Math.round(x / step) * step
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
  const num = (key: string, step: number, lo: number, hi: number, set: (v: number) => Draft) => {
    const val = flatGet(s, key) as number
    const label = settingLabel(key, ctx)
    return (
      <SettingRow key={key} k={key} ctx={ctx}>
        <Stepper
          label={label}
          value={settingValue(key, val, t)}
          pending={busy}
          onDec={() => change(set(clamp(Number(r(val - step, step).toFixed(4)), lo, hi)))}
          onInc={() => change(set(clamp(Number(r(val + step, step).toFixed(4)), lo, hi)))}
          decDisabled={val <= lo + 1e-9}
          incDisabled={val >= hi - 1e-9}
        />
      </SettingRow>
    )
  }
  const marginKeys = ['Aggressive', 'Target', 'Standard', 'Conservative'].filter((k) => s.margins[k] !== undefined)
  const pcItems = projectCostItems(tot, s, t)
  const pcOn = pcItems.filter((i) => i.on)
  const pcAll = pcItems.reduce((a, i) => a + i.amount, 0)
  const pcSum = pcOn.reduce((a, i) => a + i.amount, 0)
  // what a project cost would add to the offer: amount + transport + overhead, then the shown margin
  const onOffer = (amount: number) => (amount * (1 + s.transport_pct / 100) * (1 + s.overhead_pct / 100)) / (1 - ctx.shown.margin_pct / 100)

  return (
    <main className="flex-auto flex flex-wrap items-start">
      <section aria-label={t('Costs')} className="flex-[1_1_600px] max-w-[880px] min-w-0 px-6 pt-5 pb-10 flex flex-col gap-6 border-r border-rule">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[20px] font-semibold">{t('What does this job cost us?')}</h1>
          <p className="m-0 text-muted">{t('Project costs, margins, allowances and site factors. The price on the right follows every change; each change shows what it does to the offer.')}</p>
        </div>

        <ChangesBox ctx={ctx} />

        <SettingsGroup
          title={t('Project costs')}
          aside={
            <span className={cx('text-[13px] font-medium', pcOn.length ? 'text-ink' : 'text-attn')}>
              {pcOn.length ? t('CHF {a} in the price', { a: fmt0(pcSum) }) : t('Not in the price yet · CHF {a} if all on', { a: fmt0(pcAll) })}
            </span>
          }
          note={tot.lines ? t('These are not in the {n} lines. Switch on what this offer has to carry.', { n: tot.lines }) : t('These are not in the lines. Switch on what this offer has to carry.')}
          attn={!pcOn.length}
        >
          {pcItems.map((c) => (
            <SettingRow
              key={c.key}
              k={'project_costs.' + c.key}
              ctx={ctx}
              toggle={{ on: c.on, set: (v) => change({ project_costs: { [c.key]: v } }, 0), amount: c.amount }}
              idle={!c.on ? <span className="font-mono text-faint">{t('would add CHF {a}', { a: fmt0(onOffer(c.amount)) })}</span> : undefined}
            />
          ))}
        </SettingsGroup>

        <SettingsGroup title={t('Margins and overhead')} note={t('A margin sets the price of its option; overhead and transport go on the cost.')}>
          {marginKeys.map((k) => num('margins.' + k, 0.5, 0, 15, (v) => ({ margins: { [k]: v } })))}
          {num('overhead_pct', 0.5, 0, 20, (v) => ({ overhead_pct: v }))}
          {num('transport_pct', 0.5, 0, 10, (v) => ({ transport_pct: v }))}
        </SettingsGroup>

        <SettingsGroup id="site-factors" title={t('Allowances and site factors')} note={t('change one and all lines recalculate')}>
          {num('material_waste_pct', 0.5, 0, 20, (v) => ({ material_waste_pct: v }))}
          {num('small_material_pct', 0.5, 0, 20, (v) => ({ small_material_pct: v }))}
          <SettingRow k="include_small_material" ctx={ctx} toggle={{ on: s.include_small_material, set: (v) => change({ include_small_material: v }) }} />
          {num('supplier_contingency_pct', 0.5, 0, 20, (v) => ({ supplier_contingency_pct: v }))}
          <SettingRow
            k="include_supplier_contingency"
            ctx={ctx}
            toggle={{ on: s.include_supplier_contingency, set: (v) => change({ include_supplier_contingency: v }) }}
          />
          {Object.keys(s.factors).map((k) => num('factors.' + k, 0.01, 0.5, 2, (v) => ({ factors: { [k]: v } })))}
        </SettingsGroup>

        <span className="text-[13px] text-muted">
          {t('All start from the default parameters in')} <a href="/reference?tab=params">{t('Reference data')}</a> (project_parameters.json).{' '}
          {t('Hover a setting to see where its default comes from.')}
        </span>
      </section>

      <aside aria-label={t('Price so far')} className="flex-[1_1_380px] max-w-[540px] min-w-[340px] px-6 pt-5 pb-6 sticky top-0 self-start flex flex-col gap-5">
        <PriceSummary ctx={ctx} />
        <Buildup ctx={ctx} />
        <LinkButton to={`/t/${id}/pricing/strategy`} variant="primary" className="self-start">
          {t('Next: choose the offer price')}
        </LinkButton>
      </aside>
    </main>
  )
}

function SettingsGroup({ id, title, note, aside, attn, children }: { id?: string; title: string; note?: string; aside?: ReactNode; attn?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={cx('flex flex-col border scroll-mt-4', attn ? 'border-attn' : 'border-rule')}>
      <div className="flex flex-wrap justify-between items-baseline gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <h2 className="m-0 text-[15px] font-semibold">
          {title} {note && <span className="font-normal text-[13px] text-muted">· {note}</span>}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** One setting: control, default and who changed it, CHF effect on the offer, reset. */
function SettingRow({
  k,
  ctx,
  children,
  toggle,
  idle,
}: {
  k: string
  ctx: PricingCtx
  children?: ReactNode
  toggle?: { on: boolean; set: (v: boolean) => void; amount?: number }
  idle?: ReactNode
}) {
  const { t, s, D, server, changed } = ctx
  const lang = useLang()
  const isChanged = changed.includes(k)
  const label = settingLabel(k, ctx)
  const src = server.sources?.[k]
  const who = changedByOf(s, k)
  const meta = isChanged && (
    <span className="text-[12.5px]" style={{ color: C.accent }}>
      {t('default {v}', { v: settingValue(k, flatGet(D, k), t) })}
      {who && ` · ${t(who.by)} · ${who.at ? fmtShortDate(who.at, lang) : t('today')}`}
    </span>
  )
  return (
    <div
      id={'set-' + k}
      title={src ? t('Default from {src}', { src }) : undefined}
      className={cx(
        'grid grid-cols-[minmax(0,1fr)_auto_176px_108px] gap-x-3 items-center min-h-12 pl-4 pr-3 py-1 border-t border-rowrule scroll-mt-24',
        isChanged && 'bg-sel/50 shadow-[inset_3px_0_0_var(--color-accent)]',
      )}
    >
      {toggle ? (
        <Toggle checked={toggle.on} onChange={toggle.set} className="col-span-2 min-h-10">
          <span className="flex-auto flex flex-col">
            <span className={cx(isChanged && 'font-medium')}>{label}</span>
            {meta}
          </span>
          {toggle.amount !== undefined && <span className="font-mono text-muted">{fmt0(toggle.amount)}</span>}
        </Toggle>
      ) : (
        <>
          <span className="flex flex-col min-w-0">
            <span className={cx(isChanged && 'font-medium')}>{label}</span>
            {meta}
          </span>
          {children}
        </>
      )}
      <span className="text-right text-[13px] whitespace-nowrap" style={{ color: isChanged ? C.accent : undefined }}>
        {isChanged ? <EffectText e={effectOf(k, ctx)} ctx={ctx} /> : idle}
      </span>
      <span className="text-right">
        {isChanged && (
          <Button size="xs" className="min-h-[30px] px-2" onClick={() => ctx.resetKeys([k])} aria-label={t('Reset {name} to default', { name: label })}>
            {t('Reset')}
          </Button>
        )}
      </span>
    </div>
  )
}

/** "What changed from defaults": setting, default → now, CHF effect, who. Obvious at a glance on coming back. */
function ChangesBox({ ctx }: { ctx: PricingCtx }) {
  const { t, s, D, changed, id } = ctx
  const lang = useLang()
  const nav = useNavigate()
  if (!changed.length)
    return (
      <div className="flex items-center gap-2 px-4 py-3 border border-rule text-muted">
        <span className="w-2 h-2" style={{ background: C.faint }} aria-hidden="true" />
        {t('Every setting is at its default from project_parameters.json.')}
      </div>
    )
  const go = (k: string) => {
    if (STRATEGY_KEYS.has(k)) nav(`/t/${id}/pricing/strategy`)
    else document.getElementById('set-' + k)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  return (
    <section aria-label={t('What changed from defaults')} className="flex flex-col border border-accent">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className="m-0 text-[15px] font-semibold">{t('What changed from defaults')}</h2>
        <span className="text-[13px] text-muted">{t('Effect on the offer, against the default')}</span>
      </div>
      {changed.map((k) => {
        const who = changedByOf(s, k)
        return (
          <div key={k} className="grid grid-cols-[minmax(0,1.3fr)_minmax(150px,1fr)_150px_minmax(0,0.8fr)_108px] gap-x-3 items-center min-h-10 pl-4 pr-3 border-t border-rowrule text-[13.5px]">
            <button type="button" onClick={() => go(k)} className="p-0 border-0 bg-transparent text-left text-ink hover:text-accent truncate">
              {settingLabel(k, ctx)}
              {STRATEGY_KEYS.has(k) && <span className="text-muted"> · {t('Strategy')}</span>}
            </button>
            <span className="font-mono whitespace-nowrap">
              <span className="text-muted">{settingValue(k, flatGet(D, k), t)}</span> → <span style={{ color: C.accent }}>{settingValue(k, flatGet(s, k), t)}</span>
            </span>
            <span className="text-right whitespace-nowrap" style={{ color: C.accent }}>
              <EffectText e={effectOf(k, ctx)} ctx={ctx} />
            </span>
            <span className="text-muted truncate">{who ? `${t(who.by)} · ${who.at ? fmtShortDate(who.at, lang) : t('today')}` : ''}</span>
            <span className="text-right">
              <Button size="xs" className="min-h-[28px] px-2" onClick={() => ctx.resetKeys([k])} aria-label={t('Reset {name} to default', { name: settingLabel(k, ctx) })}>
                {t('Reset')}
              </Button>
            </span>
          </div>
        )
      })}
    </section>
  )
}

/** Sticky: cost baseline and offer price, against the defaults, always in view while settings change. */
function PriceSummary({ ctx }: { ctx: PricingCtx }) {
  const { t, tot, shown, s, busy, server } = ctx
  const dt = server.default_totals
  const dShown = dt ? sortScenarios(dt.scenarios).find((x) => x.name === shown.name) : undefined
  const diff = (now: number, was: number | undefined) => {
    if (was === undefined) return null
    const d = now - was
    if (Math.abs(d) < 0.5) return <span className="text-faint">{t('same as with defaults')}</span>
    return (
      <span style={{ color: C.accent }}>
        {t('{d} against defaults (CHF {was})', { d: (d > 0 ? '+ CHF ' : '− CHF ') + fmt0(Math.abs(d)), was: fmt0(was) })}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-3 px-[18px] py-4 border border-ink" aria-live="polite">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] text-muted">{t('Cost baseline (before margin)')}</span>
        <span className={cx('font-mono text-[22px] leading-[1.2] font-medium', busy && 'cf-pending')}>CHF {fmt0(tot.cost)}</span>
        <span className="text-[13px]">{diff(tot.cost, dt?.cost)}</span>
      </div>
      <div className="flex flex-col gap-0.5 pt-3 border-t border-rowrule">
        <span className="text-[13px] text-muted">
          {s.chosen ? t('Offer price') : t('Offer price · not chosen yet, showing {name}', { name: t(shown.name) })} · {t('{m} margin', { m: shown.margin_pct.toFixed(1) + '%' })}
        </span>
        <span className={cx('font-mono text-[30px] leading-[1.15] font-medium', busy && 'cf-pending')}>CHF {fmt0(shown.bid)}</span>
        <span className="text-[13px]">{diff(shown.bid, dShown?.bid)}</span>
        <span className="text-[13px] text-muted">
          {t('{w} win chance', { w: Math.round(shown.win * 100) + '%' })} · {t('CHF {p} profit if won', { p: fmt0(shown.profit) })}
        </span>
      </div>
    </div>
  )
}

function Buildup({ ctx }: { ctx: PricingCtx }) {
  const { tot, s, shown, t, busy } = ctx
  const rows: { label: string; val: string; strong?: boolean; rule: string }[] = [
    { label: tot.lines ? t('Direct cost, {n} priced lines', { n: tot.lines }) : t('Direct cost'), val: fmt2(tot.direct), rule: 'border-rowrule' },
  ]
  if (tot.project_costs) rows.push({ label: t('+ Project costs switched on'), val: fmt2(tot.project_costs), rule: 'border-rowrule' })
  if (tot.small_material) rows.push({ label: t('+ Small material {p}%', { p: s.small_material_pct.toFixed(1) }), val: fmt2(tot.small_material), rule: 'border-rowrule' })
  if (tot.supplier_contingency)
    rows.push({ label: t('+ Supplier package contingency {p}%', { p: s.supplier_contingency_pct.toFixed(1) }), val: fmt2(tot.supplier_contingency), rule: 'border-rowrule' })
  rows.push({ label: t('+ Transport and equipment {p}%', { p: s.transport_pct.toFixed(1) }), val: fmt2(tot.transport), rule: 'border-rowrule' })
  rows.push({ label: t('+ Overhead {p}%', { p: s.overhead_pct.toFixed(1) }), val: fmt2(tot.overhead), rule: 'border-ink' })
  rows.push({ label: t('Cost'), val: fmt2(tot.cost), strong: true, rule: 'border-rowrule' })
  rows.push({ label: t('+ {name} margin {m}%, rounded up to 1’000', { name: t(shown.name), m: shown.margin_pct.toFixed(1) }), val: fmt2(shown.bid - tot.cost), rule: 'border-ink' })
  rows.push({ label: t('Offer price'), val: fmt0(shown.bid), strong: true, rule: 'border-transparent' })
  return (
    <div className="flex flex-col">
      <h2 className="m-0 mb-1 text-[15px] font-semibold">{t('How the cost adds up')}</h2>
      {rows.map((r) => (
        <div key={r.label} className={cx('flex justify-between gap-3 py-1 border-b text-[13.5px]', r.rule, r.strong && 'font-semibold')}>
          <span>{r.label}</span>
          <span className={cx('font-mono', busy && 'cf-pending')}>{r.val}</span>
        </div>
      ))}
    </div>
  )
}
