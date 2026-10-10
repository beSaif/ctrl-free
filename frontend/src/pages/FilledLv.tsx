// Export: the filled tender, i.e. the original LV PDF with our prices written in (the expected output),
// with a preview of a few of its pages.
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '../i18n'
import { api, filledLvPageUrl, filledLvPdfUrl } from '../api/client'
import { Button, Dialog, Spinner } from '../components/ui'
import { fmt0, fmt2 } from '../lib/format'

export function FilledLv({ id, onDownload, busy }: { id: string; onDownload: () => void; busy: boolean }) {
  const t = useT()
  const { data: s, isLoading } = useQuery({ queryKey: ['lvFilled', id], queryFn: () => api.getFilledLv(id) })
  const [view, setView] = useState<number | null>(null)
  const pages = s?.preview_pages ?? []
  const version = s ? `${s.lv_sum}-${s.filled}-${s.open}-${s.offer}` : ''
  const img = (n: number, scale: number) => {
    const u = filledLvPageUrl(id, n, scale)
    return u ? `${u}&v=${encodeURIComponent(version)}` : null
  }
  const label = (n: number) =>
    !s ? '' : n <= s.cover_pages ? t('Cover page') : t('Tender p. {n}', { n: n - s.cover_pages })
  const at = view === null ? -1 : pages.indexOf(view)

  return (
    <div className="flex flex-col gap-3 p-4 border border-ink">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1 flex-[1_1_320px] min-w-0">
          <span className="font-semibold">
            {t('Filled tender (LV)')} <span className="font-mono font-normal text-muted">.pdf</span>
            <span className="font-normal"> · {t('the original PDF with your prices')}</span>
          </span>
          <span className="text-muted text-[13.5px]">
            {t('Unit price and amount on every priced line, the totals per section and system, and the summary pages, written into the tender like you fill it by hand. A cover page lists the offer price and what is still open.')}
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={onDownload} disabled={busy}>
          {t('Download')}
        </Button>
      </div>

      {isLoading && <Spinner label={t('Writing the prices into the tender')} />}
      {s && (
        <>
          <div className="flex flex-col gap-0.5 text-[13.5px]">
            <span>
              <strong className="font-semibold">{t('{n} lines filled', { n: s.filled })}</strong>
              {s.open > 0 && (
                <>
                  {' · '}
                  <span className="text-attn">{t('{n} still open', { n: s.open })}</span>{' '}
                  <span className="text-muted">
                    ({Object.entries(s.open_by_marker)
                      .sort((a, b) => b[1] - a[1])
                      .map(([m, c]) => `«${m}» ${c}`)
                      .join(', ')}
                    )
                  </span>
                </>
              )}
              {' · '}
              {t('{n} totals', { n: s.totals_filled })}
            </span>
            <span className="text-muted">
              {t('Sum of the LV CHF {sum} · offer price CHF {offer}', { sum: fmt2(s.lv_sum), offer: fmt0(s.offer) })}
              {Math.abs(s.rounding) >= 0.005 && ' ' + t('(CHF {r} from rounding unit prices to the cent)', { r: fmt2(s.rounding) })}
              {s.netto != null && ' · ' + t('netto incl. MWST CHF {n}', { n: fmt2(s.netto) })}
            </span>
            {!s.chosen && <span className="text-attn">{t('No price chosen yet: the tender is filled at the standard price.')}</span>}
            <span className="text-muted">
              {t('Unit prices are selling prices: direct cost × {k} (offer price ÷ direct cost), the same numbers as the SIA file.', { k: s.k.toFixed(4) })}
            </span>
          </div>
          {pages.length > 0 && img(pages[0], 0.4) && (
            <div className="flex gap-2 overflow-x-auto pb-1" role="list" aria-label={t('Preview')}>
              {pages.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="listitem"
                  onClick={() => setView(n)}
                  className="flex-none flex flex-col gap-1 p-0 border-0 bg-transparent text-left cursor-pointer group"
                >
                  <img
                    src={img(n, 0.4) ?? undefined}
                    alt={label(n)}
                    loading="lazy"
                    width={119}
                    height={168}
                    className="block w-[119px] h-[168px] object-cover object-top border border-rule group-hover:border-ink bg-panel"
                  />
                  <span className="text-[12px] text-muted font-mono">{label(n)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog
        open={view !== null}
        onClose={() => setView(null)}
        title={view !== null ? `${t('Filled tender (LV)')} · ${label(view)}` : ''}
        closeLabel={t('Close')}
        width={760}
        footer={
          <>
            <a href={filledLvPdfUrl(id, view ?? undefined)} target="_blank" rel="noreferrer" className="mr-auto self-center text-[13.5px]">
              {t('Open the whole PDF')}
            </a>
            <Button size="sm" disabled={at <= 0} onClick={() => setView(pages[at - 1])}>
              {t('Previous')}
            </Button>
            <Button size="sm" disabled={at < 0 || at >= pages.length - 1} onClick={() => setView(pages[at + 1])}>
              {t('Next')}
            </Button>
          </>
        }
      >
        {view !== null && (
          <div className="p-4 bg-panel flex justify-center">
            <img
              src={img(view, 1.5) ?? undefined}
              alt={label(view)}
              className="block w-full max-w-[700px] h-auto border border-rule bg-white"
            />
          </div>
        )}
      </Dialog>
    </div>
  )
}
