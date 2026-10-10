// N08 Export: before-you-submit checklist (not blocking), submission rule from the tender,
// files, Mark as submitted.
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { api, type ExportKind } from '../api/client'
import { useInstructions, usePositions, usePricing, useSubmit, useTender } from '../api/hooks'
import { Button, Loading, Td, Th } from '../components/ui'
import { PageViewer } from '../components/PdfCrop'
import { FilledLv } from './FilledLv'
import { fmt0, fmtDateTime, fmtDaysLeft, fmtShare } from '../lib/format'
import { C, isOpen, isPriceable, isSupplier, quotedPrice } from '../lib/lines'
import { allProjectCosts, previewScenario } from '../lib/pricing'

function Check({ color, children, link }: { color: string; children: ReactNode; link?: ReactNode }) {
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)_auto] gap-3 items-baseline py-3 border-b border-rowrule">
      <span className="w-2 h-2" style={{ background: color }} aria-hidden="true" />
      <span>{children}</span>
      {link}
    </div>
  )
}

export function Export() {
  const { id = '' } = useParams()
  const t = useT()
  const lang = useLang()
  const nav = useNavigate()
  const { data: tender } = useTender(id)
  const { data: pos } = usePositions(id)
  const { data: ins } = useInstructions(id)
  const { data: pr } = usePricing(id)
  const submit = useSubmit(id)
  const [pageOpen, setPageOpen] = useState(false)
  const [dl, setDl] = useState<string | null>(null)
  if (!tender || !pos || !ins || !pr) return <Loading label={t('Loading')} />

  const ps = pos.positions
  const tot = pr.totals
  const priceable = ps.filter(isPriceable)
  const hasPrice = (p: (typeof ps)[number]) => (p.pricing?.direct ?? 0) > 0
  const priced = ps.filter((p) => p.status === 'calculated').length
  const budget = priceable.filter((p) => isSupplier(p) && quotedPrice(p) === null && hasPrice(p) && !p.confirmed)
  const budgetDirect = budget.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0)
  const unpriced = priceable.filter((p) => !hasPrice(p) && !p.confirmed)
  const unpricedSup = unpriced.filter((p) => isSupplier(p) && p.status !== 'insufficient_information').length
  const unpricedQty = unpriced.filter((p) => p.status === 'insufficient_information').length
  const quotes = ps.filter((p) => isSupplier(p) && quotedPrice(p) !== null).length
  const otherOpenLines = ps.filter((p) => isOpen(p) && hasPrice(p) && !budget.includes(p))
  const otherOpen = otherOpenLines.length
  const allGuesses = otherOpenLines.every((p) => p.status === 'assumption_applied' && !p.flagged)
  const openIns = ins.instructions.filter((i) => i.state === 'open')
  const cost = openIns.filter((i) => i.kind === 'cost').length
  const risk = openIns.filter((i) => i.kind === 'risk').length
  const s = pr.settings
  const pcOn = Object.entries(s.project_costs).filter(([, v]) => v)
  const chosen = s.chosen ? tot.scenarios.find((x) => x.name === s.chosen) : undefined
  const best = previewScenario(tot.scenarios, s.chosen)
  const rule = tender.submission_rule
  const sub = tender.submission
  const rt = tender.review_trail
  const lnk = (to: string, label: string) => (
    <Link to={to} className="whitespace-nowrap">
      {label}
    </Link>
  )
  const download = async (k: ExportKind) => {
    setDl(k)
    try {
      await api.download(id, k)
    } finally {
      setTimeout(() => setDl(null), 800)
    }
  }

  return (
    <main className="flex flex-wrap items-start">
      <section aria-label={t('Before you submit')} className="flex-[1_1_520px] max-w-[640px] min-w-0 p-6 flex flex-col gap-4 border-r border-rule">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[20px] font-semibold">{t('Before you submit')}</h1>
          <p className="m-0 text-muted">
            {fmtDaysLeft(tender.due_at, lang).replace(/^./, (c) => c.toUpperCase())}. {t('Open points are listed, not blocked. You decide whether to submit with them.')}
          </p>
        </div>
        <div className="flex flex-col">
          <Check color={C.stone} link={lnk(`/t/${id}/lines?f=priced`, t('Lines'))}>
            <strong className="font-semibold">{t('{a} of {b} lines priced', { a: priced, b: priceable.length })}</strong> {t('from the catalogue')}
          </Check>
          {budget.length > 0 ? (
            <Check color={C.attn} link={lnk(`/t/${id}/lines`, t('Lines'))}>
              <strong className="font-semibold text-attn">{budget.length === 1 ? t('1 line on a budget price') : t('{n} lines on budget prices', { n: budget.length })}</strong> ·{' '}
              {t('CHF {a} of direct cost ({s}).', { a: fmt0(budgetDirect), s: fmtShare(tot.direct ? budgetDirect / tot.direct : 0) })}{' '}
              {quotes ? t('{n} supplier quotes entered.', { n: quotes }) : t('No supplier quotes entered yet.')}
            </Check>
          ) : (
            <Check color={C.ink} link={lnk(`/t/${id}/lines?f=all`, t('Lines'))}>
              <strong className="font-semibold">{t('No budget prices left')}</strong> · {t('{n} supplier quotes entered.', { n: quotes })}
            </Check>
          )}
          {unpriced.length > 0 && (
            <Check color={C.attn} link={lnk(`/t/${id}/lines`, t('Lines'))}>
              <strong className="font-semibold text-attn">{unpriced.length === 1 ? t('1 line without a price') : t('{n} lines without a price', { n: unpriced.length })}</strong> ·{' '}
              {[
                unpricedSup ? t('{n} not in the catalogue (supplier requests are drafted)', { n: unpricedSup }) : null,
                unpricedQty ? t('{n} without a quantity in the tender', { n: unpricedQty }) : null,
              ]
                .filter(Boolean)
                .join('; ')}
              . {t('They are not in the direct cost yet.')}
            </Check>
          )}
          {otherOpen > 0 && (
            <Check color={C.attn} link={lnk(`/t/${id}/lines`, t('Lines'))}>
              <strong className="font-semibold text-attn">{allGuesses ? (otherOpen === 1 ? t('1 line priced with an assumption') : t('{n} lines priced with an assumption', { n: otherOpen })) : t('{n} more lines to review', { n: otherOpen })}</strong>
              {allGuesses && <> · {t('check them before you submit')}</>}
            </Check>
          )}
          {openIns.length > 0 ? (
            <Check color={C.attn} link={lnk(`/t/${id}/instructions`, t('Instructions'))}>
              <strong className="font-semibold text-attn">{t('{a} of {b} instructions not confirmed', { a: openIns.length, b: ins.instructions.length })}</strong> ·{' '}
              {t('{c} add cost, {r} are risks', { c: cost, r: risk })}
            </Check>
          ) : (
            <Check color={C.ink} link={lnk(`/t/${id}/instructions?tab=all`, t('Instructions'))}>
              <strong className="font-semibold">{t('All instructions handled')}</strong>
            </Check>
          )}
          {pcOn.length === 0 ? (
            <Check color={C.attn} link={lnk(`/t/${id}/pricing/costs`, t('Pricing'))}>
              <strong className="font-semibold text-attn">{t('Project costs not included')}</strong> ·{' '}
              {t('engineering, commissioning, hygiene inspection, documentation (CHF {a} if all on)', { a: fmt0(allProjectCosts(tot)) })}
            </Check>
          ) : (
            <Check color={C.ink} link={lnk(`/t/${id}/pricing/costs`, t('Pricing'))}>
              <strong className="font-semibold">{t('Project costs included')}</strong> · CHF {fmt0(tot.project_costs)}
            </Check>
          )}
          {chosen ? (
            <Check color={C.accent} link={lnk(`/t/${id}/pricing/strategy`, t('Change'))}>
              <strong className="font-semibold">{t('Offer price CHF {p}', { p: fmt0(chosen.bid) })}</strong> ·{' '}
              {t('{name}, {m}% margin · {w} win chance', { name: t(chosen.name), m: chosen.margin_pct.toFixed(1), w: fmtShare(chosen.win) })}
            </Check>
          ) : (
            <Check color={C.attn} link={lnk(`/t/${id}/pricing/strategy`, t('Pricing'))}>
              <strong className="font-semibold text-attn">{t('Offer price not chosen')}</strong> · {t('the standard margin gives CHF {p}', { p: fmt0(tot.standard_price) })}
            </Check>
          )}
          {rt && (rt.to_review > 0 || rt.ai_to_review > 0) ? (
            <Check color={C.attn} link={lnk(`/t/${id}/changes`, t('Changes'))}>
              {rt.to_review > 0 && (
                <strong className="font-semibold text-attn">
                  {rt.to_review === 1 ? t('1 change not reviewed by a senior') : t('{n} changes not reviewed by a senior', { n: rt.to_review })}
                </strong>
              )}
              {rt.to_review > 0 && rt.ai_to_review > 0 && ' · '}
              {rt.ai_to_review > 0 &&
                (rt.to_review > 0 ? (
                  t('{n} low-confidence AI picks not reviewed', { n: rt.ai_to_review })
                ) : (
                  <strong className="font-semibold text-attn">{t('{n} low-confidence AI picks not reviewed', { n: rt.ai_to_review })}</strong>
                ))}
            </Check>
          ) : rt && rt.changes > 0 ? (
            <Check color={C.ink} link={lnk(`/t/${id}/changes?tab=all`, t('Changes'))}>
              <strong className="font-semibold">{t('All {n} changes reviewed by a senior', { n: rt.changes })}</strong>
            </Check>
          ) : null}
        </div>

        {rule && (
          <div className="flex flex-col gap-1.5 pt-2">
            <h2 className="m-0 text-[15px] font-semibold">{t('Submission rules from the tender')}</h2>
            <div className="text-[13px] text-muted">
              {t('p. {page}', { page: rule.page })} · {rule.heading}
            </div>
            <blockquote className="m-0 px-3 py-2.5 border border-rule text-[13.5px] leading-[1.55]">«{rule.text_de}»</blockquote>
            <span className="text-[13.5px]">
              {rule.summary && lang === 'en' ? rule.summary.full_en + ' ' : ''}
              <button type="button" onClick={() => setPageOpen(true)} className="border-0 bg-transparent p-0 text-[13px] text-accent underline underline-offset-2">
                {t('Show on page')}
              </button>
            </span>
            {lang === 'en' && rule.text_en && (
              <details className="text-[13px] text-muted">
                <summary className="cursor-pointer w-fit">{t(rule.text_en_method === 'glossary' ? 'Machine translation (rough)' : 'Machine translation')}</summary>
                <p className="m-0 mt-1 leading-[1.55]">{rule.text_en}</p>
              </details>
            )}
            <PageViewer
              open={pageOpen}
              onClose={() => setPageOpen(false)}
              tenderId={id}
              pageCount={tender.page_count}
              source={{ page: rule.page, page_size: [595, 842], block_bbox: rule.bbox ?? null, lines: rule.bbox ? [{ text: rule.text_de, bbox: rule.bbox, role: 'qty' }] : [] }}
              fallback={<blockquote className="m-0 text-[13.5px] leading-[1.55] bg-hl px-1">«{rule.text_de}»</blockquote>}
            />
          </div>
        )}
      </section>

      <section aria-label={t('Files')} className="flex-[1_1_520px] min-w-0 p-6 flex flex-col gap-4">
        <h2 className="m-0 text-[20px] font-semibold">{t('Files')}</h2>
        <FilledLv id={id} onDownload={() => download('lv-filled.pdf')} busy={dl === 'lv-filled.pdf'} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr>
                <Th>{t('File')}</Th>
                <Th>{t('For')}</Th>
                <Th>
                  <span className="sr-only">{t('Download')}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>
                  <div className="font-semibold">
                    {t('Offer workbook')} <span className="font-mono font-normal text-muted">.xlsx</span>
                  </div>
                  <div className="text-muted">
                    {t('One row per line with page, quantity, product, hours, material and labour. Formulas point at catalogue, install-rule and pricing sheets.')}
                  </div>
                </Td>
                <Td>SEAP</Td>
                <Td className="text-right">
                  <Button size="sm" onClick={() => download('xlsx')} disabled={dl === 'xlsx'}>
                    {t('Download')}
                  </Button>
                </Td>
              </tr>
              <tr>
                <Td>
                  <div className="font-semibold">{t('SIA interface file')}</div>
                  <div className="text-muted">
                    {t('The bill of quantities with unit prices, as the client asks.')} {t('Simplified, planned format.')}
                  </div>
                </Td>
                <Td>{t('Client, on USB')}</Td>
                <Td className="text-right">
                  <Button size="sm" onClick={() => download('sia')} disabled={dl === 'sia'}>
                    {t('Download')}
                  </Button>
                </Td>
              </tr>
              <tr>
                <Td>
                  <div className="font-semibold">
                    {t('Pricing report')} <span className="font-mono font-normal text-muted">.pdf</span>
                  </div>
                  <div className="text-muted">
                    {t('Every value used, its source (project parameters or your judgment), your notes, and the open points on the left.')}
                  </div>
                </Td>
                <Td>{t('Bid lead')}</Td>
                <Td className="text-right">
                  <Button size="sm" onClick={() => download('report.pdf')} disabled={dl === 'report.pdf'}>
                    {t('Download')}
                  </Button>
                </Td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3 p-4 border border-ink">
          {sub ? (
            <>
              <div className="flex flex-col gap-0.5 flex-[1_1_320px]">
                <span className="font-semibold">{t('Submitted · {d}', { d: fmtDateTime(sub.at) })}</span>
                <span className="text-muted text-[13px]">
                  {t('Snapshot saved: CHF {p}, {o}. Compare it with the award in Outcome.', { p: fmt0(sub.offer_price), o: t(sub.option) })}
                </span>
              </div>
              <Button variant="dark" onClick={() => nav(`/t/${id}/outcome`)}>
                {t('Record the outcome')}
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-0.5 flex-[1_1_320px]">
                <span className="font-semibold">{t('Mark as submitted')}</span>
                <span className="text-muted text-[13px]">
                  {t('Saves a snapshot of the price and every value behind it. You compare it with the award later in Outcome.')}
                  {!chosen && best && ' ' + t('The price is not chosen yet: the snapshot uses {o} (CHF {p}).', { o: t(best.name), p: fmt0(best.bid) })}
                </span>
              </div>
              <Button
                variant="dark"
                disabled={submit.isPending}
                onClick={async () => {
                  await submit.mutateAsync(chosen?.name ?? best?.name)
                  nav(`/t/${id}/outcome`)
                }}
              >
                {t('Mark as submitted')}
              </Button>
            </>
          )}
        </div>
        {submit.error && (
          <span role="alert" className="text-attn">
            {t('Could not save.')} {submit.error instanceof Error ? submit.error.message : ''}
          </span>
        )}
      </section>
    </main>
  )
}
