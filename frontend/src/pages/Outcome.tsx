// N09 Outcome: what you submitted (snapshot), record the award, compare with your offer.
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useT } from '../i18n'
import { usePricing, usePutOutcome, useTender } from '../api/hooks'
import type { Outcome } from '../api/types'
import { Button, Field, LinkButton, Loading, TextInput } from '../components/ui'
import { fmt0, fmtDateTime, fmtShare, parseNum } from '../lib/format'
import { APPETITE, COMPETITION, SENSITIVITY, callLabel } from '../lib/pricing'

export function OutcomePage() {
  const { id = '' } = useParams()
  const t = useT()
  const { data: tender } = useTender(id)
  const { data: pr } = usePricing(id)
  const save = usePutOutcome(id)
  const [edits, setO] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const o: Record<string, string> = { ...fromOutcome(tender?.outcome), ...edits }
  if (!tender || !pr) return <Loading label={t('Loading')} />

  const sub = tender.submission
  const set = (k: string) => (e: { target: { value: string } }) => {
    setSaved(false)
    setO((x) => ({ ...x, [k]: e.target.value }))
  }
  const ours = sub?.offer_price ?? null
  const w = parseNum(o.winning_price ?? '')
  const b = parseNum(o.bidders ?? '')
  const hasW = w !== null && w > 0
  const hasB = b !== null && b > 0
  const comp = sub?.settings?.competition ?? pr.settings.competition
  const compLabel = t(callLabel(COMPETITION, comp) ?? String(comp))
  const insights: string[] = []
  if (sub) {
    if (!hasW && !hasB) insights.push(t('Fill in the winning price and number of bidders to compare.'))
    if (hasW && ours) {
      const d = (ours / w! - 1) * 100
      insights.push(
        t(d >= 0 ? 'Our offer was {p}% above the winning price (CHF {a}).' : 'Our offer was {p}% below the winning price (CHF {a}).', {
          p: Math.abs(d).toFixed(1),
          a: fmt0(Math.abs(ours - w!)),
        }),
      )
      if (d > 0) {
        const pts = Math.max(0, 60 * (1 - (ours / w! - 1) / 0.5))
        insights.push(t('If the winner was also the lowest offer, our price earned about {p} of 60 price points.', { p: pts.toFixed(1) }))
      }
    }
    if (hasB) insights.push(t('{n} bidders. Your competition call was {c} ({v}); it is saved next to this number for future tenders.', { n: b!, c: compLabel, v: comp.toFixed(2) }))
  }
  const submitOutcome = async () => {
    const body: Outcome = {
      notice_no: o.notice_no || undefined,
      award_date: o.award_date || undefined,
      result: o.result || 'lost',
      winner: o.winner || undefined,
      winning_price: hasW ? w : null,
      bidders: hasB ? b : null,
      rank: parseNum(o.rank ?? ''),
      reason: o.reason || undefined,
    }
    await save.mutateAsync(body)
    setSaved(true)
  }
  const defaults = pr.defaults
  const calls = sub?.settings
  const allDefault =
    !!calls && calls.competition === defaults.competition && calls.appetite === defaults.appetite && calls.sensitivity === defaults.sensitivity
  const notes = Object.values(sub?.notes ?? sub?.settings?.notes ?? {}).filter(Boolean)

  return (
    <main className="flex flex-wrap items-start">
      <section aria-label={t('What you submitted')} className="flex-[1_1_380px] max-w-[460px] min-w-0 p-6 flex flex-col gap-3 border-r border-rule">
        <h1 className="m-0 text-[20px] font-semibold">{t('What you submitted')}</h1>
        {sub ? (
          <>
            <span className="text-[13px] text-muted">
              {t('Snapshot saved when you marked the offer as submitted')} · {fmtDateTime(sub.at)}
            </span>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
              <span className="py-[7px] border-b border-rowrule">{t('Offer price')}</span>
              <span className="py-[7px] border-b border-rowrule font-mono font-semibold text-right">{fmt0(sub.offer_price)}</span>
              <span className="py-[7px] border-b border-rowrule">{t('Option · margin')}</span>
              <span className="py-[7px] border-b border-rowrule text-right">
                {t(sub.option)} · <span className="font-mono">{sub.margin_pct.toFixed(1)}%</span>
              </span>
              <span className="py-[7px] border-b border-rowrule">{t('Cost')}</span>
              <span className="py-[7px] border-b border-rowrule font-mono text-right">{fmt0(sub.cost)}</span>
              <span className="py-[7px] border-b border-rowrule">{t('Predicted win chance')}</span>
              <span className="py-[7px] border-b border-rowrule font-mono text-right">{fmtShare(sub.win)}</span>
            </div>
            {calls && (
              <>
                <h2 className="mt-3 mb-0 text-[15px] font-semibold">{t('Your calls at the time')}</h2>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
                  <span className="py-[7px] border-b border-rowrule">{t('Competition')}</span>
                  <span className="py-[7px] border-b border-rowrule text-right">
                    {t(callLabel(COMPETITION, calls.competition) ?? '')} <span className="font-mono">{signed(calls.competition)}</span>
                  </span>
                  <span className="py-[7px] border-b border-rowrule">{t('How much we want it')}</span>
                  <span className="py-[7px] border-b border-rowrule text-right">
                    {t(callLabel(APPETITE, calls.appetite) ?? '')} <span className="font-mono">{signed(calls.appetite)}</span>
                  </span>
                  <span className="py-[7px] border-b border-rowrule">{t('Client price sensitivity')}</span>
                  <span className="py-[7px] border-b border-rowrule text-right">
                    {t(callLabel(SENSITIVITY, calls.sensitivity) ?? '')} <span className="font-mono">{calls.sensitivity?.toFixed(2)}</span>
                  </span>
                </div>
                {/* defaults and "no notes" are silent; only own calls and notes get a line */}
                {(!allDefault || notes.length > 0) && (
                  <span className="text-[13px] text-muted">
                    {!allDefault && t('Some were your own calls.')} {notes.length > 0 && t('Notes: {n}', { n: notes.join(' · ') })}
                  </span>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <span className="text-muted">{t('Not submitted yet. The snapshot is saved when you mark the offer as submitted.')}</span>
            <div>
              <LinkButton to={`/t/${id}/export`}>{t('Go to Export')}</LinkButton>
            </div>
          </>
        )}
      </section>

      <section aria-label={t('Record the award')} className="flex-[1_1_560px] min-w-0 p-6 flex flex-col gap-[18px]">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[20px] font-semibold">{t('Record the award')}</h2>
          <p className="m-0 text-muted" title={t('Copy the figures from the award notice on simap (Zuschlag). Nobody knows the competitors before; this is where you learn them.')}>
            {t('From the award notice on simap (Zuschlag).')}
          </p>
        </div>
        <form
          className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submitOutcome()
          }}
        >
          <Field label={t('simap notice no.')}>
            <TextInput value={o.notice_no ?? ''} onChange={set('notice_no')} placeholder={t('Notice no.')} />
          </Field>
          <Field label={t('Award date')}>
            <TextInput value={o.award_date ?? ''} onChange={set('award_date')} placeholder="dd.mm.yyyy" />
          </Field>
          <Field label={t('Result')}>
            <select value={o.result ?? 'lost'} onChange={set('result')} className="min-h-9 px-2 border border-rule rounded-[2px] bg-white text-[14px] text-ink">
              <option value="lost">{t('Lost')}</option>
              <option value="won">{t('Won')}</option>
            </select>
          </Field>
          <Field label={t('Winner')}>
            <TextInput value={o.winner ?? ''} onChange={set('winner')} placeholder={t('Company')} />
          </Field>
          <Field label={t('Winning price (CHF)')}>
            <TextInput strong mono inputMode="decimal" value={o.winning_price ?? ''} onChange={set('winning_price')} placeholder={t('Amount')} />
          </Field>
          <Field label={t('Number of bidders')}>
            <TextInput strong mono inputMode="numeric" value={o.bidders ?? ''} onChange={set('bidders')} placeholder={t('From notice')} />
          </Field>
          <Field label={t('Our rank')}>
            <TextInput inputMode="numeric" value={o.rank ?? ''} onChange={set('rank')} placeholder={t('Rank')} />
          </Field>
          <Field label={t('Reason, if known')} className="sm:col-span-2">
            <TextInput value={o.reason ?? ''} onChange={set('reason')} placeholder={t('e.g. price, quality points, capacity')} />
          </Field>
        </form>

        {sub && (
          <div className="flex flex-col gap-2 px-4 py-3.5 bg-panel" aria-live="polite">
            <h3 className="m-0 text-[14px] font-semibold">{t('Compared with your offer')}</h3>
            {insights.map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={submitOutcome} disabled={save.isPending || !sub}>
            {t('Save outcome')}
          </Button>
          <LinkButton to="/">{t('Back to tenders')}</LinkButton>
          {saved && <span className="text-[13px]">{t('Saved.')}</span>}
          <Link to="/results" className="ml-auto text-[13px]" title={t('Saved outcomes are compared across all tenders in') + ' ' + t('Results history')}>
            {t('Results history')}
          </Link>
        </div>
      </section>
    </main>
  )
}

function signed(v?: number) {
  if (v === undefined || v === null) return ''
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2)
}

function fromOutcome(x: Outcome | null | undefined): Record<string, string> {
  if (!x) return {}
  return {
    notice_no: x.notice_no ?? '',
    award_date: x.award_date ?? '',
    result: x.result ?? 'lost',
    winner: x.winner ?? '',
    winning_price: x.winning_price != null ? String(x.winning_price) : '',
    bidders: x.bidders != null ? String(x.bidders) : '',
    rank: x.rank != null ? String(x.rank) : '',
    reason: x.reason ?? '',
  }
}
