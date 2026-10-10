import { NavLink, Outlet, useLocation, useParams, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { setLang, useLang, useT } from '../i18n'
import { useApiMode } from '../api/client'
import { usePositions, useTender } from '../api/hooks'
import { ErrorBox, Loading, ProgressBar } from './ui'
import { cx } from '../lib/cx'
import { fmt0, fmtDateTime, fmtDaysLeft, shortTrade } from '../lib/format'
import { isOpen } from '../lib/lines'
import { AssistProvider } from '../assist/AssistContext'
import { AssistPill, AssistLayer } from '../assist/AssistLayer'

export function LangToggle() {
  const lang = useLang()
  const t = useT()
  return (
    <div role="group" aria-label={t('Language')} className="inline-flex text-[13px] text-muted gap-0.5">
      {(['en', 'de'] as const).map((l, i) => (
        <span key={l} className="inline-flex">
          {i > 0 && (
            <span aria-hidden="true" className="self-center">
              |
            </span>
          )}
          <button
            type="button"
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={cx('min-h-8 min-w-8 px-1.5 border-0 bg-transparent', lang === l ? 'text-ink font-semibold' : 'text-muted hover:text-ink')}
          >
            {l.toUpperCase()}
          </button>
        </span>
      ))}
    </div>
  )
}

function DemoBadge() {
  const mode = useApiMode()
  const t = useT()
  const qc = useQueryClient()
  if (mode !== 'mock') return null
  const reset = async () => {
    const m = await import('../api/mock')
    m.resetMockData()
    await qc.invalidateQueries()
  }
  return (
    <span className="inline-flex items-center gap-2 text-[12.5px] text-faint" title={t('The backend is not reachable. The app runs on built-in demo data.')}>
      <span>{t('Demo data')}</span>
      <button type="button" onClick={reset} className="min-h-8 px-1 border-0 bg-transparent underline underline-offset-2 text-faint hover:text-ink">
        {t('Reset')}
      </button>
    </span>
  )
}

const mainNav = [
  { to: '/', label: 'Tenders', end: true },
  { to: '/results', label: 'Results history' },
  { to: '/reference', label: 'Reference data' },
]

export function AppLayout() {
  const t = useT()
  const loc = useLocation()
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex flex-wrap items-center gap-x-7 gap-y-3 px-6 border-b border-rule">
        <Link to="/" className="font-semibold text-[15px] text-ink! no-underline py-3.5">
          ctrl-free
        </Link>
        <nav aria-label={t('Main')} className="flex gap-1 flex-auto">
          {mainNav.map((n) => {
            const on = n.end ? loc.pathname === '/' || loc.pathname === '/new' : loc.pathname.startsWith(n.to)
            return (
              <NavLink
                key={n.to}
                to={n.to}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'inline-flex items-center min-h-12 px-3 border-b-2 no-underline',
                  on ? 'border-accent text-ink! font-semibold' : 'border-transparent text-muted! hover:text-ink!',
                )}
              >
                {t(n.label)}
              </NavLink>
            )
          })}
        </nav>
        <DemoBadge />
        <LangToggle />
      </header>
      <Outlet />
    </div>
  )
}

export function TenderLayout() {
  const { id = '' } = useParams()
  return (
    <AssistProvider tenderId={id}>
      <TenderShell id={id} />
    </AssistProvider>
  )
}

function TenderShell({ id }: { id: string }) {
  const t = useT()
  const lang = useLang()
  const loc = useLocation()
  const tq = useTender(id)
  const tender = tq.data
  const ready = !!tender && tender.status !== 'reading'
  const pq = usePositions(id, ready)
  const toReview = pq.data ? pq.data.positions.filter(isOpen).length : (tender?.open_work?.lines_to_review ?? 0)
  const toConfirm = tender?.open_work?.instructions_to_confirm ?? 0
  const chosen = tender?.open_work?.price_chosen
  const base = `/t/${id}`
  const tabs = [
    { to: base, label: 'Overview', end: true },
    {
      to: `${base}/lines`,
      label: 'Lines',
      count: ready ? (toReview ? t('{n} to review', { n: toReview }) : t('done')) : null,
      attn: toReview > 0,
    },
    {
      to: `${base}/instructions`,
      label: 'Instructions & norms',
      count: ready ? (toConfirm ? t('{n} to confirm', { n: toConfirm }) : t('done')) : null,
      attn: toConfirm > 0,
    },
    {
      to: `${base}/pricing`,
      label: 'Pricing',
      count: ready ? (chosen ? 'CHF ' + fmt0(tender?.offer_price ?? null) : t('price not chosen')) : null,
      attn: !chosen,
    },
    { to: `${base}/export`, label: 'Export' },
    { to: `${base}/outcome`, label: 'Outcome' },
  ]
  const trade = shortTrade(tender?.trade ?? '')
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-rule">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-6 pt-3">
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2 flex-[1_1_520px] min-w-0">
            <Link to="/" className="font-semibold text-[15px] text-ink! no-underline">
              ctrl-free
            </Link>
            <nav aria-label={t('Breadcrumb')} className="text-[14px] text-muted min-w-0">
              <Link to="/" className="text-muted!">
                {t('Tenders')}
              </Link>{' '}
              /{' '}
              <span className="text-ink font-medium" aria-current="page">
                {tender ? `${tender.name} · ${trade}` : '…'}
              </span>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            {ready && <AssistPill />}
            {tender?.due_at && (
              <span className="text-[13px] text-muted">
                {t('Due')} <span className="font-mono">{fmtDateTime(tender.due_at)}</span> ·{' '}
                <span className="text-ink font-semibold">{fmtDaysLeft(tender.due_at, lang)}</span>
              </span>
            )}
            <DemoBadge />
            <LangToggle />
          </div>
        </div>
        <nav aria-label={t('Tender')} className="flex flex-wrap gap-1 px-3 pt-1">
          {tabs.map((tab) => {
            const on = tab.end ? loc.pathname === tab.to : loc.pathname.startsWith(tab.to)
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'inline-flex items-center gap-2 min-h-10 px-3 border-b-2 no-underline',
                  on ? 'border-accent text-ink! font-semibold' : 'border-transparent text-muted! hover:text-ink!',
                )}
              >
                {t(tab.label)}
                {tab.count && (
                  <span className={cx('font-mono text-[12.5px] font-normal', tab.attn ? 'text-attn' : 'text-muted')}>{tab.count}</span>
                )}
              </NavLink>
            )
          })}
        </nav>
      </header>
      <div className="relative">
        <AssistLayer />
      </div>
      {tq.isLoading ? (
        <Loading label={t('Loading')} />
      ) : tq.error ? (
        <ErrorBox error={tq.error} label={t('Could not load this tender.')} />
      ) : tender && tender.status === 'reading' ? (
        <ReadingState />
      ) : tender && tender.status === 'error' ? (
        <ErrorBox error={tender.error ?? tender.progress?.message} label={t('The PDF could not be read.')} />
      ) : (
        <Outlet />
      )}
    </div>
  )
}

function ReadingState() {
  const { id = '' } = useParams()
  const t = useT()
  const { data } = useTender(id)
  const p = data?.progress
  const frac = p?.pages ? (p.page ?? 0) / p.pages : 0
  return (
    <main className="max-w-[640px] px-6 py-12 flex flex-col gap-3">
      <h1 className="m-0 text-[24px] font-semibold">{t('Reading the tender')}</h1>
      <p className="m-0 text-muted">{t('The tender opens here as soon as every line has a first price. You can leave this page; reading goes on in the background.')}</p>
      <span className="flex items-center gap-2">
        <span className="w-2 h-2 bg-accent" aria-hidden="true" />
        {p?.stage === 'parsing' && p.page && p.pages ? t('Reading p. {page} of {pages}', { page: p.page, pages: p.pages }) : (p?.message ?? t('Reading'))}
      </span>
      <ProgressBar value={p?.stage === 'parsing' ? frac : p?.total ? (p.done ?? 0) / p.total : 1} label={t('Reading progress')} width={320} />
    </main>
  )
}
