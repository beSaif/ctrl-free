import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useParams, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { setLang, useLang, useT } from '../i18n'
import { setActor, useActor, useApiMode } from '../api/client'
import { usePeople, usePositions, useTender } from '../api/hooks'
import { ErrorBox, Loading, ProgressBar } from './ui'
import { cx } from '../lib/cx'
import { fmt0, fmtDateTime, fmtDaysLeft, shortTrade } from '../lib/format'
import { isOpen } from '../lib/lines'
import { AssistProvider } from '../assist/AssistContext'
import { AssistPill, AssistLayer } from '../assist/AssistLayer'
import { THEMES, setTheme, useTheme } from '../theme'

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

/** ctrl-free's own look or the Equans brand style; nothing else changes. */
export function ThemeToggle() {
  const theme = useTheme()
  const t = useT()
  return (
    <div role="group" aria-label={t('Style')} className="inline-flex text-[13px] text-muted gap-0.5">
      {THEMES.map((x, i) => (
        <span key={x.id} className="inline-flex">
          {i > 0 && (
            <span aria-hidden="true" className="self-center">
              |
            </span>
          )}
          <button
            type="button"
            aria-pressed={theme === x.id}
            onClick={() => setTheme(x.id)}
            className={cx('min-h-8 px-1.5 border-0 bg-transparent', theme === x.id ? 'text-ink font-semibold' : 'text-muted hover:text-ink')}
          >
            {x.label}
          </button>
        </span>
      ))}
    </div>
  )
}

/** The product name; in the Equans style the Equans logo comes first. */
function Brand({ className }: { className?: string }) {
  const theme = useTheme()
  return (
    <Link to="/" className={cx('inline-flex items-center gap-2.5 font-semibold text-[15px] text-ink! no-underline whitespace-nowrap', className)}>
      {theme === 'equans' && (
        <>
          <img src="/brand/equans-logo-on-dark.png" alt="Equans" className="h-[22px] w-auto" />
          <span aria-hidden="true" className="self-stretch w-px bg-rule" />
        </>
      )}
      ctrl-free
    </Link>
  )
}

/** Who is working (demo identity, no login): every change is stamped with this person's name.
 *  One menu for the person, the language and (offline) the demo data, so the header stays one line. */
export function PersonMenu() {
  const t = useT()
  const lang = useLang()
  const mode = useApiMode()
  const qc = useQueryClient()
  const actor = useActor()
  const { data: people } = usePeople()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const me = people?.find((p) => p.id === actor)

  useEffect(() => {
    if (!open) return
    pop.current?.querySelector<HTMLElement>('input:checked, button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      btn.current?.focus()
    }
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const change = (id: string) => {
    setActor(id)
    void qc.invalidateQueries()
    setOpen(false)
    btn.current?.focus()
  }
  const reset = async () => {
    const m = await import('../api/mock')
    m.resetMockData()
    await qc.invalidateQueries()
    setOpen(false)
  }
  const name = me?.name ?? (people?.length ? t('Choose a person') : t('Language'))

  return (
    <div ref={wrap} className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title={me ? t('Working as {name} · {role}', { name: me.name, role: t(me.role_label) }) : undefined}
        className="inline-flex items-center gap-1.5 min-h-8 px-2 border border-transparent rounded-[2px] bg-transparent text-[13px] text-ink hover:border-rule"
      >
        <span className="font-medium">{name}</span>
        <span className="text-faint">
          {mode === 'mock' && t('Demo') + ' · '}
          {lang.toUpperCase()}
        </span>
        <span aria-hidden="true" className="text-[10px] text-muted">
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={pop}
          role="dialog"
          aria-label={t('Person, language and style')}
          className="absolute right-0 top-full mt-1 z-40 w-[300px] bg-white border border-ink flex flex-col text-[13px] text-ink"
        >
          {!!people?.length && (
            <fieldset className="m-0 px-3.5 py-2.5 border-0 border-b border-rule flex flex-col gap-0.5">
              <legend className="float-left mb-1 text-[12px] text-muted">{t('Working as')}</legend>
              {people.map((p) => (
                <label key={p.id} className="clear-left grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 items-center py-1 cursor-pointer hover:text-accent">
                  <input type="radio" name="person" checked={p.id === actor} onChange={() => change(p.id)} className="accent-accent" />
                  <span className={cx(p.id === actor && 'font-semibold')}>{p.name}</span>
                  <span className="col-start-2 text-[12px] text-muted">{t(p.role_label)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex items-center justify-between gap-3 px-3.5 py-1.5">
            <span className="text-muted">{t('Language')}</span>
            <LangToggle />
          </div>
          <div className="flex items-center justify-between gap-3 px-3.5 py-1.5 border-t border-rule">
            <span className="text-muted">{t('Style')}</span>
            <ThemeToggle />
          </div>
          {mode === 'mock' && (
            <div className="flex flex-col gap-1 px-3.5 py-2.5 border-t border-rule">
              <span className="text-muted">{t('The backend is not reachable. The app runs on built-in demo data.')}</span>
              <button type="button" onClick={reset} className="self-start min-h-8 p-0 border-0 bg-transparent text-accent underline underline-offset-2 hover:text-accent-hover">
                {t('Reset the demo data')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
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
      <header className="cf-header flex flex-wrap items-center gap-x-7 gap-y-3 px-6 border-b border-rule">
        <Brand className="py-3.5" />
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
        <PersonMenu />
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
  const rt = tender?.review_trail
  const toApprove = rt ? rt.to_review + rt.ai_to_review : 0
  const base = `/t/${id}`
  // tab marks show only open work: a plain count in attn, nothing when done
  const work = (n: number) => (ready && n > 0 ? { count: String(n), attn: true } : {})
  const submitted = tender?.status === 'submitted' || tender?.status === 'awarded'
  type Tab = { to: string; label: string; end?: boolean; count?: string; attn?: boolean; dot?: string }
  const tabs: Tab[] = [
    { to: base, label: 'Overview', end: true },
    { to: `${base}/instructions`, label: 'Instructions & norms', ...work(toConfirm) },
    { to: `${base}/lines`, label: 'Lines', ...work(toReview) },
    {
      to: `${base}/pricing`,
      label: 'Pricing',
      ...(!ready ? {} : chosen ? { count: 'CHF ' + fmt0(tender?.offer_price ?? null) } : { dot: t('price not chosen') }),
    },
    { to: `${base}/pdf`, label: 'Tender PDF' },
    { to: `${base}/changes`, label: 'Changes', ...work(rt ? toApprove : 0) },
    { to: `${base}/export`, label: 'Export' },
    // Outcome only once there is something to record; the route works before that too
    ...(submitted || loc.pathname.startsWith(`${base}/outcome`) ? [{ to: `${base}/outcome`, label: 'Outcome' }] : []),
  ]
  const trade = shortTrade(tender?.trade ?? '')
  return (
    <div className="min-h-screen flex flex-col">
      <header className="cf-header border-b border-rule">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-6 pt-3">
          <div className="flex items-baseline gap-x-3.5 flex-[1_1_380px] min-w-0">
            <Brand className="self-center" />
            <nav aria-label={t('Breadcrumb')} className="text-[14px] text-muted min-w-0 truncate" title={tender ? `${tender.name} · ${trade}` : undefined}>
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
              <span className="text-[13px] font-semibold" title={`${t('Due')} ${fmtDateTime(tender.due_at)}`}>
                {fmtDaysLeft(tender.due_at, lang).replace(/^./, (c) => c.toUpperCase())}
              </span>
            )}
            <PersonMenu />
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
                {tab.dot && (
                  <span role="img" aria-label={tab.dot} title={tab.dot} className="w-1.5 h-1.5 rounded-full bg-attn" />
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
