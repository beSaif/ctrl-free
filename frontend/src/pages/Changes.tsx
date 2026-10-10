// Changes: the review trail for the senior. Who did what (AI, Assist, each person), before → after,
// the CHF impact, and Approve / Revert / Comment. Only a senior approves; others see the status.
// AI picks of the same product, confidence and method collapse into one row with "Approve all";
// expanding it lists the lines, each with its own actions. People's changes are never grouped.
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { plural, useLang, useT, type T } from '../i18n'
import { useChanges, useReviewChanges } from '../api/hooks'
import type { ChangeEntry, ChangeField, ChangeLine, ChangeType, ChangesResponse, ReviewVerdict } from '../api/types'
import { AssistMark, Button, ErrorBox, FilterTabs, IconChevron, Loading, TextInput, Toggle, UnderlineTabs } from '../components/ui'
import { Source } from '../components/Source'
import { cx } from '../lib/cx'
import { C } from '../lib/lines'
import { fmt2, fmtDateTime, fmtNum, fmtQty, fmtSigned, fmtUnit, isNum } from '../lib/format'

type StateTab = 'to_review' | 'approved' | 'reverted' | 'all'
type View = 'line' | 'time'
type OnReview = (ids: string[], verdict: ReviewVerdict, note?: string) => void

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
  const list = useMemo(() => (data ? items(filtered, view) : []), [data, filtered, view])

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the changes.')} />

  const s = data.summary
  const me = data.me
  const pending = filtered.filter((e) => e.state === 'to_review')
  const act: OnReview = (logIds, verdict, note) => review.mutate({ logIds, verdict, note })
  const inState = (st: StateTab) => data.entries.filter((e) => (st === 'all' || e.state === st) && (!actor || e.by === actor)).length
  const rowProps = { tenderId: id, canReview: me.can_review, busy: review.isPending, onReview: act }

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
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-baseline gap-3">
            <h1 className="m-0 text-[24px] leading-[1.25] font-semibold">{t('Who did what')}</h1>
            <Source label={t('How review works')} title={t('How review works')} width={380}>
              <p className="m-0">
                {t('The AI read the tender and picked the products, people adjusted lines and prices. Every change is listed with before and after, its effect in CHF and who made it.')}
              </p>
              {/* a non-senior sees the "only a senior approves" line on the page instead */}
              {me.can_review && <p className="m-0">{t('As senior you approve or revert each one.')}</p>}
              <p className="m-0 text-muted">{t('AI picks of the same product with the same confidence are shown as one row; open it to see and review each line.')}</p>
            </Source>
          </div>
          <Summary data={data} onActor={(by) => set('by', by === actor ? '' : by)} actor={actor} />
          <span className="flex-auto" />
          {me.can_review && pending.length > 0 && (
            <Button variant="primary" disabled={review.isPending} onClick={() => act(pending.map((e) => e.id), 'approved')}>
              {pending.length === 1 ? t('Approve 1 shown change') : t('Approve all {n} shown', { n: pending.length })}
            </Button>
          )}
        </div>
        {!me.can_review && <p className="m-0 -mt-3 text-[13.5px] text-muted">{t('Only a senior estimator approves changes; you see their status here.')}</p>}

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
            {list.length === 0 ? (
              <div className="py-8 text-muted">{tab === 'to_review' ? t('Nothing waiting for review.') : t('Nothing in this tab.')}</div>
            ) : (
              list.map((it) =>
                it.kind === 'ai' ? (
                  <AiGroup key={it.key} entries={it.entries} lines={data.lines} {...rowProps} />
                ) : it.kind === 'line' ? (
                  <Fragment key={it.key}>
                    <GroupHead line={it.lv_id ? data.lines[it.lv_id] : undefined} tenderId={id} />
                    {it.entries.map((e) => (
                      <Row key={e.id} e={e} {...rowProps} />
                    ))}
                  </Fragment>
                ) : (
                  <Row key={it.key} e={it.e} line={it.e.lv_id ? data.lines[it.e.lv_id] : undefined} {...rowProps} />
                ),
              )
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- summary

/** One chip per person (and the AI): a filter, with the counts; the full split is in the tooltip. */
function Summary({ data, actor, onActor }: { data: ChangesResponse; actor: string; onActor: (by: string) => void }) {
  const t = useT()
  const s = data.summary
  if (s.by_actor.length === 0) return <span className="text-muted">{t('No changes yet.')}</span>
  return (
    <div role="group" aria-label={t('By who')} className="flex flex-wrap gap-1.5">
      {s.by_actor.map((a) => {
        const on = actor === a.by
        const tip =
          a.by === 'AI'
            ? t('{n} AI decisions: {r} to review, {a} approved, {c} confident with no review needed', {
                n: a.total,
                r: a.to_review,
                a: s.ai_approved,
                c: s.ai - s.ai_to_review - s.ai_approved,
              })
            : t('{n} changes: {r} to review, {a} approved, {v} reverted', { n: a.total, r: a.to_review, a: a.approved, v: a.reverted })
        return (
          <button
            key={a.by}
            type="button"
            aria-pressed={on}
            title={tip}
            onClick={() => onActor(a.by)}
            className={cx(
              'min-h-[34px] px-3 border rounded-[2px] inline-flex items-center gap-2 text-left',
              on ? 'bg-ink border-ink text-white' : 'bg-white border-rule text-ink hover:border-ink',
            )}
          >
            <WhoMark by={a.by} />
            <span className="font-medium">{whoName(a.by, t)}</span>
            <span className="font-mono text-[12.5px]">{a.total}</span>
            {a.to_review > 0 && (
              <span className={cx('text-[12.5px]', !on && data.me.can_review && 'text-attn')}>· {t('{n} to review', { n: a.to_review })}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- grouping

type Item =
  | { kind: 'line'; key: string; sort: string; lv_id?: string | null; entries: ChangeEntry[] }
  | { kind: 'one'; key: string; sort: string; e: ChangeEntry }
  | { kind: 'ai'; key: string; sort: string; entries: ChangeEntry[] }

/** AI picks that read the same: same product, confidence band, method and review state (and approver, so the group's label holds). */
function pickKey(e: ChangeEntry): string {
  const prod = e.fields.find((f) => f.path === 'match.product_id')?.after ?? ''
  const okBy = e.state === 'approved' ? ([...e.reviews].reverse().find((r) => r.verdict === 'approved')?.by ?? '') : ''
  return [e.state, okBy, prod, e.ai?.label ?? '', Math.round((e.ai?.confidence ?? 0) * 100), e.ai?.method ?? ''].join('|')
}

function items(entries: ChangeEntry[], view: View): Item[] {
  const out: Item[] = []
  const ai = new Map<string, ChangeEntry[]>()
  const byLine = new Map<string, Item & { kind: 'line' }>()
  for (const e of entries) {
    if (e.by === 'AI') {
      const k = pickKey(e)
      if (!ai.has(k)) ai.set(k, [])
      ai.get(k)!.push(e)
    } else if (view === 'time') {
      out.push({ kind: 'one', key: e.id, sort: e.at, e })
    } else {
      // tender-wide changes (pricing, instructions, quotes) sort last
      const k = e.lv_id ?? '~tender'
      if (!byLine.has(k)) byLine.set(k, { kind: 'line', key: k, sort: k + ' 0', lv_id: e.lv_id, entries: [] })
      byLine.get(k)!.entries.push(e)
    }
  }
  out.push(...byLine.values())
  for (const [k, es] of ai) {
    es.sort((a, b) => (a.lv_id ?? '').localeCompare(b.lv_id ?? ''))
    const sort = view === 'time' ? es.reduce((m, e) => (e.at > m ? e.at : m), '') : (es[0].lv_id ?? '~') + ' 1'
    out.push({ kind: 'ai', key: 'ai|' + k, sort, entries: es })
  }
  // By line: document order; Newest first: newest on top (a group sits at its newest entry)
  return out.sort((a, b) => (view === 'time' ? b.sort.localeCompare(a.sort) : a.sort.localeCompare(b.sort)))
}

function GroupHead({ line: l, tenderId }: { line?: ChangeLine; tenderId: string }) {
  const t = useT()
  const lang = useLang()
  if (!l) {
    return <div className="pt-5 pb-1.5 border-b border-rule font-semibold">{t('Whole tender: pricing, instructions and supplier requests')}</div>
  }
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

// ---------------------------------------------------------------- AI picks, grouped

function AiGroup({
  entries: es,
  lines,
  tenderId,
  canReview,
  busy,
  onReview,
}: {
  entries: ChangeEntry[]
  lines: Record<string, ChangeLine>
  tenderId: string
  canReview: boolean
  busy: boolean
  onReview: OnReview
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const lineOf = (e: ChangeEntry) => (e.lv_id ? lines[e.lv_id] : undefined)
  const rowProps = { tenderId, canReview, busy, onReview }
  if (es.length === 1) return <Row e={es[0]} line={lineOf(es[0])} {...rowProps} />
  const head = es[0]
  const ids = es.map((e) => e.id)
  const total = es.reduce((sum, e) => sum + (isNum(e.impact?.value) ? e.impact!.value : 0), 0)
  const reopenable = head.state === 'approved' && es.every((e) => !e.state_why)
  const lvIds = es.map((e) => e.lv_id).filter(Boolean)
  return (
    <>
      <div className={cx(GRID, 'py-3 border-b border-rowrule items-start')}>
        <Who e={head} />
        <div className="flex flex-col gap-1 min-w-0">
          <Pick e={head} />
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="self-start max-w-full inline-flex items-center gap-2 min-h-7 p-0 border-0 bg-transparent text-left text-[13.5px] text-ink hover:text-accent"
          >
            <IconChevron open={open} />
            <span className="font-medium whitespace-nowrap">{plural(t, es.length, '{n} line', '{n} lines')}</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-muted">
              {lvIds.slice(0, 6).join(', ')}
              {lvIds.length > 6 && ' …'}
            </span>
          </button>
        </div>
        <span className="flex flex-col items-end">
          <span className="font-mono">{fmt2(total)}</span>
          <span className="text-[12px] text-muted">{t('lines total')}</span>
        </span>
        <div className="flex flex-col gap-1.5 items-start">
          <StateLabel e={head} />
          {canReview && head.state === 'to_review' && (
            <Button size="xs" disabled={busy} onClick={() => onReview(ids, 'approved')}>
              {t('Approve all {n}', { n: es.length })}
            </Button>
          )}
          {canReview && reopenable && (
            <Button size="xs" variant="quiet" disabled={busy} onClick={() => onReview(ids, 'reopened')}>
              {t('Reopen all {n}', { n: es.length })}
            </Button>
          )}
        </div>
      </div>
      {open && es.map((e) => <Row key={e.id} e={e} line={lineOf(e)} sub {...rowProps} />)}
    </>
  )
}

// ---------------------------------------------------------------- one change

function Row({
  e,
  line,
  sub,
  tenderId,
  canReview,
  busy,
  onReview,
}: {
  e: ChangeEntry
  line?: ChangeLine
  /** one line inside an opened AI group: the group row already says who, what and the state */
  sub?: boolean
  tenderId: string
  canReview: boolean
  busy: boolean
  onReview: OnReview
}) {
  const t = useT()
  const lang = useLang()
  const [mode, setMode] = useState<'' | 'comment' | 'revert'>('')
  const [note, setNote] = useState('')
  const comments = e.reviews.filter((r) => r.note)
  const isAi = e.by === 'AI'
  const lineHref = line && `/t/${tenderId}/lines/${line.lv_id}?f=all`
  const title = line && ((lang === 'en' ? line.title_en : null) || line.title_de)
  const send = (verdict: ReviewVerdict) => {
    onReview([e.id], verdict, note || undefined)
    setMode('')
    setNote('')
  }
  return (
    <div className={cx(GRID, 'border-b border-rowrule items-start', sub ? 'py-2 bg-panel' : 'py-3')}>
      {sub && line ? (
        <Link to={lineHref!} className="pl-5 font-mono text-[13.5px]">
          {line.lv_id}
        </Link>
      ) : (
        <Who e={e} />
      )}

      <div className="flex flex-col gap-1 min-w-0">
        {isAi && !sub && <Pick e={e} />}
        {/* a confident pick needs nobody: its reason is a tooltip on the line link */}
        {sub ? (
          <span className="text-[13.5px] min-w-0">
            {title} {isAi && <ReadFrom e={e} />}
          </span>
        ) : (
          line && (
            <span className="text-[13px] min-w-0 truncate">
              <Link to={lineHref!} title={isAi && e.state === 'auto' ? (e.text ?? undefined) : undefined}>
                <span className="font-mono">{line.lv_id}</span> {title}
              </Link>{' '}
              {isAi && <ReadFrom e={e} />}
            </span>
          )
        )}
        {isAi ? <AiWhy e={e} quiet={!sub && e.state === 'auto'} /> : <Fields e={e} />}
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
        {!sub && <StateLabel e={e} />}
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
              // the one primary button is "Approve all shown" at the top
              <Button size="xs" disabled={busy} onClick={() => send('approved')}>
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
            {isAi && e.lv_id && canReview && e.state !== 'auto' && (
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

/** Who and when. The AI reads the whole tender at one time, so its time is a tooltip. */
function Who({ e }: { e: ChangeEntry }) {
  const t = useT()
  if (e.by === 'AI') {
    return (
      <div className="flex flex-col gap-0.5 min-w-0" title={t('Read and matched') + ' · ' + fmtDateTime(e.at)}>
        <span className="font-medium inline-flex items-center gap-1.5">
          <WhoMark by="AI" />
          {t('AI')}
        </span>
        {e.approved_by && <span className="text-[12.5px] text-muted">{t('OK by {who}', { who: e.approved_by })}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="font-medium inline-flex items-center gap-1.5">
        <WhoMark by={e.by} />
        {whoName(e.by, t)}
      </span>
      <span className="text-[12.5px] text-muted">
        {e.by === 'Assist' ? t('Assist') : e.role === 'senior' ? t('Senior') : e.role === 'junior' ? t('Junior') : ''}
        {e.approved_by && <> · {t('OK by {who}', { who: e.approved_by })}</>}
      </span>
      <span className="font-mono text-[12.5px] text-muted">{fmtDateTime(e.at)}</span>
    </div>
  )
}

function StateLabel({ e }: { e: ChangeEntry }) {
  const t = useT()
  const last = [...e.reviews].reverse().find((r) => r.verdict === 'approved')
  let label: ReactNode
  let tip: string | undefined
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
    // the default: short, the reason on hover
    label = t('No review needed')
    tip = e.state_why === 'price_list' ? t('Follows the price list, no review needed') : t('Confident pick, no review needed')
  } else {
    color = C.attn
    label = t('To review')
  }
  return (
    <span className="inline-flex items-center gap-2 text-[13.5px]" style={{ color }} title={tip}>
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
      <span className="text-[12px] text-muted">{im.basis === 'price' ? t('offer price') : im.basis === 'direct' ? t('direct cost') : t('line total')}</span>
    </span>
  )
}

/** "Picked P-CTL-001 Differential pressure transmitter · Close 75% · LLM" */
function Pick({ e }: { e: ChangeEntry }) {
  const t = useT()
  const ai = e.ai
  const prod = e.fields.find((f) => f.path === 'match.product_id')
  const label = ai?.label ? (t('match.' + ai.label) === 'match.' + ai.label ? ai.label : t('match.' + ai.label)) : null
  return (
    <span>
      {prod?.after ? (
        <>
          {t('Picked')} <span className="font-mono">{String(prod.after)}</span> {prod.after_label}
        </>
      ) : (
        t('No catalogue product picked')
      )}
      {label && (
        <span className="ml-2 text-[13px] text-muted">
          {label}
          {isNum(ai?.confidence) && ai!.confidence! > 0 && <> {Math.round(ai!.confidence! * 100)}%</>} · {ai?.method === 'llm' ? t('LLM') : ai?.method === 'rules' ? t('Rules') : ai?.method}
        </span>
      )}
    </span>
  )
}

/** Where the AI read the line: "p. 82 · 2 pc", the full sentence on hover. */
function ReadFrom({ e }: { e: ChangeEntry }) {
  const t = useT()
  const ai = e.ai
  const qty = e.fields.find((f) => f.path === 'quantity')
  const has = isNum(qty?.after)
  const tip = has
    ? t('Read from the tender, p. {page}: {q} {u}', { page: ai?.page ?? '–', q: fmtQty(qty!.after as number), u: fmtUnit(ai?.unit) })
    : t('Read from the tender, p. {page}: no quantity', { page: ai?.page ?? '–' })
  return (
    <span className="text-[13px] text-muted font-mono whitespace-nowrap" title={tip}>
      · {t('p. {page}', { page: ai?.page ?? '–' })} · {has ? `${fmtQty(qty!.after as number)} ${fmtUnit(ai?.unit)}` : <span className="font-sans">{t('no quantity')}</span>}
    </span>
  )
}

/** The AI's reason and any assumption, in muted text; `quiet` leaves the reason to the tooltip. */
function AiWhy({ e, quiet }: { e: ChangeEntry; quiet?: boolean }) {
  const t = useT()
  const a = e.ai?.assumptions
  if (!e.text && !a?.length) return null
  return (
    <>
      {e.text && !quiet && <span className="text-[13px] text-muted">{e.text}</span>}
      {a?.length ? <span className="text-[13px] text-muted">{t('Assumed: {a}', { a: a.join('; ') })}</span> : null}
    </>
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
  // an instruction's long "applies to" text and the kept pipeline suggestion follow applies_to: not changes of their own
  if ((p === 'applies_long' || p === 'suggested_applies_to') && all.some((x) => x.path === 'applies_to')) return true
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
