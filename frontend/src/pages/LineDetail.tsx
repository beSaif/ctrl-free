// N04b Line detail: PDF crop, tender rule, editable price with sentences, supplier quote,
// Assist in place, Confirm (Enter) / Flag / Undo, Previous K / Next J through the queue.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { useInstructions, useLineLog, useMarkSent, usePatchPosition, usePosition, usePricing, useReference, useTender, useVerification } from '../api/hooks'
import type { Position, PositionPatch, QuoteGroup } from '../api/types'
import { Button, ErrorBox, IconBack, IconCheck, Kbd, LinkButton, Loading } from '../components/ui'
import { cx } from '../lib/cx'
import { PdfCrop } from '../components/PdfCrop'
import { FooterTotals } from '../components/FooterTotals'
import { useAssistCtx } from '../assist/context'
import { DropZone, FilledNote, ProposalCard, ReplyCrop } from '../assist/InlineAssist'
import { useLineProposal } from '../assist/hooks'
import { fmt2, fmtQty, fmtShortDate, fmtSigned, fmtUnit, parseNum, deUnit } from '../lib/format'
import {
  C,
  factorLabel,
  hoursSentence,
  canConfirm,
  isSupplier,
  labourSentence,
  lineStatus,
  materialSentence,
  matchView,
  productLabel,
  quotedPrice,
  roleLabel,
  wasChanged,
} from '../lib/lines'
import { groupParam, linesQuery, useCatalog, useLineFilter, useLineQueue } from './linesShared'
import { HoursSource, QtySource, RateSource, UnitPriceSource, WasteSource, type Trace } from './lineSources'
import { LineHistory } from './LineHistory'

const inEditable = (el: EventTarget | null) => {
  const e = el as HTMLElement | null
  return !!e && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || e.isContentEditable)
}

export function LineDetail() {
  const { id = '', lv = '' } = useParams()
  const t = useT()
  const lang = useLang()
  const nav = useNavigate()
  const ctx = useAssistCtx()
  const [filter, q, , groupBy] = useLineFilter()
  const { queue, positions, quotes } = useLineQueue(id, filter, q)
  const listP = positions.find((p) => p.lv_id === lv)
  const dq = usePosition(id, lv)
  const p: Position | undefined = dq.data ?? listP
  const { data: tender } = useTender(id)
  const { data: ins } = useInstructions(id)
  const patch = usePatchPosition(id)
  const cat = useCatalog()
  const lineLog = useLineLog(id, lv)
  const { data: refData } = useReference()
  const { data: pricingData } = usePricing(id)
  const trace: Trace = { tenderId: id, log: lineLog.data ?? [], ref: refData, pricing: pricingData, cat }

  // keep a frozen queue for this visit so confirming does not reshuffle Previous/Next
  // a line outside the current queue (e.g. a priced line opened from a link) steps through the tender in order
  const inQueue = queue.findIndex((x) => x.lv_id === lv)
  const docOrder = useMemo(() => positions.filter((x) => x.kind !== 'subtotal'), [positions])
  const navList = inQueue >= 0 ? queue : docOrder
  const qi = inQueue >= 0 ? inQueue : docOrder.findIndex((x) => x.lv_id === lv)
  const prev = qi > 0 ? navList[qi - 1] : null
  const next = qi >= 0 && qi < navList.length - 1 ? navList[qi + 1] : null
  const qs = inQueue >= 0 ? linesQuery(filter, q, groupParam(groupBy)) : linesQuery('all', '', groupParam(groupBy))
  const goTo = (x: Position | null) => x && nav(`/t/${id}/lines/${x.lv_id}${qs}`)

  useEffect(() => {
    ctx.setLine(p ?? null)
    return () => ctx.setLine(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p])

  const doPatch = (body: PositionPatch) => patch.mutateAsync({ lv, body })
  // fire-and-forget edits: a failed save is shown under the buttons (patch.error), not as an unhandled rejection
  const safePatch = (body: PositionPatch) => doPatch(body).catch(() => undefined)

  // one confirm at a time: a second Enter before the first save returns must not confirm twice or skip a line
  const confirming = useRef(false)
  const confirm = async () => {
    if (!p || confirming.current) return
    confirming.current = true
    try {
      const rest = queue.filter((x) => x.lv_id !== lv)
      const review = filter === 'review' && inQueue >= 0
      const nxt = review ? (queue[inQueue + 1] ?? rest[0] ?? null) : null
      await doPatch({ confirm: true })
      if (review) {
        if (nxt) nav(`/t/${id}/lines/${nxt.lv_id}${qs}`)
        else nav(`/t/${id}/lines${qs}`)
      }
    } catch {
      /* the error is shown under the buttons (patch.error) */
    } finally {
      confirming.current = false
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (ctx.barOpen || e.metaKey || e.ctrlKey || e.altKey || inEditable(e.target)) return
    if (document.querySelector('[role="dialog"]')) return
    // the URL already moved on (J pressed, next line not rendered yet): this handler's prev/next are stale
    if (!window.location.pathname.endsWith(`/lines/${lv}`)) return
    const tag = (e.target as HTMLElement | null)?.tagName
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault()
      goTo(next)
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault()
      goTo(prev)
    } else if (e.key === 'Enter' && !e.repeat && tag !== 'BUTTON' && tag !== 'A' && p && canConfirm(p) && !patch.isPending && !confirming.current) {
      e.preventDefault()
      void confirm()
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const group: QuoteGroup | undefined = useMemo(() => {
    const d = dq.data as (Position & { quote_group?: QuoteGroup | null }) | undefined
    return quotes.find((g) => g.lv_ids.includes(lv)) ?? d?.quote_group ?? undefined
  }, [quotes, lv, dq.data])
  const rules = (ins?.instructions ?? []).filter((i) => i.applies_to?.includes(lv))
  const lp = useLineProposal(id, lv)
  const { data: verif } = useVerification(id)
  const vrow = verif?.rows.find((r) => r.our_lv_id === lv)

  if (!p) return dq.isLoading ? <Loading label={t('Loading')} /> : <ErrorBox error={dq.error} label={t('This line was not found.')} />

  const st = lineStatus(p, t)
  const sup = isSupplier(p)
  const open = canConfirm(p)
  const quoted = quotedPrice(p)
  const posLabel = inQueue < 0 ? t('Line') : filter === 'review' ? t('To review') : filter === 'priced' ? t('Priced') : t('Line')
  const sysName = p.system.replace(/^\d+(\.\d+)*\s+/, '')
  const showProposal = lp && !lp.dismissed && lp.line.state !== 'filled' && sup && !p.confirmed
  const filledByAssist = p.supplier_quote?.by === 'Assist'
  const groupFilled = group ? group.lv_ids.filter((x) => positions.find((y) => y.lv_id === x)?.supplier_quote?.by === 'Assist').length : 0

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 border-b border-rule">
        <LinkButton to={`/t/${id}/lines${linesQuery(filter, q, { ...groupParam(groupBy), sel: lv })}`} size="sm" className="pl-2.5">
          <IconBack />
          {t('All lines')}
        </LinkButton>
        <span className="flex-auto" />
        <span className="text-[13px] text-muted">{qi >= 0 ? t('{label} {i} of {n}', { label: posLabel, i: qi + 1, n: navList.length }) : ''}</span>
        <Button size="sm" onClick={() => goTo(prev)} disabled={!prev}>
          {t('Previous')} <Kbd>K</Kbd>
        </Button>
        <Button size="sm" onClick={() => goTo(next)} disabled={!next}>
          {t('Next')} <Kbd>J</Kbd>
        </Button>
      </div>

      <main className="flex-auto flex justify-center px-6 pt-7 pb-24">
        <div className="w-full max-w-[1240px] flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] text-muted">
              {p.lv_id} · {t('p. {page}', { page: p.page })} · {sysName}
            </span>
            <h1 className="m-0 text-[26px] leading-[1.25] font-semibold">{p.title_de}</h1>
            {lang === 'en' && p.title_en && <span className="text-muted">{p.title_en}</span>}
            <span className="flex items-center gap-2" style={{ color: st.fg }}>
              <span className="w-2 h-2" style={{ background: st.marker }} aria-hidden="true" />
              {st.label}
              {p.status_reason && !p.confirmed && lang === 'en' && <span className="text-muted text-[13px]">· {p.status_reason}</span>}
            </span>
            {vrow && <VerifiedBadge row={vrow} current={p.pricing?.direct ?? null} />}
          </div>

          <div className="flex flex-wrap items-start gap-x-10 gap-y-7">
            <div className="flex-[1_1_480px] min-w-0 flex flex-col gap-6">
              {p.source ? (
                <div id="line-tender-crop">
                  <PdfCrop
                    tenderId={id}
                    source={p.source}
                    pageCount={tender?.page_count}
                    caption={t('The marked row is where the quantity {q} {u} was read.', { q: fmtQty(p.quantity), u: fmtUnit(p.unit) })}
                  />
                </div>
              ) : (
                <section className="flex flex-col gap-2">
                  <h2 className="m-0 text-[15px] font-semibold">{t('Tender PDF · p. {page}', { page: p.page })}</h2>
                  <pre className="m-0 p-4 border border-rule font-mono text-[12.5px] whitespace-pre-wrap">{p.text_de}</pre>
                </section>
              )}
              {lp && sup && (showProposal || filledByAssist) && <ReplyCrop proposal={lp.proposal} lv={lv} />}
              {rules.map((r) => (
                <section key={r.id} className="flex flex-col gap-2">
                  <h2 className="m-0 text-[15px] font-semibold">{t('Tender rule for this line')}</h2>
                  <div className="text-[13px] text-muted">
                    {r.type} · p. {r.page}
                    {r.section ? ` · ${r.section}` : ''}
                  </div>
                  <blockquote className="m-0 px-3 py-2.5 border border-rule text-[13.5px] leading-[1.55]">«{r.text_de}»</blockquote>
                  <Link to={`/t/${id}/instructions/${r.id}`} className="text-[13px]">
                    {t('Open in Instructions & norms')}
                  </Link>
                </section>
              ))}
            </div>

            <div className="flex-[1_1_440px] min-w-0 flex flex-col gap-6">
              <PriceSection key={'price-' + lv} p={p} cat={cat} tenderId={id} onPatch={safePatch} busy={patch.isPending} filledByAssist={filledByAssist} trace={trace} group={group} />

              {sup && (
                <SupplierSection
                  key={'supplier-' + lv}
                  tenderId={id}
                  p={p}
                  group={group}
                  positions={positions}
                  tenderName={tender?.name ?? ''}
                  lineHref={(x) => `/t/${id}/lines/${x}${qs}`}
                />
              )}

              {sup && showProposal && lp && <ProposalCard tenderId={id} p={p} proposal={lp.proposal} line={lp.line} groupTitle={group ? (lang === 'de' && group.title_de ? group.title_de : t(group.title)) : undefined} />}
              {sup && filledByAssist && <FilledNote tenderId={id} p={p} allFilled={groupFilled} />}
              {sup && !showProposal && quoted === null && !p.confirmed && <DropZone tenderId={id} lv={lv} />}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {open && (
                  <Button variant="primary" onClick={confirm} disabled={patch.isPending}>
                    {sup ? (quoted !== null ? t('Confirm quote') : t('Confirm with budget price')) : t('Confirm line')} <Kbd>Enter</Kbd>
                  </Button>
                )}
                {open && p.flagged && (
                  <Button onClick={() => safePatch({ flag: false })} disabled={patch.isPending}>
                    {t('Remove flag')}
                  </Button>
                )}
                {!open && !p.confirmed && !p.flagged && (
                  <>
                    <Button onClick={() => safePatch({ flag: true })} disabled={patch.isPending}>
                      {t('Flag for review')}
                    </Button>
                    <span className="text-[13px] text-muted">{t('Priced from the catalogue. Nothing to do unless something looks wrong.')}</span>
                  </>
                )}
                {p.confirmed && (
                  <>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="w-2 h-2 bg-ink" aria-hidden="true" />
                      {t('Confirmed by {who} · {when}', { who: t(p.confirmed.by === 'You' ? 'you' : p.confirmed.by), when: fmtShortDate(p.confirmed.at, lang) })}
                    </span>
                    <Button onClick={() => safePatch({ unconfirm: true })} disabled={patch.isPending}>
                      {t('Undo')}
                    </Button>
                  </>
                )}
              </div>
              {patch.error && (
                <span role="alert" className="text-attn">
                  {t('Could not save.')} {patch.error instanceof Error ? patch.error.message : ''}
                </span>
              )}
            </div>
          </div>

          <LineHistory key={'history-' + lv} tenderId={id} p={p} log={lineLog.data ?? []} loading={lineLog.isLoading} readAt={tender?.created_at} cat={cat} />
        </div>
      </main>
      <FooterTotals tenderId={id} />
    </div>
  )
}

// ---- price ---------------------------------------------------------------------------

function NumInput({
  id,
  value,
  onCommit,
  width,
  placeholder,
  dashed,
  label,
}: {
  id: string
  value: string
  onCommit: (v: string) => void
  width: number
  placeholder?: string
  dashed?: boolean
  label?: string
}) {
  const commit = (v: string) => {
    if (v.trim() !== value.trim()) onCommit(v)
  }
  return (
    <input
      key={value}
      id={id}
      type="text"
      inputMode="decimal"
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        const el = e.currentTarget
        if (e.key === 'Enter') {
          e.preventDefault()
          el.blur()
        }
        if (e.key === 'Escape') {
          el.value = value
          el.blur()
        }
      }}
      className={cx('min-h-9 px-2.5 border border-ink rounded-[2px] font-mono text-[14px] text-ink bg-white placeholder:text-faint', dashed && 'border-dashed')}
      style={{ width }}
    />
  )
}

function PriceSection({
  p,
  cat,
  tenderId,
  onPatch,
  busy,
  filledByAssist,
  trace,
  group,
}: {
  p: Position
  cat: ReturnType<typeof useCatalog>
  tenderId: string
  onPatch: (b: PositionPatch) => Promise<unknown>
  busy: boolean
  filledByAssist: boolean
  trace: Trace
  group?: QuoteGroup
}) {
  const t = useT()
  const pr = p.pricing
  const sup = isSupplier(p)
  const o = p.overrides ?? {}
  const m = matchView(p, t)
  const unit = fmtUnit(p.unit)
  const quoted = quotedPrice(p)
  const catalogue = p.product?.net_cost_chf ?? (o.product_id ? cat[o.product_id]?.net_cost_chf : p.match?.product_id ? cat[p.match.product_id]?.net_cost_chf : undefined)
  const calcHours = pr?.calculated?.hours ?? pr?.calculated_hours
  const calcDirect = pr?.calculated?.direct
  const changed = wasChanged(p) || (sup && quoted !== null && p.supplier_quote?.by !== 'Assist')
  const qtySet = o.quantity != null
  const hoursSet = o.hours != null
  const priceSet = !sup && o.unit_price != null
  const hourly = pr?.unit_price_source === 'labour'

  const commitQty = (s: string) => {
    const v = parseNum(s)
    if (s.trim() && v === null) return
    void onPatch({ quantity: v === null || v === p.quantity ? null : v })
  }
  const commitUnit = (s: string) => {
    const v = parseNum(s)
    if (s.trim() && v === null) return
    if (sup) void onPatch({ unit_price: v })
    else void onPatch({ unit_price: v === null || (catalogue !== undefined && Math.abs(v - catalogue) < 0.005) ? null : v })
  }
  const commitHours = (s: string) => {
    const v = parseNum(s)
    if (s.trim() && v === null) return
    void onPatch({ hours: v === null || (calcHours !== undefined && Math.abs(v - calcHours) < 0.005) ? null : v })
  }

  let unitNote: ReactNode
  let unitFg = C.muted
  if (sup) {
    if (quoted === null) {
      unitNote = t('Empty: budget price {b} is used', { b: fmt2(catalogue ?? pr?.net_unit_cost) })
      unitFg = C.attn
    } else if (filledByAssist) {
      unitNote = t('Filled by Assist from the reply')
      unitFg = C.ink
    } else {
      unitNote = t('Supplier quote, typed by you')
      unitFg = C.accent
    }
  } else if (priceSet) {
    unitNote = catalogue !== undefined ? t('Changed by you. Catalogue says {c}', { c: fmt2(catalogue) }) : t('Changed by you')
    unitFg = C.accent
  } else unitNote = pr?.unit_price_source === 'manual' ? t('Typed by you') : t('Catalogue price')

  const factorText = pr?.factors.length ? pr.factors.map((f) => `${f.op} ${f.value.toFixed(2)} ${factorLabel(f.key, t)}`).join(', ') : ''

  return (
    <section className="flex flex-col gap-3" aria-busy={busy}>
      <div className="flex flex-wrap justify-between items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{t('Price for this line')}</h2>
        {changed && (
          <Button variant="link" className="text-[13px]" onClick={() => onPatch({ reset: true })}>
            {t('Reset to calculated values')}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 items-center">
        <label htmlFor="f-qty" className="text-muted">
          {t('Quantity')}
        </label>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <NumInput id="f-qty" value={pr ? String(pr.quantity) : String(p.quantity ?? '')} onCommit={commitQty} width={110} />
          <span>{unit}</span>
          <QtySource
            p={p}
            trace={trace}
            color={qtySet ? C.accent : C.muted}
            label={qtySet ? t('Changed by you. Tender says {q}, p. {page}', { q: fmtQty(p.quantity), page: p.page }) : t('Read from p. {page}', { page: p.page })}
          />
        </span>

        <span className="text-muted">{t('Product')}</span>
        <span className="flex flex-col gap-0.5">
          <span>
            {hourly ? t('Hourly work, no product') : productLabel(p, cat)} · <Link to={`/t/${tenderId}/lines/${p.lv_id}/product${location.search}`}>{t('Change product')}</Link>
          </span>
          <span className="text-[13px]" style={{ color: hourly ? C.muted : m.fg }}>
            {hourly ? t('The tender asks for hours: priced as our own labour, not a supplier item') : m.line}
          </span>
          {p.variant_reason && (
            <span className="text-[13px] text-attn">
              {t('Variant')}: {p.variant_reason}
            </span>
          )}
        </span>

        {!hourly && (
        <>
        <label htmlFor="f-unit" className="text-muted">
          {sup ? t('Quoted unit price') : t('Unit price')}
        </label>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="text-muted">CHF</span>
          <NumInput
            id="f-unit"
            value={sup ? (quoted !== null ? quoted.toFixed(2) : '') : pr ? pr.net_unit_cost.toFixed(2) : ''}
            placeholder={sup ? fmt2(catalogue ?? pr?.net_unit_cost) : ''}
            onCommit={commitUnit}
            width={130}
            dashed={sup && filledByAssist}
          />
          <UnitPriceSource p={p} trace={trace} label={unitNote} color={unitFg} group={group} />
        </span>
        </>
        )}

        <label htmlFor="f-hrs" className="text-muted">
          {t('Hours')}
        </label>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <NumInput id="f-hrs" value={pr ? pr.hours.toFixed(2) : ''} onCommit={commitHours} width={110} />
          {pr && <RateSource p={p} trace={trace} hourly={hourly} label={t('h × CHF {rate} ({role})', { rate: pr.rate, role: roleLabel(pr.role, t) })} />}
          <HoursSource
            p={p}
            trace={trace}
            hourly={hourly}
            color={hoursSet ? C.accent : C.muted}
            label={
              hoursSet
                ? calcHours !== undefined
                  ? t('Changed by you. Install rule gives {h}', { h: fmt2(calcHours) })
                  : t('Changed by you')
                : hourly
                  ? t('From the tender (hourly work)')
                  : t('From the install rule')
            }
          />
        </span>
      </div>

      {pr ? (
        <div className="flex flex-col">
          <div className="flex justify-between gap-3 pt-1.5 border-t border-ink">
            <span>{hourly ? t('Material') : <WasteSource p={p} trace={trace} label={t('Material, incl. {w}% waste', { w: pr.waste_pct })} />}</span>
            <span className="flex-none font-mono">{fmt2(pr.material)}</span>
          </div>
          <span className="pb-1.5 border-b border-rowrule text-[12.5px] text-muted">
            {hourly ? t('Hourly work: no material') : materialSentence(pr, p.unit, t)}
            {(qtySet || priceSet) && (
              <span className="text-accent">
                {' · '}
                {qtySet && priceSet
                  ? t('quantity and unit price changed by you')
                  : qtySet
                    ? t('quantity changed by you (tender: {q})', { q: fmtQty(p.quantity) })
                    : t('unit price changed by you')}
              </span>
            )}
          </span>
          <div className="flex justify-between gap-3 pt-1.5">
            <span>{t('Labour')}</span>
            <span className="flex-none font-mono">{fmt2(pr.labour)}</span>
          </div>
          <span className="text-[12.5px] text-muted">
            {hourly && !hoursSet ? t('{h} h from the tender (hourly work)', { h: fmtQty(pr.quantity) }) : hoursSentence(pr, p.unit, t, hoursSet)}
            {hoursSet && calcHours !== undefined && <span className="text-accent"> · {t('changed by you (install rule: {h} h)', { h: fmt2(calcHours) })}</span>}
          </span>
          <span className="pb-1.5 border-b border-rowrule text-[12.5px] text-muted">{labourSentence(pr, t, hourly)}</span>
          <div className="flex justify-between gap-3 py-2 font-semibold text-[16px]">
            <span>{t('Line total')}</span>
            <span className="flex-none font-mono">CHF {fmt2(pr.direct)}</span>
          </div>
          <span className="text-[13px] text-muted">
            {changed && calcDirect !== undefined && Math.abs(calcDirect - pr.direct) >= 0.005 && (
              <>{t('Calculated total was {c} ({d}).', { c: fmt2(calcDirect), d: fmtSigned(pr.direct - calcDirect) })} </>
            )}
            {factorText && !hoursSet && (
              <>
                {t('Hours include the site factors from')} <Link to={`/t/${tenderId}/pricing/costs#site-factors`}>{t('Pricing')}</Link>: {factorText}.
              </>
            )}
          </span>
        </div>
      ) : (
        <span className="text-attn">{t('Not priced. {r}', { r: p.status_reason ?? '' })}</span>
      )}
    </section>
  )
}

// ---- supplier quote ------------------------------------------------------------------

function emailParts(g: QuoteGroup, positions: Position[], tenderName: string) {
  const subject = g.email?.subject ?? g.subject ?? `Preisanfrage ${g.title_de ?? g.title} · ${tenderName}`
  let body = g.email?.body ?? g.body
  if (!body) {
    const lines = g.lv_ids
      .map((id) => positions.find((p) => p.lv_id === id))
      .filter(Boolean)
      .map((p) => `${p!.lv_id} · Seite ${p!.page} · ${p!.title_de} · ${fmtQty(p!.quantity)} ${deUnit(p!.unit)}`)
    body = [
      'Guten Tag',
      `Für das Projekt ${tenderName} bitten wir Sie um ein Angebot für folgende Positionen:`,
      lines.join('\n'),
      ...(g.rule ? [`Anforderungen gemäss Ausschreibung (${g.rule.ref}):`, `«${g.rule.text_de}»`] : []),
      'Bitte nennen Sie uns Netto-Einheitspreis, Lieferzeit und Gültigkeit. Die Preise gelten als Festpreise bis Bauvollendung.',
      'Freundliche Grüsse\n[Your name], Equans',
    ].join('\n\n')
  }
  return { subject, body, to: g.email?.to ?? '' }
}

function EmailBody({ body }: { body: string }) {
  return (
    <div className="p-3 flex flex-col gap-2 leading-[1.6]">
      {body.split(/\n{2,}/).map((para, i) => {
        const s = para.trim()
        if (/^LV\d+/m.test(s) && s.split('\n').every((l) => /^LV\d+|^\S+ · Seite/.test(l)))
          return (
            <div key={i} className="font-mono text-[12.5px] flex flex-col">
              {s.split('\n').map((l, j) => (
                <span key={j}>{l}</span>
              ))}
            </div>
          )
        if (s.startsWith('«'))
          return (
            <blockquote key={i} className="m-0 px-3 py-2 border border-rowrule bg-panel text-[13.5px]">
              {s}
            </blockquote>
          )
        return (
          <span key={i} className="whitespace-pre-line">
            {s}
          </span>
        )
      })}
    </div>
  )
}

function SupplierSection({
  tenderId,
  p,
  group,
  positions,
  tenderName,
  lineHref,
}: {
  tenderId: string
  p: Position
  group?: QuoteGroup
  positions: Position[]
  tenderName: string
  lineHref: (lv: string) => string
}) {
  const t = useT()
  const lang = useLang()
  const mark = useMarkSent(tenderId)
  const [mailOpen, setMailOpen] = useState(false)
  const [to, setTo] = useState('')
  const [copied, setCopied] = useState(false)
  const quoted = quotedPrice(p)
  const budget = p.product?.net_cost_chf ?? p.pricing?.calculated?.net_unit_cost ?? p.pricing?.net_unit_cost ?? 0
  const unit = fmtUnit(p.unit)
  const sent = !!group?.sent
  const border = p.confirmed ? '#DEDEDB' : quoted !== null ? C.accent : C.attn
  const mail = group ? emailParts(group, positions, tenderName) : null
  const mailto = mail ? `mailto:${encodeURIComponent(to || mail.to)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}` : ''
  const copy = async () => {
    if (!mail) return
    try {
      await navigator.clipboard.writeText(`${mail.subject}\n\n${mail.body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <section className="flex flex-col gap-2.5 px-4 py-3.5 border" style={{ borderColor: border }}>
      <div className="flex flex-wrap justify-between items-baseline gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{t('Supplier quote')}</h2>
        {group && (
          <span className="text-[13px]" style={{ color: sent ? C.accent : C.attn }}>
            {sent ? t('Request sent · {who} · {when}', { who: t(group.sent_by ?? 'You'), when: fmtShortDate(group.sent_at, lang) }) : t('Request not sent')}
          </span>
        )}
      </div>
      <span>
        {quoted !== null
          ? t('Quote entered: CHF {q} per {u} instead of the budget {b}. Confirm to use it.', { q: fmt2(quoted), u: unit, b: fmt2(budget) })
          : t('The budget price of CHF {b} per {u} is in use. Type the quoted unit price above when the supplier answers.', { b: fmt2(budget), u: unit })}
      </span>
      {group && (
        <>
          <span className="text-[13px] text-muted">{t('One request covers the same product type across all areas ({g}):', { g: lang === 'de' && group.title_de ? group.title_de : t(group.title) })}</span>
          <GroupLines ids={group.lv_ids} current={p.lv_id} positions={positions} lineHref={lineHref} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMailOpen(!mailOpen)} aria-expanded={mailOpen}>
              {mailOpen ? t('Hide request email') : t('Show request email')}
            </Button>
            <Button size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ group: group.id, sent: !sent })}>
              {sent ? t('Mark as not sent') : t('Mark request as sent')}
            </Button>
          </div>
          {mailOpen && mail && (
            <div className="border border-rule flex flex-col">
              <label className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 items-center px-3 py-2 border-b border-rowrule">
                <span className="text-muted">{t('To')}</span>
                <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('Supplier email')} className="min-h-[30px] border-0 outline-none bg-transparent" />
              </label>
              <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 px-3 py-2 border-b border-rowrule">
                <span className="text-muted">{t('Subject')}</span>
                <span>{mail.subject}</span>
              </div>
              <EmailBody body={mail.body} />
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-rowrule">
                <Button size="xs" onClick={copy}>
                  {copied ? t('Copied') : t('Copy text')}
                </Button>
                <a href={mailto} className="inline-flex items-center min-h-8 px-2.5 text-[13px] border border-rule rounded-[2px] text-ink! no-underline hover:border-ink">
                  {t('Open in Outlook')}
                </a>
                <span className="text-[12.5px] text-muted">{t('Nothing is sent from here. Mark it as sent when it went out.')}</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The lines one supplier request covers: a plain list; nothing navigates unless "Open" is clicked. */
function GroupLines({ ids, current, positions, lineHref }: { ids: string[]; current: string; positions: Position[]; lineHref: (lv: string) => string }) {
  const t = useT()
  const status = (s?: Position) => {
    if (!s) return { label: '–', fg: C.faint }
    if (s.confirmed) return { label: quotedPrice(s) !== null ? t('Quote confirmed') : t('Confirmed on budget price'), fg: C.ink }
    if (quotedPrice(s) !== null) return { label: t('Quoted'), fg: C.accent }
    return { label: t('Budget price'), fg: C.attn }
  }
  return (
    <div className="max-h-[260px] overflow-y-auto border-t border-rowrule">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sr-only">
          <tr>
            <th>{t('Line')}</th>
            <th>{t('Page')}</th>
            <th>{t('Quantity')}</th>
            <th>{t('Quote')}</th>
            <th>{t('Open')}</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((x) => {
            const s = positions.find((y) => y.lv_id === x)
            const on = x === current
            const st = status(s)
            return (
              <tr key={x} className={cx(on && 'bg-sel')} aria-current={on ? 'true' : undefined}>
                <td className={cx('py-1 pl-2 pr-2 border-b border-rowrule font-mono text-[12.5px]', on && 'shadow-[inset_3px_0_0_#1F4FD8]')}>{x}</td>
                <td className="py-1 pr-2 border-b border-rowrule font-mono text-[12.5px] text-muted">{s ? t('p. {page}', { page: s.page }) : ''}</td>
                <td className="py-1 pr-2 border-b border-rowrule font-mono text-[12.5px] text-right whitespace-nowrap">{s ? `${fmtQty(s.quantity)} ${fmtUnit(s.unit)}` : ''}</td>
                <td className="py-1 pr-2 border-b border-rowrule">
                  <span className="inline-flex items-center gap-1.5" style={{ color: st.fg }}>
                    <span className="w-1.5 h-1.5" style={{ background: st.fg }} aria-hidden="true" />
                    {st.label}
                  </span>
                </td>
                <td className="py-1 pr-2 border-b border-rowrule text-right whitespace-nowrap">
                  {on ? (
                    <span className="text-muted">{t('this line')}</span>
                  ) : (
                    <Link to={lineHref(x)} aria-label={t('Open line {lv}', { lv: x })}>
                      {t('Open')}
                    </Link>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** "Equans verified example LV0001 · CHF 806.26 ✓": this line is one of the case's 22 worked examples. */
function VerifiedBadge({ row, current }: { row: { example_id: string; golden_direct: number; direct_ok: boolean }; current: number | null }) {
  const t = useT()
  const same = current !== null && Math.abs(current - row.golden_direct) < 0.005
  return (
    <span
      className="self-start inline-flex items-center gap-2 mt-0.5 px-2 py-[3px] border text-[12.5px]"
      style={{ borderColor: same ? C.ink : C.attn, color: same ? C.ink : C.attn }}
      title={t('One of the 22 example lines Equans priced by hand for this case')}
    >
      <span>{t('Equans verified example {id}', { id: row.example_id })}</span>
      <span className="font-mono">· CHF {fmt2(row.golden_direct)}</span>
      {same ? (
        <span className="inline-flex items-center gap-1">
          <IconCheck />
          <span className="sr-only">{t('matches')}</span>
        </span>
      ) : (
        <span>· {t('ours now {v}', { v: current === null ? '–' : fmt2(current) })}</span>
      )}
    </span>
  )
}
