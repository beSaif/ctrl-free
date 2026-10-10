// Assist in place (S01): a proposal next to the field it would fill, the supplier reply it read,
// a note on values it filled (with Undo), and the drop zone for a supplier's answer.
import { useState } from 'react'
import { useT } from '../i18n'
import { useApplyQuotes, useAssist, useReadQuote, useUndo } from '../api/hooks'
import type { AssistProposal, Position, QuoteProposal } from '../api/types'
import { AssistMark, Button, Spinner } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt2, fmtQty } from '../lib/format'
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

export function DropZone({ tenderId, lv }: { tenderId: string; lv: string }) {
  const t = useT()
  const read = useReadQuote(tenderId)
  const [over, setOver] = useState(false)
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState('')
  const [reading, setReading] = useState<string | null>(null)
  const go = async (input: File | string) => {
    setReading(typeof input === 'string' ? t('the pasted email') : input.name)
    try {
      await read.mutateAsync({ input, lv })
    } finally {
      setReading(null)
      setPaste(false)
      setText('')
    }
  }
  return (
    <section
      aria-label={t('Got the supplier’s answer?')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files[0]
        if (f) void go(f)
        else {
          const s = e.dataTransfer.getData('text/plain')
          if (s) void go(s)
        }
      }}
      className={cx('flex flex-col gap-1 px-4 py-3.5 border border-dashed', over ? 'border-accent bg-sel' : 'border-stone')}
    >
      <span className="font-medium">{t('Got the supplier’s answer?')}</span>
      <span className="text-[13px] text-muted">{t('Drop the PDF or the email here. Assist reads the prices and asks before filling them in.')}</span>
      {reading ? (
        <span className="pt-1.5">
          <Spinner label={t('Reading {f}…', { f: reading })} />
        </span>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1.5">
          <label className="inline-flex items-center min-h-8 px-2.5 text-[13px] border border-rule rounded-[2px] bg-white cursor-pointer hover:border-ink focus-within:outline-2 focus-within:outline-accent">
            {t('Choose file')}
            <input
              type="file"
              accept=".pdf,.eml,.msg,.txt,application/pdf,message/rfc822,text/plain"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void go(f)
              }}
            />
          </label>
          <Button size="xs" onClick={() => setPaste((v) => !v)} aria-expanded={paste}>
            {t('Paste the email text')}
          </Button>
        </div>
      )}
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
            <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => void go(text)}>
              {t('Read it')}
            </Button>
          </div>
        </div>
      )}
      {read.error && (
        <span role="alert" className="text-attn text-[13px]">
          {t('Assist could not read this file.')} {read.error instanceof Error ? read.error.message : ''}
        </span>
      )}
    </section>
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
              style={{ background: l.lv_id === lv ? '#FCE9DC' : 'transparent' }}
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
