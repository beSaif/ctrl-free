// N06 Instructions & norms: tender rules quoted verbatim, with suggested impact and lines.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useT } from '../i18n'
import { useInstructions } from '../api/hooks'
import { ErrorBox, FilterTabs, IconCheck, LinkButton, Button, Loading } from '../components/ui'
import { cx } from '../lib/cx'
import { C } from '../lib/lines'
import { INS_TABS, impactOf, insQueue, sourceHint, useInsTab, type InsTab } from './instructionsShared'

const GRID = 'grid grid-cols-[200px_minmax(0,1fr)_56px_170px_110px_110px] gap-x-3.5'
// in "To confirm" every row is open, so the Confirmed column would only repeat the tab
const GRID_OPEN = 'grid grid-cols-[200px_minmax(0,1fr)_56px_170px_110px] gap-x-3.5'

export function Instructions() {
  const { id = '' } = useParams()
  const t = useT()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [tab, setTab] = useInsTab()
  const { data, isLoading, error } = useInstructions(id)
  // coming back from a detail keeps the place in the list (?sel=); J / K move, Enter opens
  const [sel, setSel] = useState<string | null>(params.get('sel'))
  const rowRefs = useRef<Record<string, HTMLAnchorElement | null>>({})
  const rows = useMemo(() => insQueue(data?.instructions ?? [], tab), [data, tab])
  useEffect(() => {
    if (sel) rowRefs.current[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel, rows])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable) return
      if (document.querySelector('[role="dialog"]') || !rows.length) return
      const i = rows.findIndex((r) => r.id === sel)
      if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const n = rows[e.key.toLowerCase() === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]
        setSel(n.id)
        rowRefs.current[n.id]?.focus()
      } else if (e.key === 'Enter' && !e.repeat && sel && el.tagName !== 'A' && el.tagName !== 'BUTTON') {
        nav(`/t/${id}/instructions/${sel}?tab=${tab}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, sel, nav, id, tab])
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the instructions.')} />
  const all = data.instructions
  const open = all.filter((i) => i.state === 'open')
  const count = (k: InsTab) => (k === 'open' ? open.length : k === 'all' ? all.length : all.filter((i) => i.kind === k).length)
  const allDone = tab === 'open' && open.length === 0 && all.length > 0
  const nOk = all.filter((i) => i.state === 'confirmed').length
  const nNr = all.filter((i) => i.state === 'not_relevant').length
  const labels: Record<InsTab, string> = { open: 'To confirm', all: 'All', cost: 'Adds cost', risk: 'Risk', scope: 'Scope', covered: 'Covered' }
  const grid = tab === 'open' ? GRID_OPEN : GRID

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 px-6 py-2.5 border-b border-rule">
        <FilterTabs label={t('Filter instructions')} value={tab} onChange={setTab} items={INS_TABS.map((k) => ({ key: k, label: t(labels[k]), count: count(k) }))} />
        <div className="flex-[1_1_200px]" />
        <span className="text-[13px] text-muted">{sourceHint(all, t)}</span>
      </div>
      <main className="flex-auto">
        {allDone ? (
          <div className="max-w-[640px] px-6 py-12 flex flex-col gap-3">
            <h1 className="m-0 text-[24px] font-semibold">{t('All instructions handled')}</h1>
            <p className="m-0 text-muted">
              {nNr
                ? t('{a} confirmed, {b} marked not relevant. They go into the pricing report.', { a: nOk, b: nNr })
                : t('{a} confirmed. They go into the pricing report.', { a: nOk })}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <LinkButton to={`/t/${id}/pricing`} variant="primary">
                {t('Continue to pricing')}
              </LinkButton>
              <Button onClick={() => setTab('all')}>{t('See all {n}', { n: all.length })}</Button>
            </div>
          </div>
        ) : (
          <section aria-label={t('Instructions')} title={t('Keys: J next, K previous, Enter opens.')} className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className={cx(grid, 'px-6 py-2 border-b border-rule text-[13px] text-muted font-medium')}>
                <span title={t("Type (tender's margin label)")}>{t('Type')}</span>
                <span title={t('The requirement text is copied from the tender and cannot be edited.')}>{t('Requirement (tender text)')}</span>
                <span>{t('Page')}</span>
                <span>{t('Applies to')}</span>
                <span>{t('Impact')}</span>
                {tab !== 'open' && <span>{t('Confirmed')}</span>}
              </div>
              {rows.map((r) => {
                const [imp, color] = impactOf(r.kind, t)
                // only cost and risk draw the eye; scope and covered are information
                const loud = r.kind === 'cost' || r.kind === 'risk'
                return (
                  <Link
                    key={r.id}
                    ref={(el) => {
                      rowRefs.current[r.id] = el
                    }}
                    to={`/t/${id}/instructions/${r.id}?tab=${tab}`}
                    aria-current={r.id === sel ? 'true' : undefined}
                    className={cx(grid, 'items-center w-full min-h-10 px-6 py-1.5 border-b border-rowrule bg-white text-ink! no-underline hover:bg-panel', r.id === sel && 'row-selected')}
                  >
                    <span className="font-medium overflow-hidden text-ellipsis whitespace-nowrap">{r.type}</span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-body">{r.text_de}</span>
                    <span className="font-mono text-[13px] text-muted">{r.page}</span>
                    <span className="text-muted overflow-hidden text-ellipsis whitespace-nowrap">{r.applies_label || (r.applies_to ?? []).join(', ') || '–'}</span>
                    <span className={cx('flex items-center gap-2', !loud && 'text-muted')}>
                      <span className="flex-none w-2 h-2" style={{ background: color }} aria-hidden="true" />
                      {imp}
                    </span>
                    {tab !== 'open' &&
                      (r.state === 'confirmed' ? (
                        <span className="text-muted" title={t('Yes · {who}', { who: t(r.confirmed_by ?? 'You') })}>
                          <IconCheck />
                          <span className="sr-only">{t('Yes · {who}', { who: t(r.confirmed_by ?? 'You') })}</span>
                        </span>
                      ) : r.state === 'not_relevant' ? (
                        <span className="text-muted">{t('Not relevant')}</span>
                      ) : (
                        <span style={{ color: C.attn }}>{t('To confirm')}</span>
                      ))}
                  </Link>
                )
              })}
              {rows.length === 0 && <div className="px-6 py-8 text-muted">{t('Nothing in this tab.')}</div>}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
