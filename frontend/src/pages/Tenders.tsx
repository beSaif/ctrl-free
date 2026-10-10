// N01 Tenders: tabs, search, table with due date, open work and offer price. Reading tenders poll.
import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useSearchParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { useTenders } from '../api/hooks'
import type { TenderSummary } from '../api/types'
import { ErrorBox, LinkButton, Loading, ProgressBar, SearchBox, Td, Th, UnderlineTabs } from '../components/ui'
import { daysUntil, fmt0, shortTrade, fmtDateTime, fmtDaysLeft, fmtUpdated } from '../lib/format'

type Tab = 'calc' | 'submitted' | 'awarded'
const tabOf = (s: TenderSummary): Tab => (s.status === 'submitted' ? 'submitted' : s.status === 'awarded' ? 'awarded' : 'calc')

export function Tenders() {
  const t = useT()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data, isLoading, error } = useTenders()
  const [tab, setTab] = useState<Tab>('calc')
  const [q, setQ] = useState('')
  const created = params.get('created')

  // A tender that was just created opens on its own once it is read.
  useEffect(() => {
    if (!created || !data) return
    const c = data.find((x) => x.id === created)
    if (c && c.status === 'ready') nav(`/t/${c.id}`)
    if (!c) setParams({}, { replace: true })
  }, [created, data, nav, setParams])

  const counts = useMemo(() => {
    const c = { calc: 0, submitted: 0, awarded: 0 }
    data?.forEach((x) => c[tabOf(x)]++)
    return c
  }, [data])

  const rows = (data ?? [])
    .filter((x) => tabOf(x) === tab)
    .filter((x) => !q.trim() || `${x.name} ${x.client} ${x.trade} ${x.file_name}`.toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <main className="p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <h1 className="m-0 text-[20px] font-semibold">{t('Tenders')}</h1>
        <UnderlineTabs
          label={t('Filter tenders')}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'calc', label: t('In calculation'), count: counts.calc },
            { key: 'submitted', label: t('Submitted'), count: counts.submitted },
            { key: 'awarded', label: t('Awarded'), count: counts.awarded },
          ]}
        />
        <div className="flex-auto" />
        <SearchBox value={q} onChange={setQ} label={t('Search tenders')} placeholder={t('Search tenders')} className="flex-[0_1_260px] min-h-9" />
        <LinkButton to="/new" variant="primary" size="sm">
          {t('New tender')}
        </LinkButton>
      </div>

      {isLoading ? (
        <Loading label={t('Loading')} />
      ) : error ? (
        <ErrorBox error={error} label={t('Could not load the tenders.')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse">
            <thead>
              <tr>
                <Th>{t('Tender')}</Th>
                <Th>{t('Client')}</Th>
                <Th>{t('Trade')}</Th>
                <Th>{t('Submission due')}</Th>
                <Th>{t('Open work')}</Th>
                <Th className="text-right whitespace-nowrap" title={'≈ ' + t('standard margin, not final')}>
                  {t('Offer price (CHF)')}
                </Th>
                <Th>{t('Updated')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <TenderRow key={x.id} x={x} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-muted">
                    {q ? t('No tender matches the search.') : tab === 'calc' ? t('No tender in calculation. Start with New tender.') : t('Nothing here yet.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {data?.filter((x) => x.status === 'reading').map((x) => x.progress?.message).join('. ')}
      </span>
      <Outlet />
    </main>
  )
}

function TenderRow({ x }: { x: TenderSummary }) {
  const t = useT()
  const lang = useLang()
  const reading = x.status === 'reading'
  const ow = x.open_work
  const p = x.progress
  const due = daysUntil(x.due_at)
  // open work after "lines to review", most important first; only the first one is orange
  const sub = [
    ow && ow.instructions_to_confirm
      ? { text: t('{n} instructions', { n: ow.instructions_to_confirm }), title: t('{n} instructions to confirm', { n: ow.instructions_to_confirm }) }
      : null,
    ow && !ow.price_chosen ? { text: t('price not chosen'), title: t('Choose the offer price under Pricing') } : null,
  ].filter((v): v is { text: string; title: string } => !!v)
  const rest = (xs: typeof sub) =>
    xs.length > 0 && (
      <div className="text-[13px] text-muted pl-4 whitespace-nowrap">
        {xs.map((v, i) => (
          <span key={v.text} title={v.title}>
            {i > 0 && ' · '}
            {v.text}
          </span>
        ))}
      </div>
    )
  return (
    <tr className="align-top">
      <Td>
        {reading ? (
          <span className="font-semibold text-muted">{x.name || t('Tender being read')}</span>
        ) : (
          <Link to={`/t/${x.id}`} className="text-ink! font-semibold">
            {x.name}
          </Link>
        )}
        <div className="text-[13px] text-muted">
          {x.file_name}
          {x.page_count ? ` · ${t('{n} pages', { n: x.page_count })}` : ''}
        </div>
      </Td>
      <Td className={reading && !x.client ? 'text-muted' : ''}>{x.client || t('Read from the tender')}</Td>
      <Td>{shortTrade(x.trade || '')}</Td>
      <Td>
        {x.due_at ? (
          <>
            <span className={due !== null && due < 0 ? 'font-semibold text-muted' : 'font-semibold'}>{fmtDaysLeft(x.due_at, lang)}</span>
            <div className="font-mono text-[13px] text-muted">{fmtDateTime(x.due_at)}</div>
          </>
        ) : (
          <span className="text-muted">{t('Read from the tender')}</span>
        )}
      </Td>
      <Td>
        {reading ? (
          <>
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 bg-accent" aria-hidden="true" />
              {p?.stage === 'parsing' && p.page && p.pages ? t('Reading p. {page} of {pages}', { page: p.page, pages: p.pages }) : (p?.message ?? t('Reading'))}
            </span>
            <div className="mt-1.5 ml-4">
              <ProgressBar
                value={p?.stage === 'parsing' && p.pages ? (p.page ?? 0) / p.pages : p?.total ? 0.6 + 0.4 * ((p.done ?? 0) / p.total) : 0.9}
                label={t('Reading progress')}
              />
            </div>
          </>
        ) : ow && ow.lines_total === 0 ? (
          <span className="flex items-center gap-2 text-attn">
            <span className="w-2 h-2 bg-attn" aria-hidden="true" />
            {t('No lines found in this PDF')}
          </span>
        ) : x.status === 'error' ? (
          <span className="text-attn">{t('Could not read the PDF')}</span>
        ) : x.status === 'submitted' || x.status === 'awarded' ? (
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-ink" aria-hidden="true" />
            {x.status === 'awarded' ? t('Awarded') : x.outcome ? t('Outcome recorded') : t('Submitted, awaiting award')}
          </span>
        ) : ow && ow.lines_to_review ? (
          <>
            <span className="flex items-center gap-2 text-attn">
              <span className="w-2 h-2 bg-attn" aria-hidden="true" />
              {ow.lines_to_review === 1 ? t('1 line to review') : t('{n} lines to review', { n: ow.lines_to_review })}
            </span>
            {rest(sub)}
          </>
        ) : sub.length ? (
          <>
            <span className="flex items-center gap-2 text-attn" title={sub[0].title}>
              <span className="w-2 h-2 bg-attn" aria-hidden="true" />
              {sub[0].title}
            </span>
            {rest(sub.slice(1))}
          </>
        ) : (
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-ink" aria-hidden="true" />
            {t('Ready to submit')}
          </span>
        )}
      </Td>
      <Td className="text-right">
        {reading ? (
          <span className="text-muted">{t('after reading')}</span>
        ) : x.offer_price && (x.offer_price_final ?? true) ? (
          <span className="font-mono font-medium">{fmt0(x.offer_price)}</span>
        ) : (
          // not chosen yet: the standard-margin price, marked as provisional
          <span className="font-mono text-muted" title={t('standard margin, not final')}>
            <span className="text-faint mr-1" aria-hidden="true">
              ≈
            </span>
            {fmt0(x.standard_price ?? x.offer_price)}
            <span className="sr-only"> ({t('standard margin, not final')})</span>
          </span>
        )}
      </Td>
      <Td className="text-muted">
        {fmtUpdated(x.updated_at, lang)} · {t(x.updated_by ?? 'You')}
      </Td>
    </tr>
  )
}
