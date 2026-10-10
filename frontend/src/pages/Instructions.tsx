// N06 Instructions & norms: tender rules quoted verbatim, with suggested impact and lines.
import { Link, useParams } from 'react-router-dom'
import { useT } from '../i18n'
import { useInstructions } from '../api/hooks'
import { ErrorBox, FilterTabs, LinkButton, Button, Loading } from '../components/ui'
import { cx } from '../lib/cx'
import { C } from '../lib/lines'
import { INS_TABS, impactOf, insQueue, sourceHint, useInsTab, type InsTab } from './instructionsShared'

const GRID = 'grid grid-cols-[200px_minmax(0,1fr)_56px_170px_110px_110px] gap-x-3.5'

export function Instructions() {
  const { id = '' } = useParams()
  const t = useT()
  const [tab, setTab] = useInsTab()
  const { data, isLoading, error } = useInstructions(id)
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the instructions.')} />
  const all = data.instructions
  const open = all.filter((i) => i.state === 'open')
  const count = (k: InsTab) => (k === 'open' ? open.length : k === 'all' ? all.length : all.filter((i) => i.kind === k).length)
  const rows = insQueue(all, tab)
  const allDone = tab === 'open' && open.length === 0 && all.length > 0
  const nOk = all.filter((i) => i.state === 'confirmed').length
  const nNr = all.filter((i) => i.state === 'not_relevant').length
  const labels: Record<InsTab, string> = { open: 'To confirm', all: 'All', cost: 'Adds cost', risk: 'Risk', scope: 'Scope', covered: 'Covered' }

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
          <section aria-label={t('Instructions')} className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className={cx(GRID, 'px-6 py-2 border-b border-rule text-[13px] text-muted font-medium')}>
                <span>{t("Type (tender's margin label)")}</span>
                <span>{t('Requirement (tender text)')}</span>
                <span>{t('Page')}</span>
                <span>{t('Applies to')}</span>
                <span>{t('Impact')}</span>
                <span>{t('Confirmed')}</span>
              </div>
              {rows.map((r) => {
                const [imp, color] = impactOf(r.kind, t)
                const isOpenRow = r.state === 'open'
                return (
                  <Link
                    key={r.id}
                    to={`/t/${id}/instructions/${r.id}?tab=${tab}`}
                    className={cx(GRID, 'items-center w-full min-h-10 px-6 py-1.5 border-b border-rowrule bg-white text-ink! no-underline hover:bg-panel')}
                  >
                    <span className="font-medium overflow-hidden text-ellipsis whitespace-nowrap">{r.type}</span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-body">{r.text_de}</span>
                    <span className="font-mono text-[13px] text-muted">{r.page}</span>
                    <span className="text-muted overflow-hidden text-ellipsis whitespace-nowrap">{r.applies_label || (r.applies_to ?? []).join(', ') || '–'}</span>
                    <span className="flex items-center gap-2">
                      <span className="flex-none w-2 h-2" style={{ background: color }} aria-hidden="true" />
                      {imp}
                    </span>
                    <span style={{ color: isOpenRow ? C.attn : C.muted }}>
                      {r.state === 'confirmed' ? t('Yes · {who}', { who: t(r.confirmed_by ?? 'You') }) : r.state === 'not_relevant' ? t('Not relevant') : t('To confirm')}
                    </span>
                  </Link>
                )
              })}
              {rows.length === 0 && <div className="px-6 py-8 text-muted">{t('Nothing in this tab.')}</div>}
              <div className="px-6 py-2.5 text-[13px] text-muted">{t('The requirement text is copied from the tender and cannot be edited. Click a row to open it.')}</div>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
