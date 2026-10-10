// Assist in place (S01): a proposal next to the field it would fill, the supplier reply it read,
// a note on values it filled (with Undo), and the drop zone for a supplier's answer.
import { useState, type ReactNode } from 'react'
import { useLang, useT } from '../i18n'
import { useApplyQuotes, useAssist, useChooseOffer, useReadQuote, useUndo } from '../api/hooks'
import type { AssistProposal, GroupOffers, Position, QuoteProposal, QuoteReply, SupplierOffer } from '../api/types'
import { AssistMark, Button, Disclosure, IconCheck, Spinner } from '../components/ui'
import { Source, SrcRows } from '../components/Source'
import { cx } from '../lib/cx'
import { fmt2, fmtQty, fmtShortDate, fmtSigned } from '../lib/format'
import { useAssistCtx } from './context'

export function ProposalCard({
  tenderId,
  p,
  proposal,
  line,
  groupTitle,
}: {
  tenderId: string
  p: Position
  proposal: AssistProposal
  line: QuoteProposal & { state?: string }
  groupTitle?: string
}) {
  const t = useT()
  const ctx = useAssistCtx()
  const apply = useApplyQuotes(tenderId)
  const others = (proposal.lines ?? []).filter((l) => l.lv_id !== p.lv_id)
  const unfilled = (proposal.lines ?? []).filter((l) => l.state !== 'filled')
  const delta = line.delta ?? 0
  const unit = p.unit === 'pc' ? t('per piece') : t('per {u}', { u: p.unit ?? '' })
  return (
    <section className="flex flex-col gap-2.5 px-4 py-3.5 border border-dashed border-ink" aria-label={t('Assist proposal')}>
      <div className="flex items-center gap-2.5">
        <AssistMark />
        <h2 className="m-0 text-[15px] font-semibold">{t('Assist found a quote for this line')}</h2>
      </div>
      <span>
        {t('The supplier answered. The reply quotes')} <span className="font-mono font-medium">CHF {fmt2(line.unit_price)}</span> {unit}
        {line.budget != null && (
          <>
            , {t('budget was')} <span className="font-mono">{fmt2(line.budget)}</span>
          </>
        )}
        .{' '}
        {Math.abs(delta) >= 0.005 && (
          <>
            {delta < 0 ? t('The line total would drop by') : t('The line total would rise by')} <span className="font-mono">{fmt2(Math.abs(delta))}</span>.
          </>
        )}
      </span>
      <span className="text-[13px] text-muted">
        {t('Read from {src}.', { src: line.source })}
        {others.length > 0 && ' ' + t('The same reply covers {ids}.', { ids: others.map((o) => o.lv_id).join(t(' and ')) })}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={apply.isPending} onClick={() => apply.mutate({ lines: [line], proposalId: proposal.id })}>
          {t('Fill this line')}
        </Button>
        {unfilled.length > 1 && (
          <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate({ lines: unfilled, proposalId: proposal.id })}>
            {groupTitle
              ? t('Fill all {n} {group} lines', { n: unfilled.length, group: groupTitle.toLowerCase().replace(/s$/, '') })
              : t('Fill all {n} lines', { n: unfilled.length })}
          </Button>
        )}
        <Button size="sm" onClick={() => ctx.dismiss(`${proposal.id}:${p.lv_id}`)}>
          {t('Not this')}
        </Button>
      </div>
    </section>
  )
}

export function FilledNote({ tenderId, p, allFilled }: { tenderId: string; p: Position; allFilled?: number }) {
  const t = useT()
  const undo = useUndo(tenderId)
  const { data: tray } = useAssist(tenderId)
  const q = p.supplier_quote
  if (!q || q.by !== 'Assist') return null
  const logId = q.log_id ?? tray?.done.find((d) => d.lv_id === p.lv_id && d.undoable && d.log_id)?.log_id
  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border border-rule">
      <AssistMark />
      <span className="flex-[1_1_240px]">
        {allFilled && allFilled > 1
          ? t('Assist filled all {n} lines of this request from {src}. You can still change each value.', { n: allFilled, src: q.source.split(',')[0] })
          : t('Assist filled this price from {src}. You can still change it.', { src: q.source })}
      </span>
      {logId && (
        <Button size="sm" disabled={undo.isPending} onClick={() => undo.mutate(logId)}>
          {t('Undo')}
        </Button>
      )}
    </section>
  )
}

/** Drop one or several supplier replies (PDF, e-mail, pasted text). Each reply becomes its own offer.
 *  `compact`: the small "Another supplier answered?" row once a first quote or offer is in. */
export function DropZone({ tenderId, lv, compact }: { tenderId: string; lv: string; compact?: boolean }) {
  const t = useT()
  const read = useReadQuote(tenderId)
  const [over, setOver] = useState(false)
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState('')
  const [reading, setReading] = useState<string | null>(null)
  const [problems, setProblems] = useState<QuoteReply[]>([])
  const go = async (inputs: (File | string)[]) => {
    if (!inputs.length) return
    const one = inputs[0]
    setReading(inputs.length > 1 ? t('{n} replies', { n: inputs.length }) : typeof one === 'string' ? t('the pasted email') : one.name)
    setProblems([])
    try {
      const r = await read.mutateAsync({ input: inputs, lv })
      // done stays silent (the offers show up in place); only a reply that gave nothing is reported
      setProblems((r.replies ?? []).filter((x) => x.error || !x.count))
    } catch {
      /* shown below (read.error) */
    } finally {
      setReading(null)
      setPaste(false)
      setText('')
    }
  }
  const label = compact ? t('Another supplier answered?') : t('Got the supplier’s answer?')
  return (
    <section
      aria-label={label}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const fs = Array.from(e.dataTransfer.files)
        if (fs.length) void go(fs)
        else {
          const s = e.dataTransfer.getData('text/plain')
          if (s) void go([s])
        }
      }}
      className={cx(
        'flex flex-col gap-1 border border-dashed',
        compact ? 'px-3 py-2' : 'px-4 py-3.5',
        over ? 'border-accent bg-sel' : compact ? 'border-rule' : 'border-stone',
      )}
    >
      <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1.5', !compact && 'flex-col items-start gap-1')}>
        <span className={cx(compact ? 'text-[13.5px] text-muted' : 'font-medium')}>{label}</span>
        {!compact && (
          <span className="text-[13px] text-muted">
            {t('Drop the PDFs or emails here, from one or several suppliers. Assist reads the prices and asks before filling them in.')}
          </span>
        )}
        {reading ? (
          <span className={cx(!compact && 'pt-1.5')}>
            <Spinner label={t('Reading {f}…', { f: reading })} />
          </span>
        ) : (
          <div className={cx('flex flex-wrap gap-2', !compact && 'pt-1.5')}>
            <label className="inline-flex items-center min-h-8 px-2.5 text-[13px] border border-rule rounded-[2px] bg-panel cursor-pointer hover:border-ink focus-within:outline-2 focus-within:outline-accent">
              {t('Choose files')}
              <input
                type="file"
                multiple
                accept=".pdf,.eml,.msg,.txt,application/pdf,message/rfc822,text/plain"
                className="sr-only"
                onChange={(e) => {
                  const fs = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  void go(fs)
                }}
              />
            </label>
            <Button size="xs" onClick={() => setPaste((v) => !v)} aria-expanded={paste}>
              {t('Paste the email text')}
            </Button>
          </div>
        )}
      </div>
      {paste && !reading && (
        <div className="flex flex-col gap-2 pt-2">
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            {t('Email text')}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="p-2.5 border border-rule rounded-[2px] text-[14px] text-ink font-mono"
            />
          </label>
          <div>
            <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void go([text])}>
              {t('Read it')}
            </Button>
          </div>
        </div>
      )}
      {problems.map((x) => (
        <span key={x.source} role="alert" className="text-[13px] text-muted">
          {x.error ? t('{f}: Assist could not read it. {e}', { f: x.source, e: x.error }) : t('{f}: no prices for this tender’s lines.', { f: x.source })}
        </span>
      ))}
      {read.error && (
        <span role="alert" className="text-attn text-[13px]">
          {t('Assist could not read this file.')} {read.error instanceof Error ? read.error.message : ''}
        </span>
      )}
    </section>
  )
}

/** Several suppliers quoted this line: one row per offer, cheapest first, "Use this" per row. The request's
 *  per-supplier totals and the group actions are behind a Disclosure. Replaces the single ProposalCard. */
export function OfferComparison({
  tenderId,
  p,
  offers,
  groupId,
  groupOffers,
}: {
  tenderId: string
  p: Position
  offers: SupplierOffer[]
  groupId?: string
  groupOffers?: GroupOffers | null
}) {
  const t = useT()
  const lang = useLang()
  const choose = useChooseOffer(tenderId)
  const undo = useUndo(tenderId)
  const chosen = offers.find((o) => o.chosen)
  const q = p.supplier_quote
  // Undo right here only for a pick made in this card (the quote says which offer it came from)
  const undoId = chosen && q?.proposal_id === chosen.proposal_id ? q?.log_id : undefined
  const busy = choose.isPending || undo.isPending
  const offerRows = (o: SupplierOffer) => {
    const rows: [ReactNode, ReactNode][] = [[t('Read from'), o.source]]
    if (o.quoted_text) rows.push([t('Reply line'), <span key="q" className="font-mono text-[12.5px]">{o.quoted_text}</span>])
    if (o.received_at) rows.push([t('Received'), fmtShortDate(o.received_at, lang)])
    return rows
  }
  return (
    <section className={cx('flex flex-col gap-2.5 px-4 py-3.5 border', chosen ? 'border-rule' : 'border-dashed border-ink')} aria-label={t('Supplier offers')}>
      <div className="flex items-center gap-2.5">
        <AssistMark />
        <h2 className="m-0 text-[15px] font-semibold">{t('{n} suppliers quoted this line', { n: offers.length })}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="text-[12.5px] text-muted">
              <th className="text-left font-normal py-1 pr-2 border-b border-rowrule">{t('Supplier')}</th>
              <th className="text-right font-normal py-1 pr-2 border-b border-rowrule">{t('Unit price')}</th>
              <th className="text-right font-normal py-1 pr-2 border-b border-rowrule">{t('Line total')}</th>
              <th className="text-right font-normal py-1 pr-2 border-b border-rowrule">{t('vs budget')}</th>
              <th className="py-1 border-b border-rowrule">
                <span className="sr-only">{t('Use')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.proposal_id} className={cx(o.chosen && 'bg-sel')} aria-current={o.chosen ? 'true' : undefined}>
                <td className="py-1.5 pr-2 border-b border-rowrule">
                  <span className="inline-flex flex-wrap items-baseline gap-x-2">
                    <Source label={o.supplier} title={o.supplier} className="text-[13.5px] text-left">
                      <SrcRows rows={offerRows(o)} />
                      {o.notes.length > 0 && (
                        <ul className="m-0 pl-4 text-[13px]">
                          {o.notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </Source>
                    {o.best && offers.length > 1 && <span className="text-[12px] text-accent">{t('Lowest')}</span>}
                  </span>
                </td>
                <td className="py-1.5 pr-2 border-b border-rowrule text-right font-mono whitespace-nowrap">{fmt2(o.unit_price)}</td>
                <td className="py-1.5 pr-2 border-b border-rowrule text-right font-mono whitespace-nowrap">{fmt2(o.line_total)}</td>
                <td className="py-1.5 pr-2 border-b border-rowrule text-right font-mono whitespace-nowrap text-muted">
                  {o.delta_vs_budget != null ? fmtSigned(o.delta_vs_budget) : '–'}
                </td>
                <td className="py-1.5 border-b border-rowrule text-right whitespace-nowrap">
                  {o.chosen ? (
                    <span className="inline-flex items-center gap-1 text-[13px]">
                      <IconCheck />
                      {t('In use')}
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant={!chosen && o.best ? 'primary' : 'secondary'}
                      disabled={busy}
                      onClick={() => choose.mutate({ lv_id: p.lv_id, proposal_id: o.proposal_id })}
                    >
                      {t('Use this')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {undoId && (
        <div>
          <Button size="xs" variant="quiet" disabled={busy} onClick={() => undo.mutate(undoId)}>
            {t('Undo')}
          </Button>
        </div>
      )}
      {groupId && groupOffers && groupOffers.lines > 1 && (
        <GroupOfferActions tenderId={tenderId} groupId={groupId} g={groupOffers} busy={busy} />
      )}
      {choose.error && (
        <span role="alert" className="text-attn text-[13px]">
          {choose.error instanceof Error ? choose.error.message : String(choose.error)}
        </span>
      )}
    </section>
  )
}

/** Per supplier for the whole request: lines covered and their total; one supplier for all, or the cheapest each. */
function GroupOfferActions({ tenderId, groupId, g, busy }: { tenderId: string; groupId: string; g: GroupOffers; busy: boolean }) {
  const t = useT()
  const choose = useChooseOffer(tenderId)
  const cheapest = g.suppliers.find((s) => s.cheapest)
  const full = g.suppliers.filter((s) => s.covers_all).length
  return (
    <Disclosure
      label={<span className="text-[13.5px] font-normal">{t('All {n} lines of this request with offers', { n: g.lines })}</span>}
      summary={
        cheapest
          ? full > 1
            ? t('{s} is cheapest of those quoting all {n}', { s: cheapest.supplier, n: g.lines })
            : t('Only {s} quoted all {n}', { s: cheapest.supplier, n: g.lines })
          : undefined
      }
    >
      <div className="flex flex-col gap-2 pt-1.5">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {g.suppliers.map((s) => (
              <tr key={s.supplier}>
                <td className="py-1 pr-2 border-b border-rowrule">
                  {s.supplier}
                </td>
                <td className="py-1 pr-2 border-b border-rowrule text-muted whitespace-nowrap">
                  {s.covers_all ? t('all {n} lines', { n: g.lines }) : t('{k} of {n} lines', { k: s.lines, n: g.lines })}
                </td>
                <td className="py-1 pr-2 border-b border-rowrule text-right font-mono whitespace-nowrap">{fmt2(s.total)}</td>
                <td className="py-1 border-b border-rowrule text-right whitespace-nowrap">
                  {s.chosen === s.lines ? (
                    <span className="text-muted">{t('In use')}</span>
                  ) : (
                    <Button size="xs" disabled={busy || choose.isPending} onClick={() => choose.mutate({ group: groupId, supplier: s.supplier })}>
                      {t('Use {s} for all {n} lines', { s: s.supplier, n: s.lines })}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" disabled={busy || choose.isPending} onClick={() => choose.mutate({ group: groupId, cheapest: true })}>
            {t('Use the cheapest for each line')}
          </Button>
          <span className="text-[13px] text-muted font-mono">CHF {fmt2(g.cheapest_each_total)}</span>
        </div>
      </div>
    </Disclosure>
  )
}

/** The rows of the supplier reply that Assist read, with this line's row marked. */
export function ReplyCrop({ proposal, lv }: { proposal: AssistProposal; lv: string }) {
  const t = useT()
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-[15px] font-semibold">{t('Supplier’s reply · {f} · p. 1', { f: proposal.source ?? '' })}</h2>
      <div className="border border-stone bg-panel p-4">
        <div className="bg-white border border-rule px-[18px] py-4 flex flex-col font-mono text-[12.5px] leading-[1.8] overflow-x-auto">
          <div className="grid grid-cols-[52px_minmax(0,1fr)_56px_96px] gap-2.5 px-1 text-muted min-w-[420px]">
            <span>Pos.</span>
            <span>Bezeichnung</span>
            <span>Menge</span>
            <span className="text-right">Netto / Stk</span>
          </div>
          {(proposal.lines ?? []).map((l) => (
            <div
              key={l.lv_id}
              className="grid grid-cols-[52px_minmax(0,1fr)_56px_96px] gap-2.5 px-1 min-w-[420px]"
              style={{ background: l.lv_id === lv ? 'var(--color-hl)' : 'transparent' }}
            >
              <span>{l.pos_no ?? ''}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{l.text_de ?? l.lv_id}</span>
              <span>{l.quantity != null ? `${fmtQty(l.quantity)} Stk` : ''}</span>
              <span className={cx('text-right', l.lv_id === lv && 'font-semibold')}>{fmt2(l.unit_price)}</span>
            </div>
          ))}
        </div>
      </div>
      <span className="text-[13px] text-muted">{t('This is the row Assist read the price from.')}</span>
    </section>
  )
}
