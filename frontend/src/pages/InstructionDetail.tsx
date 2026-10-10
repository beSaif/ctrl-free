// N06b Instruction detail: verbatim German, machine translation, suggested impact / lines / why,
// Confirm (Enter) / Change impact or lines / Not relevant / Undo, Previous K / Next J.
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { useInstructions, usePatchInstruction, useTender } from '../api/hooks'
import type { InstructionPatch } from '../api/types'
import { Button, ErrorBox, IconBack, Kbd, LinkButton, Loading, TextInput } from '../components/ui'
import { PdfCrop } from '../components/PdfCrop'
import { fmtShortDate } from '../lib/format'
import { C } from '../lib/lines'
import { IMPACT, impactOf, insQueue, useInsTab } from './instructionsShared'

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
  const patch = usePatchInstruction(id)
  const [editing, setEditing] = useState(false)
  const [kind, setKind] = useState('')
  const [applies, setApplies] = useState('')

  const all = data?.instructions ?? []
  const queue = insQueue(all, tab)
  const s = all.find((i) => i.id === iid)
  const qi = queue.findIndex((i) => i.id === iid)
  const prev = qi > 0 ? queue[qi - 1] : null
  const next = qi >= 0 && qi < queue.length - 1 ? queue[qi + 1] : null
  const go = (x: { id: string } | null) => x && nav(`/t/${id}/instructions/${x.id}?tab=${tab}`)

  const close = async (body: InstructionPatch) => {
    const rest = queue.filter((i) => i.id !== iid)
    const nxt = tab === 'open' ? (queue[qi + 1] ?? rest[0] ?? null) : null
    await patch.mutateAsync({ iid, body })
    if (tab === 'open') nav(nxt ? `/t/${id}/instructions/${nxt.id}?tab=${tab}` : `/t/${id}/instructions?tab=${tab}`)
  }

  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement
    if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || document.querySelector('[role="dialog"]')) return
    if (e.key === 'j' || e.key === 'J') go(next)
    else if (e.key === 'k' || e.key === 'K') go(prev)
    else if (e.key === 'Enter' && el.tagName !== 'BUTTON' && el.tagName !== 'A' && s?.state === 'open' && !patch.isPending) {
      e.preventDefault()
      void close({ state: 'confirmed' })
    }
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !s) return <ErrorBox error={error} label={t('This instruction was not found.')} />

  const open = s.state === 'open'
  const [imp, color] = impactOf(s.kind, t)
  const stateText = open ? t('To confirm') : s.state === 'confirmed' ? t('Confirmed by you') : t('Marked not relevant')
  const lines = s.applies_to ?? []
  const linesLink = lines.length === 1 ? `/t/${id}/lines/${lines[0]}?f=all` : lines.length ? `/t/${id}/lines?f=all&q=${encodeURIComponent(lines[0])}` : null
  const startEdit = () => {
    setKind(s.kind)
    setApplies(lines.join(', '))
    setEditing(true)
  }
  const saveEdit = async () => {
    await patch.mutateAsync({
      iid,
      body: {
        kind,
        applies_to: applies
          .split(/[,;\s]+/)
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
      },
    })
    setEditing(false)
  }

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 border-b border-rule">
        <LinkButton to={`/t/${id}/instructions?tab=${tab}`} size="sm" className="pl-2.5">
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
                  <h2 className="m-0 text-[15px] font-semibold">{t('Machine translation')}</h2>
                  <p className="m-0 text-body leading-[1.6]">{s.text_en}</p>
                </section>
              )}
            </div>

            <div className="flex-[1_1_440px] min-w-0 flex flex-col gap-5">
              <section className="flex flex-col gap-3">
                <h2 className="m-0 text-[15px] font-semibold">{open ? t('Suggested by ctrl-free') : t('Your decision')}</h2>
                {editing ? (
                  <div className="flex flex-col gap-3 py-3 border-t border-ink border-b border-b-rule">
                    <label className="flex flex-col gap-1 text-[13px] text-muted">
                      {t('Impact')}
                      <select value={kind} onChange={(e) => setKind(e.target.value)} className="min-h-9 px-2 border border-rule rounded-[2px] bg-white text-[14px] text-ink max-w-[240px]">
                        {Object.keys(IMPACT).map((k) => (
                          <option key={k} value={k}>
                            {t(IMPACT[k][0])}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[13px] text-muted">
                      {t('Applies to (line numbers, separated by commas)')}
                      <TextInput mono value={applies} onChange={(e) => setApplies(e.target.value)} placeholder="LV0006, LV0010" />
                    </label>
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={saveEdit} disabled={patch.isPending}>
                        {t('Save')}
                      </Button>
                      <Button size="sm" onClick={() => setEditing(false)}>
                        {t('Cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3.5 gap-y-2.5 py-3 border-t border-ink border-b border-b-rule">
                    <span className="text-muted">{t('Impact')}</span>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="w-2 h-2" style={{ background: color }} aria-hidden="true" />
                      {imp}
                    </span>
                    <span className="text-muted">{t('Applies to')}</span>
                    <span>
                      {s.applies_long || s.applies_label || lines.join(', ') || '–'} {linesLink && <Link to={linesLink}>{t('Open lines')}</Link>}
                    </span>
                    {s.why && (
                      <>
                        <span className="text-muted">{t('Why')}</span>
                        <span>{s.why}</span>
                      </>
                    )}
                  </div>
                )}
              </section>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {open ? (
                  <>
                    <Button variant="primary" onClick={() => close({ state: 'confirmed' })} disabled={patch.isPending}>
                      {t('Confirm')} <Kbd>Enter</Kbd>
                    </Button>
                    {!editing && <Button onClick={startEdit}>{t('Change impact or lines')}</Button>}
                    <Button onClick={() => close({ state: 'not_relevant' })} disabled={patch.isPending}>
                      {t('Not relevant')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="w-2 h-2 bg-ink" aria-hidden="true" />
                      {s.state === 'confirmed' ? t('Confirmed by you') : t('Marked not relevant')}
                      {s.confirmed_at ? ` · ${fmtShortDate(s.confirmed_at, lang)}` : ''}
                    </span>
                    <Button onClick={() => patch.mutate({ iid, body: { state: 'open' } })} disabled={patch.isPending}>
                      {t('Undo')}
                    </Button>
                    {!editing && <Button onClick={startEdit}>{t('Change impact or lines')}</Button>}
                  </>
                )}
              </div>
              <span className="text-[13px] text-muted">{t('"Impact" and "Applies to" are suggestions until you confirm them.')}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
