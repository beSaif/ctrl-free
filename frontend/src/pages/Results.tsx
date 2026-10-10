// N10 Results history: every submitted offer next to its award.
import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { useResults } from '../api/hooks'
import { ErrorBox, Loading, Td, Th } from '../components/ui'
import { fmt0, fmtSigned, shortTrade } from '../lib/format'
import { C } from '../lib/lines'
import { COMPETITION, callLabel } from '../lib/pricing'

export function Results() {
  const t = useT()
  const { data, isLoading, error } = useResults()
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the results.')} />
  const rows = data.rows
  const recorded = data.recorded ?? rows.filter((r) => r.winning_price).length
  const stats = data.stats && recorded >= 3 ? data.stats : null
  const cards: [string, string, string][] = [
    ['competition_calls', 'Competition calls', 'How often "Strong" meant many bidders'],
    ['gap_by_trade', 'Gap to the winning price', 'Average gap in % by trade'],
    ['win_rate_by_option', 'Win rate by option', 'Aggressive, Target, Standard, Conservative'],
  ]
  const statLine = (k: string, r: Record<string, unknown>): string => {
    if (k === 'competition_calls') return `${t(String(r.call ?? '?'))}: ${r.avg_bidders ?? '–'} ${t('bidders on average')} (${r.tenders})`
    if (k === 'gap_by_trade') return `${shortTrade(String(r.trade ?? '?'))}: ${fmtSigned(Number(r.avg_gap_pct ?? 0), 1)}% (${r.tenders})`
    return `${t(String(r.option ?? '?'))}: ${t('{a} of {b} won', { a: String(r.won ?? 0), b: String(r.tenders ?? 0) })}`
  }
  return (
    <main className="p-6 flex flex-col gap-6">
      <h1 className="m-0 text-[20px] font-semibold">{t('Results history')}</h1>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse">
          <thead>
            <tr>
              <Th>{t('Tender')}</Th>
              <Th>{t('Trade')}</Th>
              <Th className="text-right">{t('Our offer')}</Th>
              <Th className="text-right">{t('Winning price')}</Th>
              <Th className="text-right">{t('Gap')}</Th>
              <Th className="text-right">{t('Bidders')}</Th>
              <Th>{t('Your competition call')}</Th>
              <Th>{t('Result')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const call = typeof r.competition_call === 'number' ? callLabel(COMPETITION, r.competition_call) : r.competition_call
              const awaiting = !r.result
              return (
                <tr key={r.tender_id}>
                  <Td>
                    <Link to={`/t/${r.tender_id}/outcome`} className="text-ink! font-semibold">
                      {r.name}
                    </Link>
                  </Td>
                  <Td>{shortTrade(r.trade)}</Td>
                  <Td className="text-right font-mono">{fmt0(r.offer_price)}</Td>
                  <Td className="text-right font-mono">{r.winning_price ? fmt0(r.winning_price) : <span className="text-faint">–</span>}</Td>
                  <Td className="text-right font-mono">{r.gap_pct != null ? fmtSigned(r.gap_pct, 1) + '%' : <span className="text-faint">–</span>}</Td>
                  <Td className="text-right font-mono">{r.bidders ?? <span className="text-faint">–</span>}</Td>
                  <Td>{call ? t(String(call)) : '–'}</Td>
                  <Td>
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2" style={{ background: awaiting ? C.accent : r.result === 'won' ? C.ink : C.muted }} aria-hidden="true" />
                      {awaiting ? t('Awaiting award') : r.result === 'won' ? t('Won') : t('Lost')}
                    </span>
                    {awaiting && (
                      <>
                        {' · '}
                        <Link to={`/t/${r.tender_id}/outcome`}>{t('Record outcome')}</Link>
                      </>
                    )}
                  </Td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-muted">
                  {t('No submitted offers yet. When you mark a tender as submitted in Export, it shows here.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="flex flex-col gap-2.5 max-w-[760px]">
        <h2 className="m-0 text-[15px] font-semibold">{t('What you learn here')}</h2>
        <div className="flex flex-wrap gap-4">
          {cards.map(([k, title, ph]) => {
            const v = stats?.[k]
            return (
              <div key={k} className={`flex-[1_1_220px] min-h-24 p-3.5 flex flex-col gap-1 border ${v ? 'border-rule' : 'border-dashed border-stone'}`}>
                <span className="font-medium">{t(title)}</span>
                {Array.isArray(v) ? (
                  (v as Record<string, unknown>[]).map((r, i) => (
                    <span key={i} className="text-[13px]">
                      {statLine(k, r)}
                    </span>
                  ))
                ) : (
                  <span className="text-[13px] text-muted">{t(ph)}</span>
                )}
              </div>
            )
          })}
        </div>
        <span className="text-[13px] text-muted" title={t("The numbers come from the award notice you copy into the tender's Outcome tab.")}>
          {recorded === 1 ? t('1 award recorded so far.') : t('{n} awards recorded so far.', { n: recorded })}
          {!stats && ' ' + t('The cards fill in once 3 are recorded.')}
        </span>
      </section>
    </main>
  )
}
