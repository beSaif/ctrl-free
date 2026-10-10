// "Applies to" line picker for an instruction: search, lines as printed (system → section),
// select a whole system, section or product type in one click, suggested lines marked.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLang, useT } from '../i18n'
import type { LineFamily, Position } from '../api/types'
import { Button, Dialog, SearchBox } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt2, fmtQty, fmtUnit } from '../lib/format'
import { C, matchesSearch } from '../lib/lines'

const direct = (p: Position) => p.pricing?.direct ?? 0

interface Group {
  key: string
  name: string
  lines: Position[]
  sections: { key: string; name: string; lines: Position[] }[]
}

/** Lines a rule can apply to, in printed order, grouped by system and section. */
export function pickable(positions: Position[]): Position[] {
  const at = new Map(positions.map((p, i) => [p.lv_id, p.pdf_order ?? i]))
  return positions.filter((p) => p.kind !== 'subtotal' && p.kind !== 'text_only').sort((a, b) => at.get(a.lv_id)! - at.get(b.lv_id)!)
}

function groups(ls: Position[]): Group[] {
  const out: Group[] = []
  for (const p of ls) {
    let g = out[out.length - 1]
    if (!g || g.lines[0].system !== p.system) out.push((g = { key: 's' + out.length, name: p.system, lines: [], sections: [] }))
    g.lines.push(p)
    let s = g.sections[g.sections.length - 1]
    if (!s || (s.lines[0].section ?? '') !== (p.section ?? ''))
      g.sections.push((s = { key: g.key + '-' + g.sections.length, name: [p.section, p.section_name].filter(Boolean).join(' '), lines: [] }))
    s.lines.push(p)
  }
  return out
}

function Check({ state, onChange, label }: { state: boolean | 'some'; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === true} onChange={onChange} className="flex-none w-4 h-4 m-0 accent-accent" />
}

export function LinePicker({
  open,
  onClose,
  positions,
  families,
  selected,
  suggested,
  onApply,
}: {
  open: boolean
  onClose: () => void
  positions: Position[]
  families: LineFamily[]
  selected: string[]
  suggested: string[]
  onApply: (ids: string[]) => void
}) {
  return open ? <PickerOpen {...{ onClose, positions, families, selected, suggested, onApply }} /> : null
}

function PickerOpen({
  onClose,
  positions,
  families,
  selected,
  suggested,
  onApply,
}: {
  onClose: () => void
  positions: Position[]
  families: LineFamily[]
  selected: string[]
  suggested: string[]
  onApply: (ids: string[]) => void
}) {
  const t = useT()
  const lang = useLang()
  const [sel, setSel] = useState(() => new Set(selected))
  const [q, setQ] = useState('')
  const [onlySel, setOnlySel] = useState(false)
  const all = useMemo(() => pickable(positions), [positions])
  const sugg = useMemo(() => new Set(suggested), [suggested])
  const shown = useMemo(() => all.filter((p) => matchesSearch(p, q) && (!onlySel || sel.has(p.lv_id))), [all, q, onlySel, sel])
  const tree = useMemo(() => groups(shown), [shown])
  const chosen = all.filter((p) => sel.has(p.lv_id))
  const total = chosen.reduce((a, p) => a + direct(p), 0)
  const fams = families.filter((f) => f.lv_ids.some((x) => all.some((p) => p.lv_id === x)))

  const stateOf = (ls: { lv_id: string }[]): boolean | 'some' => {
    const n = ls.filter((p) => sel.has(p.lv_id)).length
    return n === 0 ? false : n === ls.length ? true : 'some'
  }
  // a group click selects all of it, or clears it when it is already fully selected
  const toggleAll = (ids: string[]) =>
    setSel((s) => {
      const n = new Set(s)
      const on = ids.every((x) => n.has(x))
      ids.forEach((x) => (on ? n.delete(x) : n.add(x)))
      return n
    })
  const ids = (ls: Position[]) => ls.map((p) => p.lv_id)
  const nLines = (n: number) => (n === 1 ? t('{n} line', { n }) : t('{n} lines', { n }))
  const same = chosen.length === suggested.length && chosen.every((p) => sugg.has(p.lv_id))

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Choose the lines this rule applies to')}
      width={1000}
      footer={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 w-full">
          <span aria-live="polite" className="font-medium">
            {t('{n} selected', { n: chosen.length })} ·{' '}
            <span className="font-mono" title={t('direct cost today')}>
              CHF {fmt2(total)}
            </span>
          </span>
          <span className="flex-auto" />
          <Button size="sm" onClick={() => setSel(new Set())} disabled={!chosen.length}>
            {t('Clear')}
          </Button>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => onApply(chosen.map((p) => p.lv_id))}>
            {chosen.length ? t('Use these {n} lines', { n: chosen.length }) : t('Use: whole installation')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-6 pt-4 pb-3 border-b border-rule">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SearchBox value={q} onChange={setQ} label={t('Search')} placeholder={t('LV number, text or page')} className="flex-[1_1_260px]" />
          <label className="flex items-center gap-2 text-[13px] cursor-pointer">
            <input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} className="w-4 h-4 m-0 accent-accent" />
            {t('Only selected')}
          </label>
          {suggested.length > 0 && (
            <button
              type="button"
              disabled={same}
              onClick={() => setSel(new Set(suggested))}
              className="min-h-8 px-1 border-0 bg-transparent text-[13px] text-accent underline underline-offset-2 disabled:text-faint disabled:no-underline"
            >
              {t('Back to the suggestion ({n})', { n: suggested.length })}
            </button>
          )}
        </div>
        {fams.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Select by product type')}>
            <span className="text-[13px] text-muted mr-1">{t('By type')}</span>
            {fams.map((f) => {
              const st = stateOf(f.lv_ids.map((lv_id) => ({ lv_id })))
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={st === true}
                  onClick={() => toggleAll(f.lv_ids)}
                  title={st === true ? t('Clear all {type}', { type: f.label }) : t('Select all {type}', { type: f.label })}
                  className={cx(
                    'min-h-[30px] px-2.5 border rounded-[2px] text-[13px]',
                    st === true ? 'bg-ink border-ink text-white' : st === 'some' ? 'bg-white border-ink text-ink' : 'bg-white border-rule text-ink hover:border-ink',
                  )}
                >
                  {lang === 'de' && f.label_de ? f.label_de : t(f.label)}
                  <span className="font-mono ml-1.5">{st === 'some' ? `${f.lv_ids.filter((x) => sel.has(x)).length}/${f.lv_ids.length}` : f.lv_ids.length}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="max-h-[56vh] overflow-y-auto">
        {tree.map((g) => (
          <div key={g.key}>
            <label className="sticky top-0 z-[1] flex items-center gap-3 min-h-9 px-6 border-b border-rule bg-panel cursor-pointer">
              <Check state={stateOf(g.lines)} onChange={() => toggleAll(ids(g.lines))} label={t('Select all of {g}', { g: g.name })} />
              <span className="font-semibold">{g.name}</span>
              <span className="text-muted text-[13px]">{nLines(g.lines.length)}</span>
              <span className="flex-auto" />
              <span className="font-mono text-[13px]">{fmt2(g.lines.reduce((a, p) => a + direct(p), 0))}</span>
            </label>
            {g.sections.map((s) => (
              <div key={s.key}>
                {s.name && (
                  <label className="flex items-center gap-3 min-h-8 pl-11 pr-6 border-b border-rowrule bg-white cursor-pointer">
                    <Check state={stateOf(s.lines)} onChange={() => toggleAll(ids(s.lines))} label={t('Select all of {g}', { g: s.name })} />
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted text-[13px]">{nLines(s.lines.length)}</span>
                  </label>
                )}
                {s.lines.map((p) => (
                  <label
                    key={p.lv_id}
                    className={cx(
                      'grid grid-cols-[16px_64px_minmax(0,1fr)_96px_52px_96px] items-center gap-x-3 min-h-8 pl-16 pr-6 border-b border-rowrule cursor-pointer hover:bg-panel',
                      sel.has(p.lv_id) && 'bg-sel',
                    )}
                  >
                    <Check state={sel.has(p.lv_id)} onChange={() => toggleAll([p.lv_id])} label={p.lv_id} />
                    <span className="font-mono text-[13px]">{p.lv_id}</span>
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={p.title_de}>
                        {lang === 'en' && p.title_en ? p.title_en : p.title_de}
                      </span>
                      {sugg.has(p.lv_id) && (
                        <span className="flex-none text-[12px]" style={{ color: C.accent }}>
                          {t('suggested')}
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[13px] text-right whitespace-nowrap">
                      {fmtQty(p.pricing?.quantity ?? p.quantity)} {fmtUnit(p.unit)}
                    </span>
                    <span className="font-mono text-[13px] text-muted">{t('p. {page}', { page: p.page })}</span>
                    <span className="font-mono text-[13px] text-right">{fmt2(direct(p))}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        ))}
        {tree.length === 0 && <div className="px-6 py-8 text-muted">{onlySel ? t('No line selected yet.') : t('No line matches the search.')}</div>}
      </div>
    </Dialog>
  )
}
