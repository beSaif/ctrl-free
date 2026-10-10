import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { usePositions, usePricing } from '../api/hooks'
import { fmt0, fmt2 } from '../lib/format'
import { wasChanged } from '../lib/lines'
import { AssistBarButton } from '../assist/AssistLayer'
import { Source, SrcFoot, SrcRows } from './Source'

/** Sticky totals bar on the line screens. Always reflects the server totals.
 *  Direct cost and the price stay in view; the breakdown opens from the Direct figure. */
export function FooterTotals({ tenderId }: { tenderId: string }) {
  const t = useT()
  const { data, isFetching } = usePricing(tenderId)
  const { data: pos } = usePositions(tenderId)
  const tot = data?.totals
  const changed = pos?.positions.filter(wasChanged).length ?? 0
  const chosen = data?.settings.chosen
  const offer = chosen ? tot?.scenarios.find((s) => s.name === chosen)?.bid : null
  return (
    <footer
      aria-label={t('Totals')}
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3 border-t border-ink bg-white text-[14px]"
    >
      <AssistBarButton />
      <Source
        className=""
        width={380}
        title={t('Totals')}
        label={
          <>
            {t('Direct cost')} <span className="font-mono">{fmt2(tot?.direct)}</span>
          </>
        }
      >
        <SrcRows
          rows={[
            [t('Material'), fmt2(tot?.material)],
            [t('Labour'), fmt2(tot?.labour)],
            [t('Direct cost'), fmt2(tot?.direct)],
            [t('Cost incl. transport and overhead'), fmt2(tot?.cost)],
            [t('Price at standard margin'), fmt0(tot?.standard_price)],
          ]}
        />
        <SrcFoot>
          {changed > 0 && (
            <Link to={`/t/${tenderId}/changes`}>{changed === 1 ? t('1 line changed by hand') : t('{n} lines changed by hand', { n: changed })}</Link>
          )}
          <Link to={`/t/${tenderId}/pricing`}>
            {offer ? t('offer price CHF {p} ({o})', { p: fmt0(offer), o: t(chosen!) }) : t('offer price not chosen yet')}
          </Link>
        </SrcFoot>
      </Source>
      <span className="flex-auto" />
      <span className="font-semibold" aria-live="polite">
        {t('Price at standard margin')}{' '}
        <span className={isFetching ? 'font-mono cf-pending' : 'font-mono'}>CHF {fmt0(tot?.standard_price)}</span>
      </span>
    </footer>
  )
}
