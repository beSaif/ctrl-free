import { useT } from '../i18n'
import { usePositions, usePricing } from '../api/hooks'
import { fmt0, fmt2 } from '../lib/format'
import { wasChanged } from '../lib/lines'

/** Sticky totals bar on the line screens. Always reflects the server totals. */
export function FooterTotals({ tenderId }: { tenderId: string }) {
  const t = useT()
  const { data, isFetching } = usePricing(tenderId)
  const { data: pos } = usePositions(tenderId)
  const tot = data?.totals
  const changed = pos?.positions.filter(wasChanged).length ?? 0
  const chosen = data?.settings.chosen
  const offer = chosen ? tot?.scenarios.find((s) => s.name === chosen)?.bid : null
  const note = changed
    ? changed === 1
      ? t('1 line changed by you')
      : t('{n} lines changed by you', { n: changed })
    : offer
      ? t('offer price CHF {p} ({o})', { p: fmt0(offer), o: t(chosen!) })
      : t('offer price not chosen yet')
  return (
    <footer
      aria-label={t('Totals')}
      className="sticky bottom-0 z-10 flex flex-wrap gap-x-7 gap-y-2 px-6 py-3 border-t border-ink bg-white text-[14px]"
    >
      <span>
        {t('Material')} <span className="font-mono">{fmt2(tot?.material)}</span>
      </span>
      <span>
        {t('Labour')} <span className="font-mono">{fmt2(tot?.labour)}</span>
      </span>
      <span>
        {t('Direct')} <span className="font-mono">{fmt2(tot?.direct)}</span>
      </span>
      <span>
        {t('Cost incl. transport and overhead')} <span className="font-mono">{fmt2(tot?.cost)}</span>
      </span>
      <span className="flex-auto" />
      <span className="text-muted">{note}</span>
      <span className="font-semibold" aria-live="polite">
        {t('Price at standard margin')}{' '}
        <span className={isFetching ? 'font-mono cf-pending' : 'font-mono'}>CHF {fmt0(tot?.standard_price)}</span>
      </span>
    </footer>
  )
}
