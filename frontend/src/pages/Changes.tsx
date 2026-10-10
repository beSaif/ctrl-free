// Changes: the review trail for the senior. Who did what (AI, Assist, each person), before → after,
// the CHF impact, and Approve / Revert / Comment. Only a senior approves; others see the status.
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { useChanges, useReviewChanges } from '../api/hooks'
import type { ChangeEntry, ChangeField, ChangeLine, ChangeType, ChangesResponse, ReviewVerdict } from '../api/types'
import { AssistMark, Button, ErrorBox, FilterTabs, Loading, TextInput, Toggle, UnderlineTabs } from '../components/ui'
import { cx } from '../lib/cx'
import { C } from '../lib/lines'
import { fmt2, fmtDateTime, fmtNum, fmtQty, fmtSigned, fmtUnit, isNum } from '../lib/format'

type StateTab = 'to_review' | 'approved' | 'reverted' | 'all'
type View = 'line' | 'time'

const TYPES: { key: ChangeType; label: string }[] = [
  { key: 'product', label: 'Product' },
  { key: 'price', label: 'Price' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'hours', label: 'Hours' },
  { key: 'quotes', label: 'Supplier quotes' },
  { key: 'confirm', label: 'Line confirmed or flagged' },
  { key: 'instruction', label: 'Instructions' },
  { key: 'pricing', label: 'Pricing settings' },
]

const GRID = 'grid grid-cols-[150px_minmax(0,1fr)_130px_190px] gap-x-4'

export function Changes() {
  const { id = '' } = useParams()
  const t = useT()
  const [sp, setSp] = useSearchParams()
  const { data, isLoading, error } = useChanges(id)
  const review = useReviewChanges(id)
  const tab = (sp.get('tab') as StateTab) || 'to_review'
  const view = (sp.get('view') as View) || 'line'
  const actor = sp.get('by') || ''
  const type = (sp.get('type') as ChangeType) || ''
  const lowOnly = sp.get('low') === '1'
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp)
    if (v) n.set(k, v)
    else n.delete(k)
    setSp(n, { replace: true })
  }

  const filtered = useMemo(() => {
    if (!data) return []
    return data.entries.filter(
      (e) =>
        (!actor || e.by === actor) &&
        (!type || e.types.includes(type)) &&
        (!lowOnly || (e.by === 'AI' && e.ai?.low)) &&
        // confident AI picks need nobody: they show under "All" only
        (tab === 'all' || e.state === tab),
    )
  }, [data, actor, type, lowOnly, tab])

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the changes.')} />

  const s = data.summary
  const me = data.me
  const pending = filtered.filter((e) => e.state === 'to_review')
  const act = (logIds: string[], verdict: ReviewVerdict, note?: string) => review.mutate({ logIds, verdict, note })
  const inState = (st: StateTab) => data.entries.filter((e) => (st === 'all' || e.state === st) && (!actor || e.by === actor)).length

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 px-6 py-2.5 border-b border-rule">
        <FilterTabs
          label={t('Filter changes')}
          value={tab}
          onChange={(k) => set('tab', k === 'to_review' ? '' : k)}
          items={(['to_review', 'approved', 'reverted', 'all'] as StateTab[]).map((k) => ({
            key: k,
            label: t({ to_review: 'To review', approved: 'Approved', reverted: 'Reverted', all: 'All' }[k]),
            count: inState(k),
          }))}
        />
        <select aria-label={t('Who')} value={actor} onChange={(e) => set('by', e.target.value)} className="min-h-[34px] px-2 border border-rule rounded-[2px] bg-white hover:border-ink">
          <option value="">{t('Everyone')}</option>
          {s.by_actor.map((a) => (
            <option key={a.by} value={a.by}>
              {whoName(a.by, t)}
            </option>
          ))}
        </select>
        <select aria-label={t('Type of change')} value={type} onChange={(e) => set('type', e.target.value)} className="min-h-[34px] px-2 border border-rule rounded-[2px] bg-white hover:border-ink">
          <option value="">{t('All types')}</option>
          {TYPES.map((x) => (
            <option key={x.key} value={x.key}>
              {t(x.label)}
            </option>
          ))}
        </select>
        <Toggle checked={lowOnly} onChange={(v) => set('low', v ? '1' : '')}>
          <span className="text-[13.5px]">{t('AI, low confidence')}</span>
        </Toggle>
        <div className="flex-[1_1_40px]" />
        <UnderlineTabs
          label={t('Order')}
          value={view}
          onChange={(k) => set('view', k === 'line' ? '' : k)}
          items={[
            { key: 'line', label: t('By line') },
            { key: 'time', label: t('Newest first') },
          ]}
        />
      </div>

      <main className="flex-auto px-6 pt-6 pb-10 flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1 max-w-[760px]">
            <h1 className="m-0 text-[24px] leading-[1.25] font-semibold">{t('Who did what')}</h1>
            <span className="text-muted">
              {t('The AI read the tender and picked the products, people adjusted lines and prices. Every change is listed with before and after, its effect in CHF and who made it.')}{' '}
              {me.can_review
                ? t('As senior you approve or revert each one.')
                : t('Only a senior estimator approves changes; you see their status here.')}
            </span>
          </div>
          {me.can_review && pending.length > 0 && (
            <Button variant="primary" disabled={review.isPending} onClick={() => act(pending.map((e) => e.id), 'approved')}>
              {pending.length === 1 ? t('Approve 1 shown change') : t('Approve all {n} shown', { n: pending.length })}
            </Button>
          )}
        </div>

        <Summary data={data} onActor={(by) => set('by', by === actor ? '' : by)} actor={actor} />

        {review.error && (
          <p role="alert" className="m-0 text-attn">
            {t('Could not save the review.')} <span className="text-muted">({review.error.message})</span>
          </p>
        )}

        <section aria-label={t('Changes')} className="overflow-x-auto">
          <div className="min-w-[860px] border-t border-ink">
            <div className={cx(GRID, 'py-2 border-b border-rule text-[13px] text-muted font-medium')}>
              <span>{t('Who · when')}</span>
              <span>{t('What changed')}</span>
              <span className="text-right">{t('Effect')}</span>
              <span>{t('Review')}</span>
            </div>
            {filtered.length === 0 ? (
              <div className="py-8 text-muted">{tab === 'to_review' ? t('Nothing waiting for review.') : t('Nothing in this tab.')}</div>
            ) : view === 'line' ? (
              groups(filtered, data.lines).map((g) => (
                <Fragment key={g.key}>
                  <GroupHead g={g} tenderId={id} />
                  {g.entries.map((e) => (
                    <Row key={e.id} e={e} tenderId={id} canReview={me.can_review} busy={review.isPending} onReview={act} />
                  ))}
                </Fragment>
              ))
            ) : (
              filtered.map((e) => (
                <Row key={e.id} e={e} line={e.lv_id ? data.lines[e.lv_id] : undefined} tenderId={id} canReview={me.can_review} busy={review.isPending} onReview={act} />
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- summary

function Summary({ data, actor, onActor }: { data: ChangesResponse; actor: string; onActor: (by: string) => void }) {
  const t = useT()
  const s = data.summary
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[13px] font-medium text-muted">{t('By who')}</h2>
        <div className="flex flex-wrap gap-1.5">
          {s.by_actor.map((a) => (
            <button
              key={a.by}
              type="button"
              aria-pressed={actor === a.by}
              onClick={() => onActor(a.by)}
              className={cx(
                'min-h-[52px] px-3.5 py-1.5 border rounded-[2px] flex flex-col items-start justify-center gap-px text-left',
                actor === a.by ? 'bg-ink border-ink text-white' : 'bg-white border-rule text-ink hover:border-ink',
              )}
            >
              <span className="font-medium inline-flex items-center gap-1.5">
                <WhoMark by={a.by} />
                {whoName(a.by, t)}
              </span>
              <span className="text-[12.5px] font-mono">
                {a.by === 'AI' ? t('{n} decisions', { n: a.total }) : a.total === 1 ? t('1 change') : t('{n} changes', { n: a.total })}
                {a.to_review > 0 && <> · {t('{n} to review', { n: a.to_review })}</>}
              </span>
            </button>
          ))}
          {s.by_actor.length === 0 && <span className="text-muted">{t('No changes yet.')}</span>}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[13px] font-medium text-muted">{t('Changes by people and Assist')}</h2>
        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <span className="text-attn">{t('To review')}</span>
          <span className="font-mono text-right text-attn">{s.to_review}</span>
          <span>{t('Approved')}</span>
          <span className="font-mono text-right">{s.approved}</span>
          <span className="text-muted">{t('Reverted')}</span>
          <span className="font-mono text-right text-muted">{s.reverted}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[13px] font-medium text-muted">{t('AI decisions')}</h2>
        <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <span className={cx(s.ai_to_review > 0 && 'text-attn')}>{t('Low confidence, to review')}</span>
          <span className={cx('font-mono text-right', s.ai_to_review > 0 && 'text-attn')}>{s.ai_to_review}</span>
          <span>{t('Approved')}</span>
          <span className="font-mono text-right">{s.ai_approved}</span>
          <span className="text-muted">{t('Confident, no review needed')}</span>
          <span className="font-mono text-right text-muted">{s.ai - s.ai_to_review - s.ai_approved}</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- grouping

interface Group {
  key: string
  line?: ChangeLine
  entries: ChangeEntry[]
}

function groups(entries: ChangeEntry[], lines: Record<string, ChangeLine>): Group[] {
  const by = new Map<string, Group>()
  for (const e of entries) {
    const key = e.lv_id ?? '~tender'
    if (!by.has(key)) by.set(key, { key, line: e.lv_id ? lines[e.lv_id] : undefined, entries: [] })
    by.get(key)!.entries.push(e)
  }
  // lines in document order, tender-wide changes (pricing, instructions, quotes) last
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function GroupHead({ g, tenderId }: { g: Group; tenderId: string }) {
  const t = useT()
  const lang = useLang()
  if (!g.line) {
    return <div className="pt-5 pb-1.5 border-b border-rule font-semibold">{t('Whole tender: pricing, instructions and supplier requests')}</div>
  }
  const l = g.line
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 pt-5 pb-1.5 border-b border-rule">
      <Link to={`/t/${tenderId}/lines/${l.lv_id}?f=all`} className="font-mono font-semibold">
        {l.lv_id}
      </Link>
      <span className="font-semibold min-w-0 truncate">{(lang === 'en' ? l.title_en : null) || l.title_de}</span>
      <span className="text-[13px] text-muted font-mono">{t('p. {page}', { page: l.page ?? '–' })}</span>
      <span className="flex-auto" />
      <span className="text-[13px] text-muted">
        {t('Line total now')} <span className="font-mono text-ink">CHF {fmt2(l.direct)}</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- one change

function Row({
  e,
  line,
  tenderId,
  canReview,
  busy,
  onReview,
}: {
  e: ChangeEntry
  line?: ChangeLine
  tenderId: string
  canReview: boolean
  busy: boolean
  onReview: (ids: string[], verdict: ReviewVerdict, note?: string) => void
}) {
  const t = useT()
  const lang = useLang()
  const [mode, setMode] = useState<'' | 'comment' | 'revert'>('')
  const [note, setNote] = useState('')
  const comments = e.reviews.filter((r) => r.note)
  const send = (verdict: ReviewVerdict) => {
    onReview([e.id], verdict, note || undefined)
    setMode('')
    setNote('')
  }
  return (
    <div className={cx(GRID, 'py-3 border-b border-rowrule items-start')}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-medium inline-flex items-center gap-1.5">
          <WhoMark by={e.by} />
          {e.by === 'AI' ? t('AI') : whoName(e.by, t)}
        </span>
        <span className="text-[12.5px] text-muted">
          {e.by === 'AI' ? t('Read and matched') : e.by === 'Assist' ? t('Assist') : e.role === 'senior' ? t('Senior') : e.role === 'junior' ? t('Junior') : ''}
          {e.approved_by && <> · {t('OK by {who}', { who: e.approved_by })}</>}
        </span>
        <span className="font-mono text-[12.5px] text-muted">{fmtDateTime(e.at)}</span>
      </div>

      <div className="flex flex-col gap-1 min-w-0">
        {line && (
          <Link to={`/t/${tenderId}/lines/${line.lv_id}?f=all`} className="text-[13px] min-w-0 truncate">
            <span className="font-mono">{line.lv_id}</span> {(lang === 'en' ? line.title_en : null) || line.title_de}
          </Link>
        )}
        {e.by === 'AI' ? <AiWhat e={e} /> : <Fields e={e} />}
        {e.text && e.by === 'AI' && <span className="text-[13px] text-muted">{e.text}</span>}
        {e.instruction && (
          <Link to={`/t/${tenderId}/instructions/${e.instruction.id}`} className="text-[13px]">
            {e.instruction.type} · {t('p. {page}', { page: e.instruction.page })}
          </Link>
        )}
        {e.types.includes('pricing') && (
          <Link to={`/t/${tenderId}/pricing`} className="text-[13px]">
            {t('Open pricing')}
          </Link>
        )}
        {comments.map((r, i) => (
          <span key={i} className="text-[13px] border-l-2 border-rule pl-2">
            <span className="font-medium">{r.by}</span>: {r.note} <span className="text-muted font-mono text-[12px]">{fmtDateTime(r.at)}</span>
          </span>
        ))}
        {mode === 'comment' && (
          <form
            className="flex gap-2 pt-1"
            onSubmit={(ev) => {
              ev.preventDefault()
              if (note.trim()) send('comment')
            }}
          >
            <TextInput autoFocus value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} placeholder={t('Short note')} className="flex-auto" aria-label={t('Comment')} />
            <Button size="sm" type="submit" disabled={!note.trim() || busy}>
              {t('Save')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setMode('')}>
              {t('Cancel')}
            </Button>
          </form>
        )}
      </div>

      <Impact e={e} />

      <div className="flex flex-col gap-1.5 items-start">
        <StateLabel e={e} />
        {mode === 'revert' ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px]">{e.batch ? t('Revert the whole Assist batch?') : t('Revert this change?')}</span>
            <Button size="xs" variant="dark" disabled={busy} onClick={() => send('reverted')}>
              {t('Revert')}
            </Button>
            <Button size="xs" variant="quiet" onClick={() => setMode('')}>
              {t('Cancel')}
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {canReview && e.state === 'to_review' && (
              <Button size="xs" variant="primary" disabled={busy} onClick={() => send('approved')}>
                {t('Approve')}
              </Button>
            )}
            {canReview && e.state === 'approved' && !e.state_why && (
              <Button size="xs" variant="quiet" disabled={busy} onClick={() => send('reopened')}>
                {t('Reopen')}
              </Button>
            )}
            {canReview && e.undoable && e.state !== 'reverted' && (
              <Button size="xs" disabled={busy} onClick={() => setMode('revert')}>
                {t('Revert')}
              </Button>
            )}
            {e.by === 'AI' && e.lv_id && canReview && e.state !== 'auto' && (
              <Link to={`/t/${tenderId}/lines/${e.lv_id}/product`} className="text-[13px] self-center">
                {t('Change product')}
              </Link>
            )}
            {mode !== 'comment' && (
              <Button size="xs" variant="quiet" onClick={() => setMode('comment')}>
                {t('Comment')}
              </Button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function StateLabel({ e }: { e: ChangeEntry }) {
  const t = useT()
  const last = [...e.reviews].reverse().find((r) => r.verdict === 'approved')
  let label: ReactNode
  let color: string = C.muted
  if (e.state === 'reverted') {
    label = e.reverted ? t('Reverted · {who}', { who: e.reverted.by }) : t('Reverted')
  } else if (e.state === 'approved') {
    color = C.ink
    label =
      e.state_why === 'made_by_senior'
        ? t('Made by a senior')
        : e.state_why === 'ok_by_senior'
          ? t('OK given by a senior')
          : last
            ? t('Approved · {who}', { who: last.by })
            : t('Approved')
  } else if (e.state === 'auto') {
    label = t('Confident pick, no review needed')
  } else {
    color = C.attn
    label = t('To review')
  }
  return (
    <span className="inline-flex items-center gap-2 text-[13.5px]" style={{ color }}>
      <span className="flex-none w-2 h-2" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  )
}

function Impact({ e }: { e: ChangeEntry }) {
  const t = useT()
  const im = e.impact
  if (!im || !isNum(im.value)) return <span className="text-right text-muted">–</span>
  if (im.basis === 'line_total') {
    return (
      <span className="flex flex-col items-end">
        <span className="font-mono">{fmt2(im.value)}</span>
        <span className="text-[12px] text-muted">{t('line total')}</span>
      </span>
    )
  }
  if (Math.abs(im.value) < 0.005) return <span className="text-right text-muted text-[13px]">{t('no price change')}</span>
  return (
    <span className="flex flex-col items-end">
      <span className="font-mono">{fmtSigned(im.value)}</span>
      <span className="text-[12px] text-muted">{im.basis === 'price' ? t('offer price') : t('line total')}</span>
    </span>
  )
}

function AiWhat({ e }: { e: ChangeEntry }) {
  const t = useT()
  const ai = e.ai
  const prod = e.fields.find((f) => f.path === 'match.product_id')
  const qty = e.fields.find((f) => f.path === 'quantity')
  const label = ai?.label ? (t('match.' + ai.label) === 'match.' + ai.label ? ai.label : t('match.' + ai.label)) : null
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {prod?.after ? (
          <>
            {t('Picked')} <span className="font-mono">{String(prod.after)}</span> {prod.after_label}
          </>
        ) : (
          t('No catalogue product picked')
        )}
        {label && (
          <span className={cx('ml-2 text-[13px]', ai?.low ? 'text-attn' : 'text-muted')}>
            {label}
            {isNum(ai?.confidence) && ai!.confidence! > 0 && <> {Math.round(ai!.confidence! * 100)}%</>} · {ai?.method === 'llm' ? t('LLM') : ai?.method === 'rules' ? t('Rules') : ai?.method}
          </span>
        )}
      </span>
      <span className="text-[13px] text-muted">
        {isNum(qty?.after)
          ? t('Read from the tender, p. {page}: {q} {u}', { page: ai?.page ?? '–', q: fmtQty(qty.after), u: fmtUnit(ai?.unit) })
          : t('Read from the tender, p. {page}: no quantity', { page: ai?.page ?? '–' })}
      </span>
      {ai?.assumptions?.length ? <span className="text-[13px] text-muted">{t('Assumed: {a}', { a: ai.assumptions.join('; ') })}</span> : null}
    </span>
  )
}

function Fields({ e }: { e: ChangeEntry }) {
  const t = useT()
  const shown = e.fields.filter((f) => !hidden(f, e.fields))
  if (!shown.length) return <span>{e.text}</span>
  return (
    <span className="flex flex-col gap-0.5">
      {shown.map((f) => (
        <span key={f.path}>
          <span className="text-muted">{fieldLabel(f.path, t)}</span> <Val f={f} side="before" /> <span aria-hidden="true">→</span>
          <span className="sr-only">{t('to')}</span> <Val f={f} side="after" strong />
        </span>
      ))}
    </span>
  )
}

function Val({ f, side, strong }: { f: ChangeField; side: 'before' | 'after'; strong?: boolean }) {
  const t = useT()
  const v = f[side]
  const calc = side === 'before' ? f.before_calculated : f.after_calculated
  const dflt = side === 'before' ? f.before_default : f.after_default
  const label = side === 'before' ? f.before_label : f.after_label
  return (
    <span className={cx(strong && 'font-semibold')}>
      {fmtValue(f.path, v, t)}
      {label && <span className="font-normal text-muted"> {label}</span>}
      {calc && <span className="font-normal text-muted text-[12.5px]"> ({f.path === 'overrides.quantity' ? t('from the tender') : t('calculated')})</span>}
      {dflt && <span className="font-normal text-muted text-[12.5px]"> ({t('default')})</span>}
    </span>
  )
}

// ---------------------------------------------------------------- plain language for dotted paths

function hidden(f: ChangeField, all: ChangeField[]): boolean {
  const p = f.path
  if (/(_at|_by)$/.test(p) && p !== 'sent_at') return true
  if (p === 'applies_label' || p === 'status_reason' || p.startsWith('changed_by.')) return true
  // the install rule follows a new product: not a change of its own
  if (p === 'overrides.install_code' && f.after == null && all.some((x) => x.path === 'overrides.product_id')) return true
  return false
}

const LABELS: Record<string, string> = {
  'overrides.quantity': 'Quantity',
  quantity: 'Quantity',
  'overrides.unit_price': 'Unit price',
  'supplier_quote.unit_price': 'Supplier quote',
  'overrides.hours': 'Hours',
  'overrides.product_id': 'Product',
  'match.product_id': 'Product',
  'overrides.install_code': 'Install rule',
  'overrides.status': 'Status',
  variant_reason: 'Variant reason',
  confirmed: 'Confirmed',
  flagged: 'Flagged',
  state: 'State',
  kind: 'Impact',
  applies_to: 'Applies to',
  sent_at: 'Request sent',
  competition: 'Competition',
  appetite: 'Appetite',
  sensitivity: 'Price sensitivity',
  chosen: 'Offer price option',
  overhead_pct: 'Overhead',
  transport_pct: 'Transport',
}

function fieldLabel(path: string, t: T): string {
  if (LABELS[path]) return t(LABELS[path])
  const [head, ...rest] = path.split('.')
  const tail = rest.join(' ').replace(/_/g, ' ')
  if (head === 'margins') return t('Margin {name}', { name: t(rest.join('.')) })
  if (head === 'factors') return t('Site factor: {name}', { name: t(tail) })
  if (head === 'project_costs') return t('Project cost: {name}', { name: t(tail) })
  if (head === 'notes') return t('Note on {name}', { name: t(tail) })
  const s = path.replace(/\./g, ' ').replace(/_pct$/, '').replace(/_/g, ' ')
  return t(s.charAt(0).toUpperCase() + s.slice(1))
}

function fmtValue(path: string, v: ChangeField['before'], t: T): string {
  if (v === null || v === undefined || v === '') return t('empty')
  if (typeof v === 'boolean') return v ? t('yes') : t('no')
  if (typeof v === 'number') {
    if (/unit_price$/.test(path)) return 'CHF ' + fmt2(v)
    if (/hours$/.test(path)) return fmtNum(v, 2) + ' h'
    if (/_pct$/.test(path) || path.startsWith('margins.')) return fmtNum(v, 1) + '%'
    if (path === 'competition' || path === 'appetite' || path === 'sensitivity') return fmtSigned(v * 100, 0) + ' ' + t('points')
    return fmtQty(v)
  }
  if (path === 'sent_at') return fmtDateTime(v)
  if (path === 'state' || path === 'kind' || path === 'overrides.status') return t(v.replace(/_/g, ' '))
  return v
}

// ---------------------------------------------------------------- who

function whoName(by: string, t: T): string {
  if (by === 'AI') return t('AI decisions')
  if (by === 'You') return t('You')
  return by
}

function WhoMark({ by }: { by: string }) {
  if (by === 'Assist') return <AssistMark />
  if (by === 'AI') return <span aria-hidden="true" className="inline-block flex-none w-[7px] h-[7px] border-[1.5px] border-current" />
  return <span aria-hidden="true" className="inline-block flex-none w-[7px] h-[7px] bg-current" />
}
