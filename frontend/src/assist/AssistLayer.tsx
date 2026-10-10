// Assist layer (S01–S03): header tray button, tray panel, Ctrl K command bar.
// Assist only proposes. Nothing changes without a click on a button that says what happens.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import {
  useApplyPlan,
  useApplyQuotes,
  useAssist,
  useAssistCommand,
  useApplyProposal,
  useQuotes,
  useUndo,
} from '../api/hooks'
import type { AssistApplyResult, AssistPlan, AssistProposal, Position } from '../api/types'
import { AssistMark, Button, IconClose, Kbd, LinkButton, ProgressBar, Spinner } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt2, fmtQty, fmtShortDate, fmtUnit, fmtUpdated } from '../lib/format'
import { factorLabel, isSupplier, roleLabel } from '../lib/lines'
import { useAssistCtx } from './context'
import { proposalTitle, useOpenProposals } from './hooks'

export function AssistPill() {
  const t = useT()
  const ctx = useAssistCtx()
  const open = useOpenProposals()
  const n = open.length
  return (
    <button
      type="button"
      onClick={() => ctx.setTrayOpen(!ctx.trayOpen)}
      aria-expanded={ctx.trayOpen}
      aria-controls="assist-tray"
      className={cx(
        'inline-flex items-center gap-2 min-h-8 px-2.5 border border-rule rounded-[2px] bg-white text-[13px] hover:border-ink',
        n ? 'text-ink' : 'text-muted',
      )}
    >
      <AssistMark />
      {n ? t('Assist · {n} to approve', { n }) : t('Assist')}
    </button>
  )
}

export function AssistLayer() {
  const ctx = useAssistCtx()
  return (
    <>
      {ctx.trayOpen && <Tray />}
      {ctx.barOpen && <CommandBar />}
    </>
  )
}

function Tray() {
  const t = useT()
  const lang = useLang()
  const nav = useNavigate()
  const ctx = useAssistCtx()
  const id = ctx.tenderId
  const { data } = useAssist(id)
  const applyQuotes = useApplyQuotes(id)
  const applyPlan = useApplyPlan(id)
  const applyProposal = useApplyProposal(id)
  const undo = useUndo(id)
  const needs = data?.needs_ok ?? []
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  const approve = async (p: AssistProposal) => {
    if (p.kind === 'quotes' && p.lines) {
      await applyQuotes.mutateAsync({ lines: p.lines.filter((l) => l.state !== 'filled'), proposalId: p.id })
    } else if (p.plan_id) {
      await applyPlan.mutateAsync(p.plan_id)
    } else {
      await applyProposal.mutateAsync(p.id)
    }
  }
  const busy = applyQuotes.isPending || applyPlan.isPending || applyProposal.isPending

  return (
    <section
      id="assist-tray"
      ref={ref}
      tabIndex={-1}
      aria-label={t('Assist')}
      className="absolute z-30 top-2 right-6 w-[440px] max-w-[calc(100%-32px)] bg-white border border-ink shadow-[0_8px_24px_rgba(18,18,18,0.12)] flex flex-col outline-none"
    >
      <div className="flex justify-between items-center gap-3 px-4 py-3 border-b border-rule">
        <h2 className="m-0 text-[15px] font-semibold">{t('Assist on this tender')}</h2>
        <button
          type="button"
          onClick={() => ctx.setTrayOpen(false)}
          aria-label={t('Close')}
          className="w-8 h-8 inline-flex items-center justify-center border border-rule rounded-[2px] bg-white hover:border-ink"
        >
          <IconClose />
        </button>
      </div>

      <div className="px-4 py-3.5 flex flex-col gap-3 border-b border-rule">
        <span className={cx('text-[13px] font-semibold', needs.length ? 'text-attn' : 'text-muted')}>
          {needs.length ? t('Needs your OK · {n}', { n: needs.length }) : t('Needs your OK')}
        </span>
        {needs.length === 0 && <span className="text-muted">{t('Nothing is waiting for you.')}</span>}
        {needs.map((p) => (
          <div key={p.id} className="flex flex-col gap-2 p-3 border border-rule">
            <span className="font-semibold">{proposalTitle(p, t, lang)}</span>
            {p.kind === 'quotes' && (
              <>
                <span className="text-[13px] text-muted">
                  {t('Read from {file}, received {date}', { file: p.source ?? '', date: fmtShortDate(p.received_at, lang) })}
                </span>
                <div className="flex flex-col">
                  {p.lines?.map((l) => (
                    <div key={l.lv_id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] gap-2.5 py-1 border-b border-rowrule text-[13px]">
                      <span className="font-mono">{l.lv_id}</span>
                      <span className="font-mono">
                        {fmt2(l.budget)} → {fmt2(l.unit_price)}
                      </span>
                      <span className={l.state === 'filled' ? 'text-ink' : l.state === 'above budget' ? 'text-attn' : 'text-muted'}>
                        {t(l.state ?? '')}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {p.kind !== 'quotes' && p.text && <span className="text-[13px] text-muted">{p.text}</span>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => approve(p)}>
                {p.kind === 'quotes'
                  ? t('Fill all {n}', { n: p.lines?.filter((l) => l.state !== 'filled').length ?? 0 })
                  : p.kind === 'instructions'
                    ? t('Confirm {n}', { n: p.instruction_ids?.length ?? 0 })
                    : t('Do it')}
              </Button>
              {p.kind === 'quotes' && p.lines?.[0] && (
                <Button
                  size="sm"
                  onClick={() => {
                    ctx.setTrayOpen(false)
                    nav(`/t/${id}/lines/${p.lines![0].lv_id}`)
                  }}
                >
                  {t('Check on the line')}
                </Button>
              )}
              {p.kind === 'instructions' && (
                <LinkButton size="sm" to={`/t/${id}/instructions`} onClick={() => ctx.setTrayOpen(false)}>
                  {t('Review each')}
                </LinkButton>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-3.5 flex flex-col gap-2 border-b border-rule">
        <span className="text-[13px] font-semibold">{t('Working on')}</span>
        {data?.working_on.length ? (
          data.working_on.map((w) => (
            <div key={w.id} className="flex flex-col gap-1.5">
              <span>{w.text}</span>
              <ProgressBar value={w.pages ? (w.page ?? 0) / w.pages : 0.5} label={w.text} width={400} dark />
              <span className="text-[13px] text-muted">{t('you can keep working')}</span>
            </div>
          ))
        ) : (
          <span className="text-muted">{t('Nothing right now.')}</span>
        )}
      </div>

      <div className="px-4 py-3.5 flex flex-col gap-1.5 border-b border-rule">
        <span className="text-[13px] font-semibold">{t('Done')}</span>
        {(data?.done ?? []).map((d, i) => (
          <div key={d.id ?? i} className="flex justify-between items-center gap-3">
            <span className={d.undone ? 'text-muted line-through' : undefined}>{d.text}</span>
            <span className="flex-none flex items-center gap-2 text-[13px] text-muted">
              {d.undone && <span>{t('undone')}</span>}
              {d.undoable && d.log_id && (
                <button
                  type="button"
                  onClick={() => undo.mutate(d.log_id!)}
                  className="min-h-8 px-1 border-0 bg-transparent text-accent underline underline-offset-2"
                >
                  {t('Undo')}
                </button>
              )}
              {fmtUpdated(d.at, lang)}
            </span>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 text-[13px] text-muted">
        {t('Assist never changes a price or confirms anything without your OK. Every value it fills is marked and can be undone.')}
      </div>
    </section>
  )
}

// ---- command bar ------------------------------------------------------------------------

type BarState =
  | { s: 'home' }
  | { s: 'loading' }
  | { s: 'plan'; plan: AssistPlan; text: string }
  | { s: 'done'; res: AssistApplyResult }
  | { s: 'why'; p: Position }
  | { s: 'error'; msg: string }

function CommandBar() {
  const t = useT()
  const nav = useNavigate()
  const ctx = useAssistCtx()
  const id = ctx.tenderId
  const line = ctx.line
  const [scope, setScope] = useState<'line' | 'tender'>(line ? 'line' : 'tender')
  const [text, setText] = useState('')
  const [st, setSt] = useState<BarState>({ s: 'home' })
  const cmd = useAssistCommand(id)
  const apply = useApplyPlan(id)
  const applyQuotes = useApplyQuotes(id)
  const undo = useUndo(id)
  const proposals = useOpenProposals()
  const { data: quotes } = useQuotes(id)
  const inputRef = useRef<HTMLInputElement>(null)
  const doRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    if (st.s === 'plan') doRef.current?.focus()
  }, [st.s])

  const lineProposal =
    line &&
    proposals
      .filter((p) => p.kind === 'quotes')
      .flatMap((p) => p.lines ?? [])
      .find((l) => l.lv_id === line.lv_id && l.state !== 'filled')

  const run = async (q: string) => {
    if (!q.trim()) return
    setText(q)
    setSt({ s: 'loading' })
    try {
      const plan = await cmd.mutateAsync({ text: q, scope, lv_id: scope === 'line' ? line?.lv_id : undefined })
      setSt({ s: 'plan', plan, text: q })
    } catch (e) {
      setSt({ s: 'error', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  const doIt = async (planId: string) => {
    try {
      const res = await apply.mutateAsync(planId)
      setSt({ s: 'done', res })
    } catch (e) {
      setSt({ s: 'error', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  const labour = line?.pricing ? fmt2(line.pricing.labour) : ''
  const hasOpenQuoteLines = !!quotes?.some((g) => g.lv_ids.length)
  const suggestions: { t: string; kind: string; run: () => void }[] = []
  if (scope === 'line' && line) {
    if (lineProposal)
      suggestions.push({
        t: t('Fill the quote from the supplier’s reply'),
        kind: t('fills data'),
        run: async () => {
          const prop = proposals.find((x) => x.lines?.some((l) => l === lineProposal))
          await applyQuotes.mutateAsync({ lines: [lineProposal], proposalId: prop?.id })
          ctx.closeBar()
        },
      })
    if (isSupplier(line)) suggestions.push({ t: t('Confirm every line where the quote is at or below budget'), kind: t('shows a plan first'), run: () => run('Confirm every line where the quote is at or below budget') })
    if (line.pricing)
      suggestions.push({
        t: t('Why is the labour on this line {v}?', { v: labour }),
        kind: t('explains'),
        run: () => {
          setText(t('Why is the labour on this line {v}?', { v: labour }))
          setSt({ s: 'why', p: line })
        },
      })
    if (isSupplier(line)) suggestions.push({ t: t('Draft a reminder to the supplier for the open lines'), kind: t('drafts an email'), run: () => run('Draft a reminder to the supplier for the open lines') })
    suggestions.push({ t: t('Show the same product in other areas'), kind: t('finds'), run: () => run('Show the same product in other areas') })
  } else {
    if (hasOpenQuoteLines) suggestions.push({ t: t('Confirm every line where the quote is at or below budget'), kind: t('shows a plan first'), run: () => run('Confirm every line where the quote is at or below budget') })
    suggestions.push({ t: t('Confirm the instructions that do not change the price'), kind: t('shows a plan first'), run: () => run('Confirm the instructions that do not change the price') })
    suggestions.push({ t: t('Which lines carry the most money at risk?'), kind: t('finds'), run: () => run('Which lines carry the most money at risk?') })
    if (hasOpenQuoteLines) suggestions.push({ t: t('Draft a reminder to the supplier for the open lines'), kind: t('drafts an email'), run: () => run('Draft a reminder to the supplier for the open lines') })
  }

  const openLine = (lv: string) => {
    ctx.closeBar()
    nav(`/t/${id}/lines/${lv}`)
  }

  return (
    <section
      aria-label={t('Tell Assist what to do')}
      className="absolute z-40 top-16 left-1/2 -translate-x-1/2 w-[680px] max-w-[calc(100%-32px)] bg-white border border-ink shadow-[0_12px_32px_rgba(18,18,18,0.16)] flex flex-col"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          ctx.closeBar()
        }
      }}
    >
      <form
        className="flex items-center gap-2.5 py-2.5 pr-3 pl-4 border-b border-rule"
        onSubmit={(e) => {
          e.preventDefault()
          void run(text)
        }}
      >
        <AssistMark />
        <label className="flex flex-auto">
          <span className="sr-only">{t('Tell Assist what to do')}</span>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (st.s !== 'home' && st.s !== 'loading') setSt({ s: 'home' })
            }}
            placeholder={line ? t('Tell Assist what to do, or ask about this line') : t('Tell Assist what to do')}
            className="flex-auto min-w-0 min-h-9 border-0 text-[16px] outline-none bg-transparent placeholder:text-faint"
          />
        </label>
        <button
          type="button"
          onClick={ctx.closeBar}
          className="min-h-8 px-2 border border-rule rounded-[2px] bg-white font-mono text-[11.5px] text-muted hover:border-ink"
          aria-label={t('Close')}
        >
          Esc
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-rowrule text-[13px]">
        <span className="text-muted">{t('About')}</span>
        {line && (
          <button
            type="button"
            aria-pressed={scope === 'line'}
            onClick={() => {
              setScope('line')
              setSt({ s: 'home' })
            }}
            className={cx('min-h-8 px-2 border rounded-[2px] bg-white', scope === 'line' ? 'border-ink text-ink' : 'border-rule text-muted')}
          >
            {t('This line')} · {line.lv_id}
          </button>
        )}
        <button
          type="button"
          aria-pressed={scope === 'tender'}
          onClick={() => {
            setScope('tender')
            setSt({ s: 'home' })
          }}
          className={cx('min-h-8 px-2 border rounded-[2px] bg-white', scope === 'tender' ? 'border-ink text-ink' : 'border-rule text-muted')}
        >
          {t('Whole tender')}
        </button>
      </div>

      {st.s === 'home' && (
        <div className="flex flex-col py-1.5">
          {suggestions.map((s) => (
            <button
              key={s.t}
              type="button"
              onClick={s.run}
              className="flex justify-between items-center gap-3 w-full min-h-11 px-4 border-0 bg-white text-left hover:bg-panel focus-visible:bg-panel"
            >
              <span>{s.t}</span>
              <span className="flex-none text-[13px] text-muted">{s.kind}</span>
            </button>
          ))}
        </div>
      )}

      {st.s === 'loading' && (
        <div className="px-4 py-4">
          <Spinner label={t('Working out a plan')} />
        </div>
      )}

      {st.s === 'error' && (
        <div className="px-4 py-3.5 flex flex-col gap-2.5">
          <span className="text-attn">{st.msg}</span>
          <div>
            <Button onClick={() => setSt({ s: 'home' })}>{t('Change the request')}</Button>
          </div>
        </div>
      )}

      {st.s === 'plan' && (
        <div className="px-4 py-3.5 flex flex-col gap-2.5">
          {st.plan.answer && !st.plan.explain && <span className="whitespace-pre-line">{st.plan.answer}</span>}
          {st.plan.explain && (
            <>
              <span className="font-semibold">{st.plan.explain.title ?? st.plan.answer}</span>
              <div className="flex flex-col">
                {st.plan.explain.steps.map((x, i) => (
                  <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-rowrule">
                    <span>{x.text}</span>
                    {x.value !== undefined && <span className="flex-none font-mono">{String(x.value)}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          {st.plan.plan.length > 0 && (
            <>
              <span className="font-semibold">{st.plan.plan_id ? t('This is what I would do') : t('This is what I found')}</span>
              <div className="flex flex-col">
                {st.plan.plan.map((p, i) => (
                  <div key={i} className="grid grid-cols-[64px_minmax(0,1fr)_auto] gap-2.5 py-[7px] border-b border-rowrule items-center">
                    <span className="font-mono text-[13px]">{p.lv_id ?? ''}</span>
                    <span>{p.text}</span>
                    {p.action === 'open' && p.lv_id ? (
                      <button type="button" onClick={() => openLine(p.lv_id!)} className="min-h-8 px-1 border-0 bg-transparent text-accent underline underline-offset-2">
                        {t('Open')}
                      </button>
                    ) : (
                      <span className={cx('font-medium', /leave|review/.test(p.action) ? 'text-attn' : 'text-ink')}>{t(p.action)}</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {st.plan.plan_id && st.plan.effect && (
            <span className="text-[13px] text-muted">
              {t('Direct cost goes from {a} to {b}. Nothing has changed yet.', { a: fmt2(st.plan.effect.direct_before), b: fmt2(st.plan.effect.direct_after) })}
            </span>
          )}
          {st.plan.plan_id && !st.plan.effect && <span className="text-[13px] text-muted">{t('Nothing has changed yet.')}</span>}
          <div className="flex flex-wrap gap-2">
            {st.plan.plan_id && (
              <Button ref={doRef} variant="primary" disabled={apply.isPending} onClick={() => doIt(st.plan.plan_id!)}>
                {t('Do it')} <Kbd>Enter</Kbd>
              </Button>
            )}
            <Button
              onClick={() => {
                setSt({ s: 'home' })
                inputRef.current?.focus()
              }}
            >
              {t('Change the request')}
            </Button>
          </div>
        </div>
      )}

      {st.s === 'done' && (
        <div className="px-4 py-3.5 flex flex-col gap-2.5">
          <span className="flex items-center gap-2 font-semibold">
            <span className="w-2 h-2 bg-ink" aria-hidden="true" />
            {st.res.message ?? t('Done')}
          </span>
          {st.res.detail && <span className="text-muted">{st.res.detail}</span>}
          <div className="flex flex-wrap gap-2">
            {st.res.log_id && (
              <Button
                disabled={undo.isPending}
                onClick={async () => {
                  await undo.mutateAsync(st.res.log_id!)
                  setSt({ s: 'home' })
                }}
              >
                {t('Undo')}
              </Button>
            )}
            <Button onClick={ctx.closeBar}>{t('Close')}</Button>
          </div>
        </div>
      )}

      {st.s === 'why' && <WhyLabour p={st.p} onBack={() => setSt({ s: 'home' })} onClose={ctx.closeBar} tenderId={id} />}
    </section>
  )
}

function WhyLabour({ p, onBack, onClose, tenderId }: { p: Position; onBack: () => void; onClose: () => void; tenderId: string }) {
  const t = useT()
  const pr = p.pricing!
  const typed = p.overrides?.hours != null
  const raw = pr.quantity * pr.base_hours_per_unit
  const unit = fmtUnit(p.unit)
  const install = p.overrides?.install_code ?? p.match?.install_code ?? ''
  return (
    <div className="px-4 py-3.5 flex flex-col gap-2.5">
      <span className="font-semibold">{t('Why the labour on this line is CHF {v}', { v: fmt2(pr.labour) })}</span>
      <div className="flex flex-col">
        {typed ? (
          <div className="flex justify-between gap-3 py-1.5 border-b border-rowrule">
            <span>{t('Hours typed by you')}</span>
            <span className="flex-none font-mono">{fmt2(pr.hours)} h</span>
          </div>
        ) : (
          <>
            <div className="flex justify-between gap-3 py-1.5 border-b border-rowrule">
              <span>
                {t('{qty} {unit} × {h} h per {unit} (install rule {code})', { qty: fmtQty(pr.quantity), unit, h: fmt2(pr.base_hours_per_unit), code: install })}
              </span>
              <span className="flex-none font-mono">{fmt2(raw)} h</span>
            </div>
            <div className="flex justify-between gap-3 py-1.5 border-b border-rowrule">
              <span>{pr.factors.map((f) => `${f.op} ${f.value.toFixed(2)} ${factorLabel(f.key, t)}`).join(', ')}</span>
              <span className="flex-none font-mono">{fmt2(pr.hours)} h</span>
            </div>
          </>
        )}
        <div className="flex justify-between gap-3 py-1.5 font-semibold">
          <span>{t('× CHF {rate} per hour ({role})', { rate: pr.rate, role: roleLabel(pr.role, t) })}</span>
          <span className="flex-none font-mono">{fmt2(pr.labour)}</span>
        </div>
      </div>
      <span className="text-[13px] text-muted">
        {t('Sources:')}{' '}
        <Link to="/reference?tab=rules" onClick={onClose}>
          {t('install rules')}
        </Link>{' '}
        {t('and the site factors in')}{' '}
        <Link to={`/t/${tenderId}/pricing`} onClick={onClose}>
          {t('Pricing')}
        </Link>
        .
      </span>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onBack}>{t('Ask something else')}</Button>
        <Button onClick={onClose}>{t('Close')}</Button>
      </div>
    </div>
  )
}

/** Floating "Tell Assist what to do  Ctrl K" button (S01), shown above the footer on line pages. */
export function AssistBarButton() {
  const t = useT()
  const ctx = useAssistCtx()
  if (ctx.barOpen) return null
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
  return (
    <button
      type="button"
      onClick={ctx.openBar}
      className="sticky bottom-[62px] self-center z-20 inline-flex items-center gap-3 min-h-11 pl-4 pr-3.5 border border-ink rounded-[2px] bg-white shadow-[0_4px_16px_rgba(18,18,18,0.10)] text-muted hover:text-ink"
    >
      <AssistMark />
      <span>{t('Tell Assist what to do')}</span>
      <Kbd>{mac ? '⌘ K' : 'Ctrl K'}</Kbd>
    </button>
  )
}
