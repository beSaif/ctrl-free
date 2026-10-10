import { useT } from '../i18n'
import { usePositions, usePricing } from '../api/hooks'
import { fmt0, fmt2 } from '../lib/format'
import { wasChanged } from '../lib/lines'
import { AssistBarButton } from '../assist/AssistLayer'

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
      ? t('1 line changed by hand')
      : t('{n} lines changed by hand', { n: changed })
    : offer
      ? t('offer price CHF {p} ({o})', { p: fmt0(offer), o: t(chosen!) })
      : t('offer price not chosen yet')
  return (
    <footer
      aria-label={t('Totals')}
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-4 min-[1400px]:gap-x-5 gap-y-2 px-6 py-3 border-t border-ink bg-white text-[14px]"
    >
      <AssistBarButton />
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
        <span className="hidden min-[1400px]:inline">{t('Cost incl. transport and overhead')}</span>
        <span className="min-[1400px]:hidden">{t('Cost')}</span> <span className="font-mono">{fmt2(tot?.cost)}</span>
      </span>
      <span className="flex-auto" />
      <span className="hidden min-[1600px]:inline text-muted">{note}</span>
      <span className="font-semibold" aria-live="polite">
        {t('Price at standard margin')}{' '}
        <span className={isFetching ? 'font-mono cf-pending' : 'font-mono'}>CHF {fmt0(tot?.standard_price)}</span>
      </span>
    </footer>
  )
}
