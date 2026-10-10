// N07 Pricing: your read (3 calls), project costs, more settings, offer price, pick a price,
// cost build-up. Every control PUTs to the server (debounced); the UI updates optimistically
// from the last server totals and settles on the server's recomputed numbers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { usePricing, usePutPricing, useResetPricing, useTender } from '../api/hooks'
import type { AwardCriterion, PricingPut, PricingResponse, PricingSettings, Scenario, Totals } from '../api/types'
import { Button, ErrorBox, IconChevron, Loading, SegmentedControl, Stepper, Toggle } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt0, fmt2, fmtShortDate } from '../lib/format'
import { PageViewer } from '../components/PdfCrop'
import { C } from '../lib/lines'
import { APPETITE, COMPETITION, SENSITIVITY, bestScenario, previewScenario, projectCostItems, sortScenarios, standardMargin, winWords } from '../lib/pricing'

type Draft = PricingPut

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
  const std = standardMargin(s)
  const ref = cost / (1 - std / 100)
  const order = ['Aggressive', 'Target', 'Standard', 'Conservative'].filter((n) => s.margins[n] !== undefined)
  const extra = Object.keys(s.margins).filter((n) => !order.includes(n))
  const scenarios: Scenario[] = [...order, ...extra].map((name) => {
    const m = s.margins[name]
    const bid = Math.ceil(cost / (1 - m / 100) / 1000) * 1000
    const rel = (bid / ref - 1) * 100
    const p = Math.min(0.95, Math.max(0.05, s.ref_win + s.appetite + s.competition - s.sensitivity * rel))
    return { name, margin_pct: m, bid, win: p, profit: bid - cost, expected: p * (bid - cost) }
  })
  const best = bestScenario(scenarios)
  scenarios.forEach((x) => (x.best = x === best))
  return { ...tot, project_costs: pc, transport, overhead, cost, standard_price: Math.ceil(ref / 1000) * 1000, scenarios }
}

const pts = (v: number) => Math.round(Math.abs(v) * 100)

/** "Price is worth 60 of 100 award points (p. 9). ..." built by code from the award criterion, with the page. */
function AwardNote({ id, crit, pageCount }: { id: string; crit: AwardCriterion; pageCount?: number }) {
  const t = useT()
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const text =
    (lang === 'de' ? crit.summary_de : crit.summary_en) ?? t('Price is worth {p} of 100 award points (p. {page}).', { p: crit.points, page: crit.page })
  return (
    <>
      {' ' + text + ' '}
      <button type="button" onClick={() => setOpen(true)} className="border-0 bg-transparent p-0 min-h-0 text-accent underline underline-offset-2">
        {t('Show on page')}
      </button>
      <PageViewer
        open={open}
        onClose={() => setOpen(false)}
        tenderId={id}
        pageCount={pageCount}
        source={{ page: crit.page, page_size: [595, 842], block_bbox: null, lines: [] }}
        fallback={crit.rule_de ? <blockquote className="m-0 text-[13.5px] leading-[1.55] bg-hl px-1">«{crit.rule_de}»</blockquote> : null}
      />
    </>
  )
}

export function Pricing() {
  const { id = '' } = useParams()
  const t = useT()
  const nav = useNavigate()
  const { data: server, isLoading, error } = usePricing(id)
  const { data: tender } = useTender(id)
  const put = usePutPricing(id)
  const reset = useResetPricing(id)
  const [draft, setDraft] = useState<Draft>({})
  const pending = useRef<Draft>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [more, setMore] = useState(false)

  const flush = useCallback(async () => {
    const body = pending.current
    pending.current = {}
    if (!Object.keys(body).length) return
    try {
      await put.mutateAsync(body)
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
  const tot = useMemo(() => (server && s ? localTotals(server, s) : null), [server, s])
  const busy = put.isPending || Object.keys(draft).length > 0

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !server || !s || !tot) return <ErrorBox error={error} label={t('Could not load pricing.')} />

  const D = server.defaults
  const scen = sortScenarios(tot.scenarios)
  const best = bestScenario(scen)
  const chosenName = s.chosen
  const shown = previewScenario(scen, chosenName)!
  const pcItems = projectCostItems(tot, s, t)
  const pcOn = pcItems.filter((i) => i.on)
  const pcAll = pcItems.reduce((a, i) => a + i.amount, 0)
  const pcSum = pcOn.reduce((a, i) => a + i.amount, 0)
  const changed = server.changed_count
  const price = tender?.award_criteria?.find((a) => /preis|price/i.test(a.label))

  const choose = (name: string) => change({ chosen: name }, 0)
  const useAndContinue = async () => {
    if (!s.chosen && shown) change({ chosen: shown.name }, 0)
    await new Promise((r) => setTimeout(r, 30))
    await flush()
    nav(`/t/${id}/export`)
  }

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 border-b border-rule">
        <span className="text-muted">{t('Your choices here apply to this tender only.')}</span>
        <span className="flex-auto" />
        <span className="text-[13px] text-muted">{changed ? t('{n} changed from defaults', { n: changed }) : t('All values are defaults')}</span>
        <Button size="xs" className="min-h-[34px]" onClick={() => reset.mutate()} disabled={!changed || reset.isPending}>
          {t('Reset to defaults')}
        </Button>
      </div>

      <main className="flex-auto flex flex-wrap items-start">
        <section aria-label={t('Your read on this tender')} className="flex-[1_1_520px] max-w-[680px] min-w-0 p-6 flex flex-col gap-6 border-r border-rule">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[20px] font-semibold">{t('Your read on this tender')}</h1>
            <p className="m-0 text-muted">
              {t('Nobody knows the competitors before the award, so these three answers are your call. Each one moves the win chance on the right.')}
            </p>
          </div>

          <ReadGroup
            t={t}
            title={t('How strong is the competition?')}
            notePh={t('e.g. heard 4 firms took the documents')}
            k="competition"
            value={s.competition}
            def={D.competition}
            opts={COMPETITION.map((o) => ({ value: o.value, label: t(o.label), hint: o.value === 0 ? t('no change') : t(o.value > 0 ? '+{n} points win chance' : '−{n} points win chance', { n: pts(o.value) }) }))}
            note={s.notes.competition ?? ''}
            changedBy={s.changed_by?.competition}
            onPick={(v) => change({ competition: v }, 0)}
            onNote={(v) => change({ notes: { competition: v } }, 0)}
          />
          <ReadGroup
            t={t}
            title={t('How much do we want this job?')}
            notePh={t('e.g. school references matter for next year')}
            k="appetite"
            value={s.appetite}
            def={D.appetite}
            opts={APPETITE.map((o) => ({ value: o.value, label: t(o.label), hint: o.value === 0 ? t('no change') : t(o.value > 0 ? '+{n} points win chance' : '−{n} points win chance', { n: pts(o.value) }) }))}
            note={s.notes.appetite ?? ''}
            changedBy={s.changed_by?.appetite}
            onPick={(v) => change({ appetite: v }, 0)}
            onNote={(v) => change({ notes: { appetite: v } }, 0)}
          />
          <ReadGroup
            t={t}
            title={t('How price sensitive is this client?')}
            notePh={t('e.g. this client awards mostly on price')}
            k="sensitivity"
            value={s.sensitivity}
            def={D.sensitivity}
            opts={SENSITIVITY.map((o) => ({ value: o.value, label: t(o.label), hint: t('−{n} points per 1% above standard', { n: pts(o.value) }) }))}
            note={s.notes.sensitivity ?? ''}
            changedBy={s.changed_by?.sensitivity}
            onPick={(v) => change({ sensitivity: v }, 0)}
            onNote={(v) => change({ notes: { sensitivity: v } }, 0)}
          />

          <section className={cx('flex flex-col gap-2 px-4 py-3.5 border', pcOn.length ? 'border-rule' : 'border-attn')}>
            <div className="flex flex-wrap justify-between items-baseline gap-2">
              <h2 className="m-0 text-[15px] font-semibold">{t('Project costs')}</h2>
              <span className={cx('text-[13px] font-medium', pcOn.length ? 'text-ink' : 'text-attn')}>
                {pcOn.length ? t('CHF {a} in the price', { a: fmt0(pcSum) }) : t('Not in the price yet · CHF {a} if all on', { a: fmt0(pcAll) })}
              </span>
            </div>
            <span className="text-[13px] text-muted">
              {tot.lines ? t('These are not in the {n} lines. Switch on what this offer has to carry.', { n: tot.lines }) : t('These are not in the lines. Switch on what this offer has to carry.')}
            </span>
            {pcItems.map((c) => (
              <Toggle key={c.key} checked={c.on} onChange={(v) => change({ project_costs: { [c.key]: v } }, 0)} className="grid! grid-cols-[20px_minmax(0,1fr)_120px] border-b border-rowrule">
                <span>{c.label}</span>
                <span className="font-mono text-right">{fmt0(c.amount)}</span>
              </Toggle>
            ))}
          </section>

          <div className="flex flex-col gap-3.5">
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              className="flex items-center gap-2.5 min-h-10 p-0 border-0 bg-transparent font-semibold text-[15px] text-ink text-left"
            >
              <IconChevron open={more} />
              {t('More settings')} <span className="font-normal text-muted text-[13px]">{t('margins, overhead, allowances, site factors')}</span>
            </button>
            {more && <MoreSettings s={s} D={D} change={change} t={t} busy={busy} />}
          </div>
        </section>

        <section aria-label={t('Offer price')} className="flex-[1_1_520px] min-w-0 p-6 flex flex-col gap-6">
          <div className="flex flex-col gap-1.5 px-[18px] py-4 border border-ink" aria-live="polite">
            <span className="text-[13px] text-muted">{chosenName ? t('Offer price') : t('Offer price · not chosen yet, showing {name}', { name: t(shown.name) })}</span>
            <span className={cx('font-mono text-[32px] leading-[1.15] font-medium', busy && 'cf-pending')}>CHF {fmt0(shown.bid)}</span>
            <span>
              {t(shown.name)} · {t('{m} margin', { m: shown.margin_pct.toFixed(1) + '%' })} ·{' '}
              <span className="font-semibold">{t('{w} win chance', { w: Math.round(shown.win * 100) + '%' })}</span> ·{' '}
              {t('CHF {p} profit if won', { p: fmt0(shown.profit) })}
            </span>
            <span className="text-[13px] text-muted">{winWords(s, shown, tot, t)}</span>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="m-0 text-[15px] font-semibold">{t('Pick a price')}</h2>
            <div className="overflow-x-auto">
              <div className="min-w-[580px]" role="radiogroup" aria-label={t('Pick a price')}>
                <div className="grid grid-cols-[minmax(0,1.3fr)_56px_88px_112px_88px_96px] gap-x-2.5 py-2 border-b border-ink text-[13px] text-muted font-medium">
                  <span className="pl-2.5">{t('Option')}</span>
                  <span className="text-right">{t('Margin')}</span>
                  <span className="text-right">{t('Offer price')}</span>
                  <span className="text-right">{t('Win chance')}</span>
                  <span className="text-right">{t('Profit if won')}</span>
                  <span className="text-right">{t('Expected profit')}</span>
                </div>
                {scen.map((o) => {
                  const on = o.name === chosenName
                  const tags = [o === best ? t('best expected profit') : null, on ? t('your offer') : null].filter(Boolean)
                  return (
                    <button
                      key={o.name}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => choose(o.name)}
                      className={cx(
                        'grid grid-cols-[minmax(0,1.3fr)_56px_88px_112px_88px_96px] gap-x-2.5 items-center w-full min-h-12 p-0 border-0 border-b border-rowrule text-left text-ink',
                        on ? 'row-selected' : 'bg-white hover:bg-panel',
                      )}
                    >
                      <span className={cx('pl-2.5', on && 'font-semibold')}>
                        {t(o.name)}
                        {tags.length > 0 && <span className="text-muted text-[12.5px] font-normal">{'  · ' + tags.join(' · ')}</span>}
                      </span>
                      <span className="text-right font-mono">{o.margin_pct.toFixed(1)}%</span>
                      <span className="text-right font-mono font-medium">{fmt0(o.bid)}</span>
                      <span className="flex items-center justify-end gap-2">
                        <span aria-hidden="true" className="w-14 h-1.5 bg-rowrule">
                          <span className="block h-1.5 bg-ink" style={{ width: Math.round(o.win * 100) + '%' }} />
                        </span>
                        <span className="font-mono min-w-[34px] text-right">{Math.round(o.win * 100)}%</span>
                      </span>
                      <span className="text-right font-mono">{fmt0(o.profit)}</span>
                      <span className="text-right font-mono">{fmt0(o.expected)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <span className="text-[13px] text-muted">
              {t('Expected profit = win chance × profit if won.')}
              {price && <AwardNote id={id} crit={price} pageCount={tender?.page_count} />}
            </span>
          </div>

          <Buildup tot={tot} s={s} shown={shown} t={t} busy={busy} />

          <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-rule">
            <span className="text-muted">{pcOn.length ? '' : t('Project costs are still off.')}</span>
            <span className="flex-auto" />
            <Button variant="primary" onClick={useAndContinue}>
              {t('Use CHF {p} and continue to export', { p: fmt0(shown.bid) })}
            </Button>
          </div>
        </section>
      </main>
    </div>
  )
}

function ReadGroup({
  t,
  title,
  notePh,
  k,
  value,
  def,
  opts,
  note,
  changedBy,
  onPick,
  onNote,
}: {
  t: T
  title: string
  notePh: string
  k: string
  value: number
  def: number
  opts: { value: number; label: string; hint: string }[]
  note: string
  changedBy?: { by: string; at: string }
  onPick: (v: number) => void
  onNote: (v: string) => void
}) {
  const lang = useLang()
  const changed = Math.abs(value - def) > 1e-9
  const known = opts.some((o) => Math.abs(o.value - value) < 1e-9)
  return (
    <fieldset className="m-0 p-0 pb-5 border-0 border-b border-rowrule flex flex-col gap-2.5">
      <legend className="p-0 mb-1 font-semibold text-[15px]">{title}</legend>
      <SegmentedControl label={title} value={known ? value : NaN} onChange={onPick} options={opts.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px]">
        <span className="flex items-center gap-1.5" style={{ color: changed ? C.accent : C.faint }}>
          <span className="w-2 h-2" style={{ background: changed ? C.accent : C.faint }} aria-hidden="true" />
          {changed
            ? t('Your call · {who} · {when}', { who: t(changedBy?.by ?? 'You'), when: changedBy?.at ? fmtShortDate(changedBy.at, lang) : t('today') })
            : t('Default')}
          {!known && ` (${value})`}
        </span>
        {changed && (
          <label className="flex-[1_1_260px] flex items-center gap-2">
            <span className="text-muted">{t('Why')}</span>
            <input
              type="text"
              key={note}
              name={k + '-note'}
              defaultValue={note}
              onBlur={(e) => e.currentTarget.value !== note && onNote(e.currentTarget.value)}
              placeholder={notePh}
              className="flex-auto min-w-0 min-h-8 px-2.5 border border-rule rounded-[2px] text-ink placeholder:text-faint"
            />
          </label>
        )}
      </div>
    </fieldset>
  )
}

function SourceTag({ changed, t }: { changed: boolean; t: T }) {
  return (
    <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: changed ? C.accent : C.faint }}>
      <span className="w-2 h-2" style={{ background: changed ? C.accent : C.faint }} aria-hidden="true" />
      {changed ? t('Your call') : t('Default')}
    </span>
  )
}

function MoreSettings({ s, D, change, t, busy }: { s: PricingSettings; D: PricingSettings; change: (d: Draft) => void; t: T; busy: boolean }) {
  const r = (x: number, step: number) => Math.round(x / step) * step
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
  const row = (key: string, label: string, val: number, def: number, step: number, lo: number, hi: number, fmt: (v: number) => string, set: (v: number) => Draft) => (
    <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto_120px] gap-3 items-center py-1.5 border-b border-rowrule">
      <span>{label}</span>
      <Stepper
        label={label}
        value={fmt(val)}
        pending={busy}
        onDec={() => change(set(clamp(Number(r(val - step, step).toFixed(4)), lo, hi)))}
        onInc={() => change(set(clamp(Number(r(val + step, step).toFixed(4)), lo, hi)))}
        decDisabled={val <= lo + 1e-9}
        incDisabled={val >= hi - 1e-9}
      />
      <SourceTag changed={Math.abs(val - def) > 1e-9} t={t} />
    </div>
  )
  const pct = (v: number) => v.toFixed(1) + '%'
  const mul = (v: number) => '× ' + v.toFixed(2)
  const marginKeys = ['Aggressive', 'Target', 'Standard', 'Conservative'].filter((k) => s.margins[k] !== undefined)
  const marginLabel: Record<string, string> = { Aggressive: 'Aggressive margin', Target: 'Target margin', Standard: 'Standard margin', Conservative: 'Conservative margin' }
  const factorKeys = Object.keys(s.factors)
  const factorLabel: Record<string, string> = {
    site_efficiency: 'Site efficiency (hours ÷)',
    school_logistics: 'School logistics',
    mounting_height_school: 'Mounting height, school',
    mounting_height_sports_hall: 'Mounting height, sports hall',
    timber_interface: 'Timber interface',
  }
  return (
    <div className="flex flex-col gap-6 pl-[22px]">
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-[14px] font-semibold">{t('Margins and overhead')}</h2>
        {marginKeys.map((k) => row('m-' + k, t(marginLabel[k]), s.margins[k], D.margins[k] ?? s.margins[k], 0.5, 0, 15, pct, (v) => ({ margins: { [k]: v } })))}
        {row('overhead', t('Overhead'), s.overhead_pct, D.overhead_pct, 0.5, 0, 20, pct, (v) => ({ overhead_pct: v }))}
        {row('transport', t('Transport and equipment'), s.transport_pct, D.transport_pct, 0.5, 0, 10, pct, (v) => ({ transport_pct: v }))}
        {row('refwin', t('Win chance at the standard price'), s.ref_win, D.ref_win, 0.05, 0.05, 0.95, (v) => Math.round(v * 100) + '%', (v) => ({ ref_win: v }))}
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="m-0 text-[14px] font-semibold">
          {t('Allowances and site factors')} <span className="font-normal text-muted">· {t('change one and all lines recalculate')}</span>
        </h2>
        {row('waste', t('Material waste'), s.material_waste_pct, D.material_waste_pct, 0.5, 0, 20, pct, (v) => ({ material_waste_pct: v }))}
        {row('small', t('Small material'), s.small_material_pct, D.small_material_pct, 0.5, 0, 20, pct, (v) => ({ small_material_pct: v }))}
        <Toggle checked={s.include_small_material} onChange={(v) => change({ include_small_material: v })} className="pl-1 text-[13px] text-muted">
          {t('Add small material to the price')}
        </Toggle>
        {row('cont', t('Supplier package contingency'), s.supplier_contingency_pct, D.supplier_contingency_pct, 0.5, 0, 20, pct, (v) => ({ supplier_contingency_pct: v }))}
        <Toggle checked={s.include_supplier_contingency} onChange={(v) => change({ include_supplier_contingency: v })} className="pl-1 text-[13px] text-muted">
          {t('Add the contingency on supplier packages')}
        </Toggle>
        {factorKeys.map((k) =>
          row('f-' + k, t(factorLabel[k] ?? k), s.factors[k], D.factors[k] ?? s.factors[k], k === 'site_efficiency' ? 0.01 : 0.01, 0.5, 2, k === 'site_efficiency' ? (v) => v.toFixed(2) : mul, (v) => ({ factors: { [k]: v } })),
        )}
        <span className="text-[13px] text-muted">
          {t('All start from the default parameters in')} <a href="/reference?tab=params">{t('Reference data')}</a>.
        </span>
      </div>
    </div>
  )
}

function Buildup({ tot, s, shown, t, busy }: { tot: Totals; s: PricingSettings; shown: Scenario; t: T; busy: boolean }) {
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
    <div className="flex flex-col max-w-[520px]">
      <h2 className="m-0 mb-2 text-[15px] font-semibold">{t('How the cost adds up')}</h2>
      {rows.map((r) => (
        <div key={r.label} className={cx('flex justify-between gap-3 py-1.5 border-b', r.rule, r.strong && 'font-semibold')}>
          <span>{r.label}</span>
          <span className={cx('font-mono', busy && 'cf-pending')}>{r.val}</span>
        </div>
      ))}
    </div>
  )
}
