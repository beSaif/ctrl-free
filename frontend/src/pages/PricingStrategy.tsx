// N07 Pricing, step 2 "what price do we offer": your read on the tender, win chance and expected
// profit against the offer price (same model as the server, computed here so it follows every click),
// a plain-language recommendation, and the options table.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import type { AwardCriterion, PricingSettings, Scenario } from '../api/types'
import { Button, SegmentedControl, Stepper } from '../components/ui'
import { PageViewer } from '../components/PdfCrop'
import { cx } from '../lib/cx'
import { fmt0, fmtShortDate } from '../lib/format'
import { C } from '../lib/lines'
import {
  APPETITE,
  COMPETITION,
  SENSITIVITY,
  bestScenario,
  changedByOf,
  competitionStep,
  priceCurve,
  projectCostItems,
  scenariosAt,
  winWords,
  type CurvePoint,
} from '../lib/pricing'
import type { PricingCtx } from './Pricing'

const pts = (v: number) => Math.round(Math.abs(v) * 100)
const pct = (v: number) => Math.round(v * 100) + '%'

export function StrategyStep({ ctx }: { ctx: PricingCtx }) {
  const { t, s, D, tot, scen, shown, change, id, tender } = ctx
  const nav = useNavigate()
  const price = tender?.award_criteria?.find((a) => /preis|price/i.test(a.label))
  const pcOn = projectCostItems(tot, s, t).some((i) => i.on)

  const choose = (name: string) => change({ chosen: name }, 0)
  const useAndContinue = async () => {
    if (!s.chosen && shown) change({ chosen: shown.name }, 0)
    await new Promise((r) => setTimeout(r, 30))
    await ctx.flush()
    nav(`/t/${id}/export`)
  }
  const step = 0.05
  const refChanged = Math.abs(s.ref_win - D.ref_win) > 1e-9

  return (
    <main className="flex-auto grid grid-cols-[minmax(420px,590px)_minmax(0,1fr)] max-[1100px]:grid-cols-1 items-start">
      <section aria-label={t('Your read on this tender')} className="min-w-0 px-6 pt-5 pb-8 flex flex-col gap-3.5 border-r border-rule">
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
          opts={COMPETITION.map((o) => ({ value: o.value, label: t(o.label), hint: o.value === 0 ? t('no change') : t(o.value > 0 ? '+{n} points' : '−{n} points', { n: pts(o.value) }) }))}
          note={s.notes.competition ?? ''}
          changedBy={changedByOf(s, 'competition')}
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
          opts={APPETITE.map((o) => ({ value: o.value, label: t(o.label), hint: o.value === 0 ? t('no change') : t(o.value > 0 ? '+{n} points' : '−{n} points', { n: pts(o.value) }) }))}
          note={s.notes.appetite ?? ''}
          changedBy={changedByOf(s, 'appetite')}
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
          opts={SENSITIVITY.map((o) => ({ value: o.value, label: t(o.label), hint: t('−{n} points per +1% price', { n: pts(o.value) }) }))}
          note={s.notes.sensitivity ?? ''}
          changedBy={changedByOf(s, 'sensitivity')}
          onPick={(v) => change({ sensitivity: v }, 0)}
          onNote={(v) => change({ notes: { sensitivity: v } }, 0)}
          extra={price && <AwardNote id={id} crit={price} pageCount={tender?.page_count} />}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" title={ctx.server.sources?.ref_win ? t('Default from {src}', { src: ctx.server.sources.ref_win }) : undefined}>
          <span className="flex-auto flex flex-col">
            <span className="font-semibold">{t('Win chance at the standard price')}</span>
            <span className="text-[12.5px]" style={{ color: refChanged ? C.accent : C.faint }}>
              {refChanged ? t('default {v}', { v: pct(D.ref_win) }) : t('Default')} · {t('where the three answers start')}
            </span>
          </span>
          <Stepper
            label={t('Win chance at the standard price')}
            value={pct(s.ref_win)}
            pending={ctx.busy}
            onDec={() => change({ ref_win: Math.max(0.05, Number((s.ref_win - step).toFixed(2))) })}
            onInc={() => change({ ref_win: Math.min(0.95, Number((s.ref_win + step).toFixed(2))) })}
            decDisabled={s.ref_win <= 0.05 + 1e-9}
            incDisabled={s.ref_win >= 0.95 - 1e-9}
          />
          {refChanged && (
            <Button size="xs" className="min-h-[30px] px-2" onClick={() => ctx.resetKeys(['ref_win'])}>
              {t('Reset')}
            </Button>
          )}
        </div>
        <Recommendation ctx={ctx} />
      </section>

      <section aria-label={t('Offer price')} className="min-w-0 px-6 pt-5 pb-8 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-[18px] py-3.5 border border-ink" aria-live="polite">
          <div className="flex-[1_1_360px] flex flex-col gap-0.5 min-w-0">
            <span className="text-[13px] text-muted">
              {s.chosen ? `${t('Offer price')} · ${t(shown.name)}` : t('Offer price · not chosen yet, showing {name}', { name: t(shown.name) })} · {t('{m} margin', { m: shown.margin_pct.toFixed(1) + '%' })}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-3">
              <span className={cx('font-mono text-[30px] leading-[1.15] font-medium', ctx.busy && 'cf-pending')}>CHF {fmt0(shown.bid)}</span>
              <span>
                <span className="font-semibold">{t('{w} win chance', { w: pct(shown.win) })}</span> · {t('CHF {p} profit if won', { p: fmt0(shown.profit) })}
              </span>
            </span>
            <span className="text-[13px] text-muted">{winWords(s, shown, tot, t)}</span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Button variant="primary" onClick={useAndContinue}>
              {t('Use CHF {p} and continue to export', { p: fmt0(shown.bid) })}
            </Button>
            {!pcOn && (
              <span className="text-[13px] text-attn">
                {t('Project costs are still off.')} <Link to={`/t/${id}/pricing/costs`}>{t('Costs')}</Link>
              </span>
            )}
          </div>
        </div>

        <WinChart ctx={ctx} onPick={choose} />

        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[15px] font-semibold">{t('Pick a price')}</h2>
          <div className="overflow-x-auto">
            <div className="min-w-[580px]" role="radiogroup" aria-label={t('Pick a price')}>
              <div className="grid grid-cols-[minmax(0,1.3fr)_56px_88px_112px_88px_112px] gap-x-2.5 py-1.5 border-b border-ink text-[13px] text-muted font-medium">
                <span className="pl-2.5">{t('Option')}</span>
                <span className="text-right">{t('Margin')}</span>
                <span className="text-right">{t('Offer price')}</span>
                <span className="text-right">{t('Win chance')}</span>
                <span className="text-right">{t('Profit if won')}</span>
                <span className="text-right">{t('Expected profit')}</span>
              </div>
              {scen.map((o) => {
                const on = o.name === s.chosen
                const tags = [o === ctx.best ? t('best expected profit') : null, on ? t('your offer') : null].filter(Boolean)
                return (
                  <button
                    key={o.name}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => choose(o.name)}
                    className={cx(
                      'grid grid-cols-[minmax(0,1.3fr)_56px_88px_112px_88px_112px] gap-x-2.5 items-center w-full min-h-10 p-0 border-0 border-b border-rowrule text-left text-ink',
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
                      <span className="font-mono min-w-[34px] text-right">{pct(o.win)}</span>
                    </span>
                    <span className="text-right font-mono">{fmt0(o.profit)}</span>
                    <span className="text-right font-mono">{fmt0(o.expected)}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <span className="text-[13px] text-muted">{t('Expected profit = win chance × profit if won. Margins are set under Costs.')}</span>
        </div>
      </section>
    </main>
  )
}

// ---------------------------------------------------------------- recommendation

function Recommendation({ ctx }: { ctx: PricingCtx }) {
  const { t, s, tot, scen } = ctx
  const best = ctx.best
  if (!best) return null
  const byBid = [...scen].sort((a, b) => a.bid - b.bid)
  const i = byBid.indexOf(best)
  const cheaper = byBid[i - 1]
  const dearer = byBid[i + 1]
  const chosen = scen.find((x) => x.name === s.chosen)
  const dPts = (a: Scenario, b: Scenario) => Math.abs(Math.round(a.win * 100) - Math.round(b.win * 100))

  const lines: string[] = [
    t('{name} maximises expected profit: CHF {e} ({w} win chance × CHF {p} if won).', { name: t(best.name), e: fmt0(best.expected), w: pct(best.win), p: fmt0(best.profit) }),
  ]
  if (cheaper)
    lines.push(
      t('{name} gains {n} points of win chance for CHF {x} less expected profit.', { name: t(cheaper.name), n: dPts(cheaper, best), x: fmt0(best.expected - cheaper.expected) }),
    )
  if (dearer)
    lines.push(
      t('{name} earns CHF {x} more if won, but loses {n} points of win chance.', { name: t(dearer.name), n: dPts(dearer, best), x: fmt0(dearer.profit - best.profit) }),
    )
  // where the continuous curve peaks, when that is outside the options (a margin worth adding under Costs)
  const ms = scen.map((x) => x.margin_pct)
  const curve = priceCurve(s, tot.cost, Math.min(0, Math.min(...ms) - 2), Math.max(...ms) + 3)
  const peak = curve.reduce((a, b) => (b.expected > a.expected ? b : a), curve[0])
  const peakBid = Math.ceil(peak.price / 1000) * 1000
  if (peakBid > byBid[byBid.length - 1].bid + 1000 || peakBid < byBid[0].bid - 1000)
    lines.push(
      t(peakBid > byBid[byBid.length - 1].bid ? 'Expected profit peaks above your options, at about CHF {p} ({m} margin).' : 'Expected profit peaks below your options, at about CHF {p} ({m} margin).', {
        p: fmt0(peakBid),
        m: peak.margin.toFixed(1) + '%',
      }),
    )
  if (chosen && chosen !== best && chosen !== cheaper && chosen !== dearer)
    lines.push(t('Your offer ({name}) gives up CHF {x} of expected profit against {best}.', { name: t(chosen.name), x: fmt0(best.expected - chosen.expected), best: t(best.name) }))

  // how the recommendation moves if the competition is one step stronger / lighter
  const what = (dir: -1 | 1) => {
    const st = competitionStep(s.competition, dir)
    if (!st) return null
    const alt = bestScenario(scenariosAt(tot.cost, { ...s, competition: st.value } as PricingSettings))
    if (!alt) return null
    const vars = { c: t(st.label), name: t(alt.name), w: pct(alt.win) }
    if (dir < 0) return alt.name === best.name ? t('Stronger competition ({c}): {name} stays best, {w} win chance.', vars) : t('Stronger competition ({c}): {name} becomes best, {w} win chance.', vars)
    return alt.name === best.name ? t('Lighter competition ({c}): {name} stays best, {w} win chance.', vars) : t('Lighter competition ({c}): {name} becomes best, {w} win chance.', vars)
  }
  const sens = [what(-1), what(1)].filter(Boolean) as string[]

  return (
    <div className="flex flex-col gap-1.5 pl-3.5 border-l-[3px] border-accent" aria-live="polite">
      <h2 className="m-0 text-[15px] font-semibold">{t('What the numbers say')}</h2>
      <p className="m-0 text-[13.5px]">{lines.join(' ')}</p>
      {sens.length > 0 && (
        <p className="m-0 text-[13px] text-muted">
          <span className="font-medium text-ink">{t('If your read is off:')}</span> {sens.join(' ')}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- chart

function useWidth<E extends HTMLElement>(fallback: number) {
  const ref = useRef<E>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => setW(Math.max(320, Math.floor(es[0].contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

const k = (v: number) => fmt0(Math.round(v / 1000)) + 'k'

/** Win chance (top) and expected profit (bottom) against the offer price: two panels, one shared price axis. */
function WinChart({ ctx, onPick }: { ctx: PricingCtx; onPick: (name: string) => void }) {
  const { t, s, tot, scen, shown, best } = ctx
  const [box, W] = useWidth<HTMLDivElement>(720)
  const [hover, setHover] = useState<CurvePoint | null>(null)

  const margins = scen.map((x) => x.margin_pct)
  const mLo = Math.min(0, Math.min(...margins) - 2)
  const mHi = Math.max(...margins) + 3
  const curve = useMemo(() => priceCurve(s, tot.cost, mLo, mHi), [s, tot.cost, mLo, mHi])
  const peak = curve.reduce((a, b) => (b.expected > a.expected ? b : a), curve[0])

  const L = 52
  const R = 16
  const LAB = 30 // option names above the plot
  const H1 = 84 // win chance panel
  const GAP = 18
  const H2 = 76 // expected profit panel
  const AX = 22
  const H = LAB + H1 + GAP + H2 + AX
  const x0 = curve[0].price
  const x1 = curve[curve.length - 1].price
  const X = (p: number) => L + ((p - x0) / (x1 - x0)) * (W - L - R)
  const top1 = LAB
  const Y1 = (w: number) => top1 + H1 - w * H1
  const eMax = Math.max(...curve.map((c) => c.expected), ...scen.map((x) => x.expected)) * 1.12 || 1
  const eMin = Math.min(0, ...curve.map((c) => c.expected))
  const top2 = LAB + H1 + GAP
  const Y2 = (e: number) => top2 + H2 - ((e - eMin) / (eMax - eMin)) * H2
  const path = (f: (c: CurvePoint) => number) => curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.price).toFixed(1)},${f(c).toFixed(1)}`).join('')

  // option labels: a second row when two would touch
  const sorted = [...scen].sort((a, b) => a.bid - b.bid)
  const rows: Record<string, number> = {}
  let lastX = -1e9
  let lastRow = 1
  sorted.forEach((o) => {
    const x = X(o.bid)
    const row = x - lastX < 78 ? 1 - lastRow : 1
    rows[o.name] = row
    lastX = x
    lastRow = row
  })
  const ticks = niceTicks(x0, x1, W < 560 ? 4 : 6)
  const eTicks = [0, niceStep(eMax / 2), niceStep(eMax / 2) * 2].filter((v) => v <= eMax)

  const onMove = (e: React.MouseEvent<SVGElement>) => {
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const px = x0 + ((e.clientX - svg.getBoundingClientRect().left - L) / (W - L - R)) * (x1 - x0)
    setHover(curve.reduce((a, b) => (Math.abs(b.price - px) < Math.abs(a.price - px) ? b : a), curve[0]))
  }
  const read = hover ?? { price: shown.bid, margin: shown.margin_pct, win: shown.win, expected: shown.expected }

  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[15px] font-semibold">{t('Win chance and expected profit by offer price')}</span>
        <span className="text-[13px] text-muted">{t('Click a point to pick that option')}</span>
      </figcaption>
      <div ref={box} className="w-full">
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={t('{name} has the best expected profit at CHF {p}. The curve peaks at about CHF {peak} ({m} margin).', {
            name: t(best?.name ?? shown.name),
            p: fmt0(best?.bid ?? shown.bid),
            peak: fmt0(Math.ceil(peak.price / 1000) * 1000),
            m: peak.margin.toFixed(1) + '%',
          })}
          className="block font-mono text-[11px]"
        >
          {/* panel frames and gridlines */}
          {[0, 0.5, 1].map((w) => (
            <g key={'g1' + w}>
              <line x1={L} x2={W - R} y1={Y1(w)} y2={Y1(w)} stroke="#EDEDEA" />
              <text x={L - 6} y={Y1(w) + 4} textAnchor="end" fill={C.muted}>
                {pct(w)}
              </text>
            </g>
          ))}
          {eTicks.map((v) => (
            <g key={'g2' + v}>
              <line x1={L} x2={W - R} y1={Y2(v)} y2={Y2(v)} stroke="#EDEDEA" />
              <text x={L - 6} y={Y2(v) + 4} textAnchor="end" fill={C.muted}>
                {v ? k(v) : '0'}
              </text>
            </g>
          ))}
          <text x={L + 6} y={top1 + H1 - 6} fill={C.ink} stroke="#fff" strokeWidth={3} paintOrder="stroke" className="font-sans text-[12px] font-medium">
            {t('Win chance')}
          </text>
          <text x={L + 6} y={top2 + 12} fill={C.ink} stroke="#fff" strokeWidth={3} paintOrder="stroke" className="font-sans text-[12px] font-medium">
            {t('Expected profit (CHF)')}
          </text>
          {ticks.map((p) => (
            <g key={'x' + p}>
              <line x1={X(p)} x2={X(p)} y1={top2 + H2} y2={top2 + H2 + 4} stroke={C.stone} />
              <text x={X(p)} y={top2 + H2 + 16} textAnchor="middle" fill={C.muted}>
                {k(p)}
              </text>
            </g>
          ))}
          <line x1={L} x2={W - R} y1={top2 + H2} y2={top2 + H2} stroke={C.stone} />

          {/* expected-profit peak */}
          <line x1={X(peak.price)} x2={X(peak.price)} y1={top2} y2={top2 + H2} stroke={C.stone} strokeDasharray="3 3" />
          <text x={X(peak.price) + (X(peak.price) > W - 150 ? -4 : 4)} y={top2 - 4} textAnchor={X(peak.price) > W - 150 ? 'end' : 'start'} fill={C.muted}>
            {t('peak {p}', { p: k(peak.price) })}
          </text>

          {/* chosen price across both panels */}
          <line x1={X(shown.bid)} x2={X(shown.bid)} y1={top1} y2={top2 + H2} stroke={C.accent} strokeWidth={1} />

          <path d={path((c) => Y1(c.win))} fill="none" stroke={C.ink} strokeWidth={2} />
          <path d={path((c) => Y2(c.expected))} fill="none" stroke={C.accent} strokeWidth={2} />

          {hover && <line x1={X(hover.price)} x2={X(hover.price)} y1={top1} y2={top2 + H2} stroke={C.faint} strokeDasharray="2 2" />}

          {/* hover layer under the points so they stay clickable */}
          <rect x={L} y={top1} width={W - L - R} height={top2 + H2 - top1} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          {scen.map((o) => {
            const on = o.name === shown.name
            const x = X(o.bid)
            return (
              <g key={o.name} onClick={() => onPick(o.name)} className="cursor-pointer">
                <title>{`${t(o.name)} · CHF ${fmt0(o.bid)} · ${pct(o.win)} · ${t('Expected profit')} CHF ${fmt0(o.expected)}`}</title>
                <text x={x} y={rows[o.name] ? 24 : 11} textAnchor="middle" fill={on ? C.ink : C.muted} className={cx('font-sans text-[11.5px]', on && 'font-semibold')}>
                  {t(o.name)}
                  {o === best ? ' ★' : ''}
                </text>
                <rect x={x - 12} y={top1} width={24} height={top2 + H2 - top1} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
                <circle cx={x} cy={Y1(o.win)} r={on ? 5.5 : 4.5} fill={on ? C.ink : '#fff'} stroke={C.ink} strokeWidth={2} />
                <circle cx={x} cy={Y2(o.expected)} r={on ? 5.5 : 4.5} fill={on ? C.accent : '#fff'} stroke={C.accent} strokeWidth={2} />
              </g>
            )
          })}
        </svg>
      </div>
      <span className="text-[13px] text-muted" aria-live="polite">
        {t('At CHF {p} ({m} margin): {w} win chance, CHF {e} expected profit.', {
          p: fmt0(hover ? Math.round(read.price) : read.price),
          m: read.margin.toFixed(1) + '%',
          w: pct(read.win),
          e: fmt0(read.expected),
        })}{' '}
        {!hover && t('Move over the chart to read any price.')}
      </span>
    </figure>
  )
}

function niceStep(v: number) {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

function niceTicks(a: number, b: number, n: number) {
  const st = niceStep((b - a) / n)
  const out: number[] = []
  for (let v = Math.ceil(a / st) * st; v <= b; v += st) out.push(v)
  return out
}

// ---------------------------------------------------------------- your read

/** "Price is worth 60 of 100 award points (p. 9). ..." built by code from the award criterion, with the page. */
function AwardNote({ id, crit, pageCount }: { id: string; crit: AwardCriterion; pageCount?: number }) {
  const t = useT()
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const text = (lang === 'de' ? crit.summary_de : crit.summary_en) ?? t('Price is worth {p} of 100 award points (p. {page}).', { p: crit.points, page: crit.page })
  return (
    <span className="text-[13px] text-muted">
      {text + ' '}
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
    </span>
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
  extra,
}: {
  t: T
  title: string
  notePh: string
  k: string
  value: number
  def: number
  opts: { value: number; label: string; hint: string }[]
  note: string
  changedBy?: { by: string; at: string } | null
  onPick: (v: number) => void
  onNote: (v: string) => void
  extra?: React.ReactNode
}) {
  const lang = useLang()
  const changed = Math.abs(value - def) > 1e-9
  const known = opts.some((o) => Math.abs(o.value - value) < 1e-9)
  const defLabel = opts.find((o) => Math.abs(o.value - def) < 1e-9)?.label
  return (
    <fieldset className="m-0 p-0 pb-3 border-0 border-b border-rowrule flex flex-col gap-2">
      <legend className="p-0 mb-1 font-semibold text-[15px]">{title}</legend>
      {/* one row of equal options, so the three questions read as a table */}
      <div className="[&>[role=radiogroup]]:grid [&>[role=radiogroup]]:grid-flow-col [&>[role=radiogroup]]:auto-cols-fr">
        <SegmentedControl label={title} value={known ? value : NaN} onChange={onPick} options={opts.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
      </div>
      {extra}
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px]">
        <span className="flex items-center gap-1.5" style={{ color: changed ? C.accent : C.faint }}>
          <span className="w-2 h-2" style={{ background: changed ? C.accent : C.faint }} aria-hidden="true" />
          {changed
            ? t('Your call · {who} · {when}', { who: t(changedBy?.by ?? 'You'), when: changedBy?.at ? fmtShortDate(changedBy.at, lang) : t('today') }) +
              (defLabel ? ' · ' + t('default {v}', { v: defLabel }) : '')
            : t('Default')}
          {!known && ` (${value})`}
        </span>
        {changed && (
          <label className="flex-[1_1_220px] flex items-center gap-2">
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
