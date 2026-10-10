// N03 Overview: "N steps left before you can submit" + due date, price so far, tender facts.
import { Fragment, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { api } from '../api/client'
import { useDeleteTender, useInstructions, useMyName, usePositions, usePricing, useReference, useTender, useVerification } from '../api/hooks'
import { changedBy, rec } from '../lib/trace'
import { Button, Dialog, IconCheck, LinkButton, Loading } from '../components/ui'
import { cx } from '../lib/cx'
import { PageViewer } from '../components/PdfCrop'
import { Source } from '../components/Source'
import { fmt0, fmt2, fmtDateTime, fmtDaysLeft, fmtShare } from '../lib/format'
import { isOpen, isPriceable, isSupplier, quotedPrice, reviewBreakdown } from '../lib/lines'
import { allProjectCosts, standardMargin } from '../lib/pricing'
import type { ReviewTrail } from '../api/types'

interface Step {
  n: number
  title: string
  to: string
  action: string
  done: boolean
  urgent: boolean
  /** one line with the key number; nothing when there is nothing to say */
  status: ReactNode
  /** the long explanation, behind a "Details" popover */
  details: string | null
}

export function Overview() {
  const { id = '' } = useParams()
  const t = useT()
  const lang = useLang()
  const { data: tender } = useTender(id)
  const { data: pos } = usePositions(id)
  const { data: ins } = useInstructions(id)
  const { data: pr } = usePricing(id)
  const { data: ref } = useReference()
  const { data: verif } = useVerification(id)
  const [pageOpen, setPageOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const me = useMyName()
  if (!tender || !pos || !ins || !pr) return <Loading label={t('Loading')} />

  const ps = pos.positions
  const open = ps.filter(isOpen)
  const priceable = ps.filter(isPriceable)
  const pricedLines = ps.filter((p) => (p.pricing?.direct ?? 0) > 0).length
  const learnedN = ps.filter((p) => p.match?.method === 'learned').length
  const supplierOpen = open.filter((p) => isSupplier(p) && isPriceable(p) && quotedPrice(p) === null && p.status !== 'insufficient_information')
  const tot = pr.totals
  const openIns = ins.instructions.filter((i) => i.state === 'open')
  const costN = openIns.filter((i) => i.kind === 'cost').length
  const riskN = openIns.filter((i) => i.kind === 'risk').length
  const s = pr.settings
  const chosen = s.chosen ? tot.scenarios.find((x) => x.name === s.chosen) : undefined
  const chosenBy = rec(rec(s.changed_by).chosen).by as string | undefined
  const pcOn = Object.values(s.project_costs).some(Boolean)
  const std = standardMargin(s)
  const base = `/t/${id}`

  // each step: one short status with its key number; the long sentence sits behind "Details"
  const steps: Step[] = [
    {
      n: 1,
      title: t('Confirm instructions and norms'),
      to: `${base}/instructions`,
      action: t('Open'),
      done: openIns.length === 0,
      urgent: true,
      status: openIns.length ? (
        <span className="text-attn font-medium">{t('{n} of {total} not confirmed', { n: openIns.length, total: ins.instructions.length })}</span>
      ) : null,
      details: openIns.length
        ? t('{c} add cost and {r} are risks. Each one is quoted from the tender with its page.', { c: costN, r: riskN })
        : t('All {n} handled. They go into the pricing report.', { n: ins.instructions.length }),
    },
    {
      n: 2,
      title: t('Review lines'),
      to: `${base}/lines`,
      action: open.length ? t('Start review') : t('Open'),
      done: open.length === 0,
      urgent: true,
      status: open.length ? <span className="text-attn font-medium">{t('{n} of {total} lines need you', { n: open.length, total: priceable.length })}</span> : null,
      details: open.length
        ? reviewBreakdown(open, tot.direct, t).join(' ') +
          ' ' +
          (supplierOpen.length ? t('Supplier requests are drafted per product type.') : t('Check the product or the quantity and confirm.'))
        : null,
    },
    {
      n: 3,
      title: t('Choose the offer price'),
      // project costs still off: start with Costs; otherwise straight to the price decision
      to: `${base}/pricing/${pcOn ? 'strategy' : 'costs'}`,
      action: t('Open'),
      done: !!chosen,
      urgent: true,
      status: chosen ? (
        <span className="text-muted">
          {t('CHF {bid} · {name}, {m}% margin · {w} win chance.', { bid: fmt0(chosen.bid), name: t(chosen.name), m: chosen.margin_pct.toFixed(1), w: fmtShare(chosen.win) })}
        </span>
      ) : (
        <span className="text-attn font-medium">{t('Not chosen yet')}</span>
      ),
      details: chosen
        ? pcOn
          ? null
          : t('Project costs are not in the price.')
        : (!pcOn ? t('Project costs are not in the price (CHF {pc} if all are switched on).', { pc: fmt0(allProjectCosts(tot)) }) + ' ' : '') +
          t('At the standard {m}% margin the price would be CHF {p}.', { m: std.toFixed(1), p: fmt0(tot.standard_price) }),
    },
    {
      n: 4,
      title: t('Export and submit'),
      to: `${base}/export`,
      action: t('Open'),
      done: !!tender.submission,
      urgent: false,
      status: (
        <>
          {tender.submission && (
            <span className="text-muted">
              {t('Submitted at CHF {p} on {d}.', { p: fmt0(tender.submission.offer_price), d: fmtDateTime(tender.submission.at) })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void api.download(id, 'lv-filled.pdf')}
            className="border-0 bg-transparent p-0 text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            {t('Download the filled tender (PDF)')}
          </button>
        </>
      ),
      details: tender.submission
        ? null
        : t('The filled tender: the original PDF with your prices written in. Also the offer workbook, SIA interface file and pricing report. Open points above do not block the export.'),
    },
    {
      n: 5,
      title: t('After the award: record the outcome'),
      to: `${base}/outcome`,
      action: t('Open'),
      done: !!tender.outcome,
      urgent: false,
      status: null,
      details: tender.outcome ? null : t('Winning price and number of bidders from the award notice, so the next tender starts from real numbers.'),
    },
  ]
  const left = steps.slice(0, 3).filter((x) => !x.done).length
  const next = steps.find((x) => !x.done)
  const cta =
    next?.n === 1
      ? t('Continue: confirm {n} instructions', { n: openIns.length })
      : next?.n === 2
        ? open.length === 1
          ? t('Continue: review 1 line')
          : t('Continue: review {n} lines', { n: open.length })
        : next?.n === 3
          ? t('Continue: choose the price')
          : next?.n === 4
            ? t('Continue: export')
            : next
              ? t('Record the outcome')
              : null
  const rule = tender.submission_rule
  const rt = tender.review_trail
  const details = (st: Step, className = '') =>
    st.details && (
      <Source label={t('Details')} title={st.title} className={cx('text-[13px] text-muted', className)}>
        <p className="m-0 leading-[1.55]">{st.details}</p>
      </Source>
    )

  return (
    <main className="flex-auto flex flex-wrap items-start">
      <section aria-label={t('What is left')} className="flex-[999_1_640px] min-w-0 px-6 pt-7 pb-10 flex flex-col gap-6">
        {priceable.length === 0 && (
          <div role="status" className="flex flex-col gap-1 px-4 py-3.5 border border-attn">
            <span className="font-semibold text-attn">{t('No bill-of-quantities lines were found in this PDF.')}</span>
            <span className="text-muted">
              {t('ctrl-free reads tenders whose LV positions have a quantity and a unit (e.g. "Stk 5"). Check that this is the tender PDF, not a letter or a plan.')}
            </span>
          </div>
        )}
        <h1 className="m-0 text-[24px] leading-[1.25] font-semibold">
          {left === 0 ? t('Ready to submit') : left === 1 ? t('1 step left before you can submit') : t('{n} steps left before you can submit', { n: left })}
        </h1>

        <ol className="m-0 p-0 list-none flex flex-col border-t border-ink">
          {steps.map((st, i) => {
            const isNext = st.n === next?.n
            return (
              <li
                key={st.n}
                className={cx('grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-4 gap-y-1 items-center py-3.5', i < steps.length - 1 && 'border-b border-rowrule')}
              >
                <span className={cx('font-mono', st.done ? 'text-ink' : st.urgent ? 'text-attn' : 'text-muted')}>{st.n}</span>
                <span className={cx('text-[16px] font-semibold', !st.urgent && !st.done && st.n === 5 && 'text-muted')}>
                  {st.title}
                  {st.done && <span className="ml-2.5 text-[13px] font-medium text-ink align-middle">· {t('Done')}</span>}
                  {!st.status && details(st, 'ml-3 font-normal')}
                </span>
                {isNext ? (
                  <LinkButton to={st.to} variant="primary" className="justify-self-end">
                    {cta ?? st.action}
                  </LinkButton>
                ) : (
                  <Link to={st.to} className="justify-self-end inline-flex items-center min-h-9 px-1">
                    {st.action}
                  </Link>
                )}
                {st.status && (
                  <>
                    <span />
                    <span className="col-[2/-1] flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {st.status}
                      {details(st)}
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ol>
        {rt && (rt.changes > 0 || rt.ai_to_review > 0) && <ReviewTrailNote rt={rt} to={`${base}/changes`} />}
        {learnedN > 0 && (
          <p className="m-0 -mt-3 text-[13px] text-muted">
            {learnedN === 1 ? t('1 line matched from what you taught earlier.') : t('{n} lines matched from what you taught earlier.', { n: learnedN })}{' '}
            <Link to="/reference?tab=learned">{t('See learned matches')}</Link>
          </p>
        )}
      </section>

      <aside aria-label={t('Tender facts')} className="flex-[1_1_360px] max-w-[460px] min-w-0 px-6 pt-7 pb-10 border-l border-rule flex flex-col gap-6">
        <section className="flex flex-col gap-1 p-4 border border-ink">
          <span className="text-[13px] text-muted">{t('Submission due')}</span>
          <span className="text-[26px] leading-[1.2] font-semibold">{fmtDaysLeft(tender.due_at, lang)}</span>
          <span className="font-mono">{fmtDateTime(tender.due_at)}</span>
          {rule && (
            <Source label={t('How to submit')} title={t('How to submit')} className="self-start text-[13px] text-muted">
              <p className="m-0 leading-[1.55]">
                {rule.summary ? (lang === 'de' ? rule.summary.short_de : rule.summary.short_en) : `«${rule.text_de}»`}
              </p>
              <span className="text-muted">
                {t('Read from the tender, p. {page}.', { page: rule.page })}{' '}
                <button type="button" onClick={() => setPageOpen(true)} className="border-0 bg-transparent p-0 min-h-0 text-accent underline underline-offset-2">
                  {t('Show on page')}
                </button>
              </span>
            </Source>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[15px] font-semibold">{t('Price so far')}</h2>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
            <span className="py-[7px] border-b border-rowrule">{t('Direct cost, {n} priced lines', { n: pricedLines })}</span>
            <span className="py-[7px] border-b border-rowrule font-mono text-right">{fmt2(tot.direct)}</span>
            <span className="py-[7px] border-b border-rowrule">{t('Cost incl. transport and overhead')}</span>
            <span className="py-[7px] border-b border-rowrule font-mono text-right">{fmt2(tot.cost)}</span>
            {chosen ? (
              <>
                <span className="py-[7px] font-semibold">{t('Offer price, {name} {m}%', { name: t(chosen.name), m: chosen.margin_pct.toFixed(1) })}</span>
                <span className="py-[7px] font-mono font-semibold text-right">{fmt0(chosen.bid)}</span>
              </>
            ) : (
              <>
                <span className="py-[7px] font-semibold">{t('Price at standard {m}% margin', { m: std.toFixed(1) })}</span>
                <span className="py-[7px] font-mono font-semibold text-right">{fmt0(tot.standard_price)}</span>
              </>
            )}
          </div>
          <span className="text-[13px] text-muted">
            {chosen ? t('Chosen by {who} in Pricing. You can still change it.', { who: changedBy(chosenBy, me, t) }) : t('Not the offer price yet. It becomes final in step 3.')}
          </span>
        </section>

        {verif?.summary && verif.summary.found > 0 && <VerifiedPanel v={verif} tenderId={id} />}

        <section className="flex flex-col gap-1.5 text-[13px]">
          <h2 className="m-0 text-[13px] font-semibold text-muted">{t('Tender')}</h2>
          <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <span className="text-muted">{t('Client')}</span>
            <span>{tender.client}</span>
            <span className="text-muted">{t('Trade')}</span>
            <span>{tender.trade}</span>
            <span className="text-muted">{t('Document')}</span>
            <span className="break-words">
              {tender.file_name} · {t('{n} pages', { n: tender.page_count })} · <Link to={`/t/${id}/pdf`}>{t('Browse the pages')}</Link>
            </span>
            <span className="text-muted">{t('Priced with')}</span>
            <span>
              {t('Catalogue ({p} products) and install rules ({r}) from', { p: ref?.catalog.length ?? 56, r: ref?.rules.length ?? 22 })}{' '}
              <Link to="/reference">{t('Reference data')}</Link>
            </span>
          </div>
          <Button variant="quiet" size="xs" onClick={() => setDeleteOpen(true)} className="self-start mt-2 px-0!">
            {t('Delete tender')}
          </Button>
        </section>
      </aside>
      {deleteOpen && <DeleteTenderDialog id={id} name={tender.name || tender.file_name} onClose={() => setDeleteOpen(false)} />}
      {rule && (
        <PageViewer
          open={pageOpen}
          onClose={() => setPageOpen(false)}
          tenderId={id}
          pageCount={tender.page_count}
          source={{ page: rule.page, page_size: [595, 842], block_bbox: rule.bbox ?? null }}
          fallback={<blockquote className="m-0 text-[13.5px] leading-[1.55] bg-hl px-1">«{rule.text_de}»</blockquote>}
        />
      )}
    </main>
  )
}

/** Put a styled count into a translated sentence: t() with a marker for {n}, then split on it. */
function withCount(text: (n: string) => string, n: number, className: string): ReactNode {
  const parts = text('\u0000').split('\u0000')
  if (parts.length < 2) return text(String(n)).replace('\u0000', String(n))
  const [pre, post] = parts
  return (
    <>
      {pre}
      <span className={className}>{n}</span>
      {post}
    </>
  )
}

/** "37 low-confidence AI picks waiting for senior review": one quiet line, the count in attn, a link to Changes. */
function ReviewTrailNote({ rt, to }: { rt: ReviewTrail; to: string }) {
  const t = useT()
  const attn = 'text-attn font-medium'
  return (
    <p className="m-0 text-[13px] text-muted">
      {rt.to_review > 0 ? (
        <>
          {rt.to_review === 1
            ? withCount(() => t('1 change waiting for senior review').replace(/^1/, '\u0000'), 1, attn)
            : withCount((n) => t('{n} changes waiting for senior review', { n }), rt.to_review, attn)}
          {rt.ai_to_review > 0 && ', ' + (rt.ai_to_review === 1 ? t('and 1 low-confidence AI pick') : t('and {n} low-confidence AI picks', { n: rt.ai_to_review }))}
        </>
      ) : rt.ai_to_review > 0 ? (
        rt.ai_to_review === 1 ? (
          withCount(() => t('1 low-confidence AI pick waiting for senior review').replace(/^1/, '\u0000'), 1, attn)
        ) : (
          withCount((n) => t('{n} low-confidence AI picks waiting for senior review', { n }), rt.ai_to_review, attn)
        )
      ) : (
        t('All {n} changes reviewed by a senior.', { n: rt.changes })
      )}{' '}
      · <Link to={to}>{t('See who did what')}</Link>
    </p>
  )
}

function DeleteTenderDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const t = useT()
  const nav = useNavigate()
  const del = useDeleteTender()
  const confirm = () => del.mutate(id, { onSuccess: () => nav('/', { replace: true }) })
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Delete tender')}
      closeLabel={t('Close')}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="dark" onClick={confirm} disabled={del.isPending}>
            {del.isPending ? t('Deleting…') : t('Delete tender')}
          </Button>
        </>
      }
    >
      <div className="px-6 py-5 flex flex-col gap-3">
        <p className="m-0">{t('Delete "{name}"? The PDF, the lines, your prices and the history are removed. This cannot be undone.', { name })}</p>
        {del.error && (
          <p role="alert" className="m-0 text-attn">
            {t('Could not delete the tender.')} <span className="text-muted">({del.error.message})</span>
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** "✓ Verified against Equans examples: 22/22", one line; the counts and the example table sit in its popover. */
function VerifiedPanel({ v, tenderId }: { v: NonNullable<ReturnType<typeof useVerification>['data']>; tenderId: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const s = v.summary!
  const all = s.found === s.total && s.direct_ok === s.total && s.product_ok === s.total
  const label = t('Verified against Equans examples: {a}/{b}', { a: s.direct_ok, b: s.total })
  return (
    <section className="flex items-baseline gap-1.5 text-[13px]">
      {all && (
        <span className="flex-none self-center">
          <IconCheck size={12} />
        </span>
      )}
      <Source label={label} title={label} className="text-[13px] text-ink" width={520}>
        <p className="m-0 leading-[1.55] text-muted">
          {t('{f} of {n} example lines found in the PDF, {p} with the same product, {d} with the same line total to the centime.', {
            f: s.found,
            n: s.total,
            p: s.product_ok,
            d: s.direct_ok,
          })}{' '}
          {s.subset_direct_golden !== undefined &&
            t('Subset direct cost CHF {a} (Equans: {b}).', { a: fmt2(s.subset_direct_ours), b: fmt2(s.subset_direct_golden) })}
          {(s.price_list_rows ?? 0) > 0 && (
            <> {t('{n} differ because an active price list replaces the catalogue prices the examples use.', { n: s.price_list_rows ?? 0 })}</>
          )}
        </p>
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="self-start p-0 min-h-0 border-0 bg-transparent text-accent underline underline-offset-2 text-[13px]">
          {open ? t('Hide the examples') : t('Show the examples')}
        </button>
        {open && (
          <div className="grid grid-cols-[52px_52px_minmax(0,1fr)_auto] gap-x-2 text-[12.5px]">
            {v.rows.map((r) => (
              <Fragment key={r.example_id}>
                <span className="py-1 border-b border-rowrule font-mono text-muted">{r.example_id}</span>
                <span className="py-1 border-b border-rowrule font-mono">
                  {r.our_lv_id ? <Link to={`/t/${tenderId}/lines/${r.our_lv_id}?f=all`}>{r.our_lv_id}</Link> : '–'}
                </span>
                <span className="py-1 border-b border-rowrule overflow-hidden text-ellipsis whitespace-nowrap" title={r.description}>
                  {r.description}
                </span>
                <span className={cx('py-1 border-b border-rowrule font-mono text-right inline-flex items-center justify-end gap-1', !r.direct_ok && 'text-attn')}>
                  {fmt2(r.golden_direct)}
                  {r.direct_ok ? <IconCheck size={11} /> : <span>≠</span>}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </Source>
    </section>
  )
}
