// N06b Instruction detail: verbatim German (PDF crop) and machine translation beside the decision:
// impact (segmented), applies to (line picker), what confirming does; Confirm and next (Enter),
// Not relevant, Undo, Previous K / Next J, Esc back to the list.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { useInstructions, usePatchInstruction, usePositions, useTender } from '../api/hooks'
import type { Instruction, InstructionPatch, Position } from '../api/types'
import { Button, ErrorBox, IconBack, Kbd, LinkButton, Loading, SegmentedControl } from '../components/ui'
import { PdfCrop } from '../components/PdfCrop'
import { fmt2, fmtShortDate, translationLabel } from '../lib/format'
import { C, isOpen } from '../lib/lines'
import { IMPACT, insQueue, useInsTab } from './instructionsShared'
import { LinePicker } from './InstructionLinePicker'

const KINDS = Object.keys(IMPACT)
const KIND_HINT: Record<string, string> = {
  cost: 'Put in our price',
  risk: 'Costs if missed',
  scope: 'Sets the spec',
  covered: 'Already priced',
}
const SHOW = 5

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export function InstructionDetail() {
  const { iid = '' } = useParams()
  return <InstructionDetailView key={iid} />
}

function InstructionDetailView() {
  const { id = '', iid = '' } = useParams()
  const t = useT()
  const lang = useLang()
  const nav = useNavigate()
  const [tab] = useInsTab()
  const { data, isLoading, error } = useInstructions(id)
  const { data: tender } = useTender(id)
  const { data: pd } = usePositions(id)
  const patch = usePatchInstruction(id)
  // the decision is a draft until Confirm (or Save): impact and lines go in the same call
  const [kindDraft, setKindDraft] = useState<string | null>(null)
  const [linesDraft, setLinesDraft] = useState<string[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const closePicker = useCallback(() => setPicking(false), [])

  const all = useMemo(() => data?.instructions ?? [], [data])
  const queue = insQueue(all, tab)
  const s = all.find((i) => i.id === iid)
  const qi = queue.findIndex((i) => i.id === iid)
  const prev = qi > 0 ? queue[qi - 1] : null
  const next = qi >= 0 && qi < queue.length - 1 ? queue[qi + 1] : null
  const go = (x: { id: string } | null) => x && nav(`/t/${id}/instructions/${x.id}?tab=${tab}`)
  const backTo = `/t/${id}/instructions?tab=${tab}&sel=${iid}`
  const byLv = useMemo(() => new Map((pd?.positions ?? []).map((p) => [p.lv_id, p])), [pd])

  const kind = kindDraft ?? s?.kind ?? ''
  const applies = linesDraft ?? s?.applies_to ?? []
  const suggested = s?.suggested_applies_to ?? s?.applies_to ?? []
  const dirty = !!s && (kind !== s.kind || !sameSet(applies, s.applies_to ?? []))

  // the next instruction still to confirm after this one (wrapping), so "Confirm and next" never lands on a done one
  const nextOpen = (() => {
    const after = [...queue.slice(qi + 1), ...queue.slice(0, Math.max(qi, 0))]
    return after.find((i) => i.id !== iid && i.state === 'open') ?? null
  })()

  const body = (extra: InstructionPatch = {}): InstructionPatch => ({
    ...(s && kind !== s.kind ? { kind } : {}),
    ...(s && !sameSet(applies, s.applies_to ?? []) ? { applies_to: applies } : {}),
    ...extra,
  })
  const decide = async (state: 'confirmed' | 'not_relevant') => {
    if (patch.isPending) return
    try {
      await patch.mutateAsync({ iid, body: body({ state }) })
    } catch {
      return /* shown under the buttons */
    }
    nav(nextOpen ? `/t/${id}/instructions/${nextOpen.id}?tab=${tab}` : backTo)
  }
  const save = async () => {
    await patch.mutateAsync({ iid, body: body() }).catch(() => undefined)
    setKindDraft(null)
    setLinesDraft(null)
  }

  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement
    if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || document.querySelector('[role="dialog"]')) return
    if (e.key === 'j' || e.key === 'J') go(next)
    else if (e.key === 'k' || e.key === 'K') go(prev)
    else if (e.key === 'Escape') nav(backTo)
    else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault() // the picker focuses its search box; the L must not land in it
      setPicking(true)
    }
    else if (/^[1-4]$/.test(e.key) && KINDS[+e.key - 1]) setKindDraft(KINDS[+e.key - 1])
    else if (e.key === 'Enter' && !e.repeat && el.tagName !== 'BUTTON' && el.tagName !== 'A' && s?.state === 'open') {
      e.preventDefault()
      void decide('confirmed')
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !s) return <ErrorBox error={error} label={t('This instruction was not found.')} />

  const open = s.state === 'open'
  const stateText = open ? t('To confirm') : s.state === 'confirmed' ? t('Confirmed by you') : t('Marked not relevant')
  const lines = applies.map((x) => byLv.get(x)).filter((p): p is Position => !!p)
  const sumDirect = lines.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0)
  const linesChanged = !sameSet(applies, suggested)
  const shown = showAll ? lines : lines.slice(0, SHOW)
  const kindOptions = KINDS.map((k) => ({
    value: k,
    label: (
      <span className="flex items-center gap-2">
        <span className="w-2 h-2" style={{ background: k === kind ? '#fff' : IMPACT[k][1] }} aria-hidden="true" />
        {t(IMPACT[k][0])}
      </span>
    ),
    hint: t(KIND_HINT[k]) + (k === (s.suggested_kind ?? s.kind) && k !== kind ? ' · ' + t('suggested') : ''),
  }))

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 border-b border-rule">
        <LinkButton to={backTo} size="sm" className="pl-2.5">
          <IconBack />
          {t('All instructions')}
        </LinkButton>
        <span className="flex-auto" />
        <span className="text-[13px] text-muted">
          {qi >= 0 ? t('{label} {i} of {n}', { label: tab === 'open' ? t('To confirm') : t('Instruction'), i: qi + 1, n: queue.length }) : ''}
        </span>
        <Button size="sm" onClick={() => go(prev)} disabled={!prev}>
          {t('Previous')} <Kbd>K</Kbd>
        </Button>
        <Button size="sm" onClick={() => go(next)} disabled={!next}>
          {t('Next')} <Kbd>J</Kbd>
        </Button>
      </div>

      <main className="flex-auto flex justify-center px-6 pt-7 pb-12">
        <div className="w-full max-w-[1240px] flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] text-muted">
              {t('p. {page}', { page: s.page })}
              {s.section ? ` · ${s.section}` : ''}
            </span>
            <h1 className="m-0 text-[26px] leading-[1.25] font-semibold">{s.type}</h1>
            <span className="flex items-center gap-2" style={{ color: open ? C.attn : C.ink }}>
              <span className="w-2 h-2" style={{ background: open ? C.attn : C.ink }} aria-hidden="true" />
              {stateText}
            </span>
          </div>

          <div className="flex flex-wrap items-start gap-x-10 gap-y-7">
            <div className="flex-[1_1_480px] min-w-0 flex flex-col gap-6">
              <PdfCrop
                tenderId={id}
                pageCount={tender?.page_count}
                source={{
                  page: s.page,
                  page_size: s.page_size ?? [595, 842],
                  block_bbox: s.bbox ?? null,
                  lines: s.bbox ? [{ text: s.text_de, bbox: s.bbox, role: 'qty' }] : [],
                }}
                fallback={
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12.5px] font-semibold">{s.type}</span>
                    <span className="text-[14px] leading-[1.65] bg-hl px-1 py-0.5">{s.text_de}</span>
                  </div>
                }
                caption={t('Copied word for word from p. {page}, margin label "{type}".', { page: s.page, type: s.type })}
              />
              {s.text_en && (
                <section className="flex flex-col gap-1.5">
                  <h2 className="m-0 text-[15px] font-semibold">{t(translationLabel(s.text_en_method))}</h2>
                  <p className="m-0 text-body leading-[1.6]">{s.text_en}</p>
                </section>
              )}
            </div>

            <div className="flex-[1_1_440px] min-w-0 flex flex-col gap-5">
              <section className="flex flex-col gap-2">
                <div className="flex justify-between items-baseline gap-3">
                  <h2 className="m-0 text-[15px] font-semibold">{open ? t('Your decision') : t('Decided')}</h2>
                  <span className="text-[13px] text-muted">{open ? t('Suggested by ctrl-free, change what is wrong') : ''}</span>
                </div>
                <div className="flex flex-col gap-4 py-4 border-t border-ink border-b border-b-rule">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-muted">{t('Impact')}</span>
                    <SegmentedControl label={t('Impact')} options={kindOptions} value={kind} onChange={(k) => setKindDraft(k)} />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[13px] text-muted">{t('Applies to')}</span>
                      <span className="font-medium">
                        {lines.length ? (lines.length === 1 ? t('1 line') : t('{n} lines', { n: lines.length })) : t('Whole installation')}
                      </span>
                      {lines.length > 0 && <span className="font-mono text-[13px]">CHF {fmt2(sumDirect)}</span>}
                      <span className="flex-auto" />
                      <Button size="sm" onClick={() => setPicking(true)}>
                        {t('Choose lines')} <Kbd>L</Kbd>
                      </Button>
                    </div>
                    {lines.length > 0 && (
                      <div className="flex flex-col">
                        {shown.map((p) => (
                          <Link
                            key={p.lv_id}
                            to={`/t/${id}/lines/${p.lv_id}?f=all`}
                            className="grid grid-cols-[60px_minmax(0,1fr)_52px_92px] gap-x-3 items-center min-h-8 border-b border-rowrule text-ink! no-underline hover:bg-panel"
                          >
                            <span className="font-mono text-[13px]">{p.lv_id}</span>
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap" title={p.title_de}>
                              {lang === 'en' && p.title_en ? p.title_en : p.title_de}
                            </span>
                            <span className="font-mono text-[13px] text-muted">{t('p. {page}', { page: p.page })}</span>
                            <span className="font-mono text-[13px] text-right">{fmt2(p.pricing?.direct ?? 0)}</span>
                          </Link>
                        ))}
                        {lines.length > SHOW && (
                          <button type="button" onClick={() => setShowAll((v) => !v)} className="self-start min-h-8 px-0 border-0 bg-transparent text-[13px] text-accent underline underline-offset-2">
                            {showAll ? t('Show fewer') : t('Show all {n}', { n: lines.length })}
                          </button>
                        )}
                      </div>
                    )}
                    {linesChanged && (
                      <span className="text-[13px] text-muted">
                        {t('Changed from the suggestion ({n} lines).', { n: suggested.length })}{' '}
                        <button type="button" onClick={() => setLinesDraft(suggested)} className="p-0 border-0 bg-transparent text-accent underline underline-offset-2">
                          {t('Back to the suggestion')}
                        </button>
                      </span>
                    )}
                  </div>

                  {s.why && (
                    <div className="flex flex-col gap-1">
                      <span className="text-[13px] text-muted">{t('Why')}</span>
                      <span>{s.why}</span>
                    </div>
                  )}

                  <div className="flex flex-col gap-1 px-3 py-2.5 bg-panel">
                    <span className="text-[13px] font-semibold">{open ? t('What confirming does') : t('What this decision does')}</span>
                    <span className="text-[13.5px] leading-[1.55]">{effect(kind, lines, sumDirect, t)}</span>
                  </div>
                </div>
              </section>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {open ? (
                  <>
                    <Button variant="primary" onClick={() => decide('confirmed')} disabled={patch.isPending}>
                      {nextOpen ? t('Confirm and next') : t('Confirm')} <Kbd>Enter</Kbd>
                    </Button>
                    <Button onClick={() => decide('not_relevant')} disabled={patch.isPending}>
                      {t('Not relevant')}
                    </Button>
                    {dirty && (
                      <Button variant="link" onClick={save} disabled={patch.isPending}>
                        {t('Save without confirming')}
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="w-2 h-2 bg-ink" aria-hidden="true" />
                      {s.state === 'confirmed' ? t('Confirmed by you') : t('Marked not relevant')}
                      {s.confirmed_at ? ` · ${fmtShortDate(s.confirmed_at, lang)}` : ''}
                    </span>
                    {dirty && (
                      <Button variant="primary" onClick={save} disabled={patch.isPending}>
                        {t('Save changes')}
                      </Button>
                    )}
                    <Button onClick={() => patch.mutate({ iid, body: { state: 'open' } })} disabled={patch.isPending}>
                      {t('Undo')}
                    </Button>
                    {nextOpen && <LinkButton to={`/t/${id}/instructions/${nextOpen.id}?tab=${tab}`}>{t('Next to confirm')}</LinkButton>}
                  </>
                )}
              </div>
              {patch.error && <span className="text-[13px]" style={{ color: C.attn }}>{t('Could not save.')}</span>}
              <span className="text-[13px] text-muted">
                {dirty ? t('Your changes are saved when you confirm.') : t('"Impact" and "Applies to" are suggestions until you confirm them.')}{' '}
                <span className="hidden lg:inline">{t('Keys: Enter confirm and next, 1 to 4 impact, L lines, J/K next/previous, Esc back to the list.')}</span>
              </span>
            </div>
          </div>
        </div>
      </main>

      <LinePicker
        open={picking}
        onClose={closePicker}
        positions={pd?.positions ?? []}
        families={data?.families ?? []}
        selected={applies}
        suggested={suggested}
        onApply={(ids) => {
          setLinesDraft(ids)
          setShowAll(false)
          setPicking(false)
        }}
      />
    </div>
  )
}

/** Plain words for what the decision changes. Instructions never change a price by themselves. */
function effect(kind: Instruction['kind'], lines: Position[], sumDirect: number, t: T): string {
  const n = lines.length
  const open = lines.filter(isOpen).length
  const parts = [t('No price changes by itself.')]
  if (kind === 'cost')
    parts.push(
      n
        ? t('It records that the price of these {n} lines (CHF {d} today) must include this.', { n, d: fmt2(sumDirect) })
        : t('It records that the offer must include this; check Pricing covers it.'),
    )
  else if (kind === 'covered') parts.push(t('It records that the current price already covers this.'))
  else if (kind === 'risk') parts.push(t('It records a risk to weigh when you choose the margin.'))
  else parts.push(n ? t('It records what these {n} lines must meet.', { n }) : t('It records a requirement for the whole installation.'))
  if (open) parts.push(t(open === 1 ? '1 of them is still open in Lines.' : '{n} of them are still open in Lines.', { n: open }))
  if (n) parts.push(t('Each line shows this rule.'))
  parts.push(t('The export checklist counts it as done.'))
  return parts.join(' ')
}
