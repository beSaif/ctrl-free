// Line detail "History": the line's trail from extraction to now. The first entries are built from
// what the reader and the matcher recorded on the position (page, quantity line, match method,
// confidence, reason); the rest is the audit log (GET /log?lv_id=) with before → after and Undo.
import { useState } from 'react'
import { useT, type T } from '../i18n'
import { useUndo } from '../api/hooks'
import type { CatalogRow, LogEntry, Position } from '../api/types'
import { Button, Td, Th } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt2, fmtDateTime, fmtQty, fmtUnit } from '../lib/format'
import { rec, whoLabel } from '../lib/trace'

interface Row {
  id: string
  at?: string | null
  who: string
  text: string
  detail?: string
  quote?: string
  changes: { label: string; before: string; after: string }[]
  entry?: LogEntry
}

const PATH_LABEL: Record<string, string> = {
  'overrides.quantity': 'Quantity',
  'overrides.unit_price': 'Unit price',
  'overrides.hours': 'Hours',
  'overrides.product_id': 'Product',
  'overrides.install_code': 'Install rule',
  'overrides.status': 'Status',
  supplier_quote: 'Supplier quote',
  confirmed: 'Confirmed',
  flagged: 'Flagged',
  variant_reason: 'Variant reason',
}

const ACTION_TEXT: Record<string, string> = {
  edit: 'Changed the line',
  reset: 'Reset to calculated values',
  confirm: 'Confirmed the line',
  unconfirm: 'Removed the confirmation',
  flag: 'Flagged for review',
  unflag: 'Removed the flag',
  fill_quote: 'Filled in the supplier quote',
  undo: 'Undid a change',
}

function fmtValue(path: string, v: unknown, p: Position, cat: Record<string, CatalogRow>, t: T): string {
  const n = typeof v === 'number' ? v : null
  switch (path) {
    case 'overrides.quantity':
      return n === null ? t('tender value ({q})', { q: fmtQty(p.quantity) }) : `${fmtQty(n)} ${fmtUnit(p.unit)}`
    case 'overrides.unit_price':
      return n === null ? t('catalogue price') : `CHF ${fmt2(n)}`
    case 'overrides.hours':
      return n === null ? t('install rule') : `${fmt2(n)} h`
    case 'overrides.product_id':
    case 'overrides.install_code': {
      if (v == null) return t('as matched')
      const d = path === 'overrides.product_id' ? cat[String(v)]?.description : undefined
      return d ? `${v} · ${d}` : String(v)
    }
    case 'supplier_quote': {
      const q = rec(v)
      if (v == null || typeof q.unit_price !== 'number') return t('none (budget price)')
      return `CHF ${fmt2(q.unit_price)}${q.source ? ` · ${q.source}` : ''}`
    }
    case 'confirmed':
      return v ? t('yes') : t('no')
    case 'flagged':
      return v ? t('yes') : t('no')
  }
  if (v == null || v === '') return '–'
  if (typeof v === 'number') return fmt2(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function pathLabel(path: string, t: T) {
  return t(PATH_LABEL[path] ?? path.replace(/^overrides\./, '').replace(/[._]/g, ' '))
}

/** The reader's and the matcher's decisions, as the first entries of the trail. */
function originRows(p: Position, readAt: string | null | undefined, cat: Record<string, CatalogRow>, t: T): Row[] {
  const out: Row[] = []
  const qtyLine = p.source?.lines?.find((l) => l.role === 'qty')?.text
  out.push({
    id: 'origin-read',
    at: readAt,
    who: t('PDF reader'),
    text: t('Read from the tender, p. {page}', { page: p.source?.page ?? p.page }),
    detail: p.quantity !== null ? t('Quantity {q} {u}, as written in the tender', { q: fmtQty(p.quantity), u: p.unit_raw ?? fmtUnit(p.unit) }) : t('No quantity found in the tender'),
    quote: qtyLine,
    changes: [],
  })
  const m = p.match
  if (p.pricing?.unit_price_source === 'labour') {
    out.push({ id: 'origin-match', at: readAt, who: t('Rules'), text: t('Priced as hourly work: the tender asks for hours'), changes: [] })
  } else if (m) {
    const learned = rec((m as unknown as Record<string, unknown>).learned)
    const ai = m.method === 'llm' || m.method === 'cache'
    const who =
      m.method === 'learned' && typeof learned.by === 'string' ? learned.by : ai ? 'AI' : m.method === 'manual' ? t('You') : t('Matching rules')
    const pct = Math.round((m.confidence ?? 0) * 100)
    const lk = 'match.' + m.label
    const label = t(lk) === lk ? m.label : t(lk)
    const desc = m.product_id ? cat[m.product_id]?.description : undefined
    const text = m.product_id
      ? t('Matched to {pid}{d}', { pid: m.product_id, d: desc ? ` · ${desc}` : '' })
      : t('No catalogue product matched')
    const how =
      m.method === 'learned'
        ? t('Learned from {tender} {lv}', { tender: String(learned.tender_name ?? learned.tender_id ?? ''), lv: String(learned.lv_id ?? '') })
        : t('{label} match, {pct}% confident, best of {n} candidates', { label, pct, n: m.candidates?.length || 5 }) +
          (m.method === 'cache' ? ` (${t('stored answer from an earlier identical run')})` : '')
    out.push({
      id: 'origin-match',
      at: readAt,
      who,
      text,
      detail: [how, m.reason, m.install_code ? t('Install rule {code} from the product', { code: m.install_code }) : '']
        .map((x) => (x ?? '').trim().replace(/\.$/, ''))
        .filter(Boolean)
        .join('. ') + '.',
      changes: [],
    })
  }
  return out
}

/** An entry can be undone from here when nothing later, still in effect, changed the same values. */
function undoBlocked(e: LogEntry, newestFirst: LogEntry[]): boolean {
  const paths = Object.keys(rec(e.after))
  const later = newestFirst.slice(0, newestFirst.indexOf(e))
  return later.some(
    (x) => !x.undone && x.action !== 'undo' && Object.keys(rec(x.after)).some((q) => paths.some((pp) => q === pp || q.startsWith(pp + '.') || pp.startsWith(q + '.'))),
  )
}

export function LineHistory({
  tenderId,
  p,
  log,
  readAt,
  cat,
  loading,
}: {
  tenderId: string
  p: Position
  /** newest first */
  log: LogEntry[]
  readAt?: string | null
  cat: Record<string, CatalogRow>
  loading?: boolean
}) {
  const t = useT()
  const undo = useUndo(tenderId)
  const [err, setErr] = useState<string | null>(null)
  const byId = new Map(log.map((e) => [e.id, e]))

  const rows: Row[] = [
    ...originRows(p, readAt, cat, t),
    // a senior's revert is logged twice (the undo and the review); the undo row already says it
    ...[...log].reverse().filter((e) => !(e.action === 'review' && rec(e).verdict === 'reverted')).map((e): Row => {
      const after = rec(e.after)
      const before = rec(e.before)
      // confirm / flag entries say it all in their title; edits list each value before → after
      const paths = ['confirm', 'unconfirm', 'flag', 'unflag'].includes(e.action) ? [] : Object.keys(after)
      const undone = e.undoes ? byId.get(e.undoes) : undefined
      const known = ACTION_TEXT[e.action]
      return {
        id: e.id,
        at: e.at,
        who: whoLabel(e.by, t),
        text: known ? t(known) : (e.text ?? e.action),
        detail: e.action === 'undo' && undone ? t('Reverted the change of {when}', { when: fmtDateTime(undone.at) }) : undefined,
        changes: paths.map((k) => ({ label: pathLabel(k, t), before: fmtValue(k, before[k], p, cat, t), after: fmtValue(k, after[k], p, cat, t) })),
        entry: e,
      }
    }),
  ]

  const doUndo = async (e: LogEntry) => {
    setErr(null)
    try {
      await undo.mutateAsync(e.id)
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x))
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby="line-history-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="line-history-h" className="m-0 text-[15px] font-semibold">
          {t('History of this line')}
        </h2>
        <span className="text-[13px] text-muted">{t('From reading the tender to now, oldest first. Every change is recorded with who and when.')}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <Th className="w-[150px]">{t('When')}</Th>
              <Th className="w-[140px]">{t('Who')}</Th>
              <Th>{t('What')}</Th>
              <Th className="w-[110px] text-right">
                <span className="sr-only">{t('Undo')}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const e = r.entry
              const isUndone = !!e?.undone
              const canUndo = !!e && e.undoable !== false && !isUndone && e.action !== 'undo'
              const blocked = canUndo && undoBlocked(e!, log)
              return (
                <tr key={r.id}>
                  <Td className="py-2 font-mono text-[12.5px] text-muted whitespace-nowrap">{r.at ? fmtDateTime(r.at) : '–'}</Td>
                  <Td className="py-2">{r.who}</Td>
                  <Td className="py-2">
                    <div className={cx('flex flex-col gap-0.5', isUndone && 'text-muted')}>
                      <span className={cx(isUndone && 'line-through')}>{r.text}</span>
                      {r.detail && <span className="text-[13px] text-muted">{r.detail}</span>}
                      {r.quote && <span className="self-start px-1.5 bg-hl font-mono text-[12px] whitespace-pre-wrap">«{r.quote.replace(/\s{2,}/g, '   ')}»</span>}
                      {r.changes.map((c, i) => (
                        <span key={i} className="text-[13px]">
                          <span className="text-muted">{c.label}: </span>
                          <span className="font-mono text-[12.5px]">
                            {c.before} → {c.after}
                          </span>
                        </span>
                      ))}
                      {e?.batch && canUndo && <span className="text-[12.5px] text-faint">{t('Made together with other changes; Undo reverts them all.')}</span>}
                    </div>
                  </Td>
                  <Td className="py-2 text-right">
                    {isUndone ? (
                      <span className="text-[13px] text-muted">{t('Undone')}</span>
                    ) : canUndo ? (
                      blocked ? (
                        <span className="text-[12.5px] text-faint">{t('Changed again later')}</span>
                      ) : (
                        <Button size="xs" disabled={undo.isPending} onClick={() => doUndo(e!)}>
                          {t('Undo')}
                        </Button>
                      )
                    ) : null}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {loading && <span className="text-[13px] text-muted">{t('Loading')}</span>}
      {!loading && log.length === 0 && <span className="text-[13px] text-muted">{t('No changes since the tender was read.')}</span>}
      {err && (
        <span role="alert" className="text-attn">
          {t('Could not undo.')} {err}
        </span>
      )}
    </section>
  )
}
