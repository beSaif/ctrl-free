// N03 Overview: "N steps left before you can submit" + due date, price so far, tender facts.
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { useInstructions, usePositions, usePricing, useReference, useTender } from '../api/hooks'
import { LinkButton, Loading } from '../components/ui'
import { cx } from '../lib/cx'
import { PageViewer } from '../components/PdfCrop'
import { fmt0, fmt2, fmtDateTime, fmtDaysLeft, fmtShare } from '../lib/format'
import { isOpen, isSupplier, quotedPrice } from '../lib/lines'
import { allProjectCosts, standardMargin } from '../lib/pricing'

interface Step {
  n: number
  title: string
  to: string
  action: string
  done: boolean
  urgent: boolean
  body: ReactNode
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
  const [pageOpen, setPageOpen] = useState(false)
  if (!tender || !pos || !ins || !pr) return <Loading label={t('Loading')} />

  const ps = pos.positions
  const open = ps.filter(isOpen)
  const budgetOpen = open.filter((p) => isSupplier(p) && quotedPrice(p) === null)
  const tot = pr.totals
  const budgetDirect = budgetOpen.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0)
  const openIns = ins.instructions.filter((i) => i.state === 'open')
  const costN = openIns.filter((i) => i.kind === 'cost').length
  const riskN = openIns.filter((i) => i.kind === 'risk').length
  const s = pr.settings
  const chosen = s.chosen ? tot.scenarios.find((x) => x.name === s.chosen) : undefined
  const pcOn = Object.values(s.project_costs).some(Boolean)
  const std = standardMargin(s)
  const base = `/t/${id}`

  const steps: Step[] = [
    {
      n: 1,
      title: t('Review lines'),
      to: `${base}/lines`,
      action: open.length ? t('Start review') : t('Open'),
      done: open.length === 0,
      urgent: true,
      body: open.length ? (
        <>
          <span className="text-attn font-medium">{t('{n} of {total} lines need you.', { n: open.length, total: ps.length })}</span>{' '}
          {budgetOpen.length
            ? t(budgetOpen.length === open.length ? 'They run on budget prices: CHF {amount} of direct cost ({share}).' : '{k} of them run on budget prices: CHF {amount} of direct cost ({share}).', {
                k: budgetOpen.length,
                amount: fmt0(budgetDirect),
                share: fmtShare(tot.direct ? budgetDirect / tot.direct : 0),
              }) +
              ' ' +
              t('Enter the supplier quote on the line or confirm the budget price.')
            : t('Check the product or the quantity and confirm.')}
        </>
      ) : (
        <span className="text-muted">{t('Every line that needed you is confirmed. Direct cost is CHF {d}.', { d: fmt2(tot.direct) })}</span>
      ),
    },
    {
      n: 2,
      title: t('Confirm instructions and norms'),
      to: `${base}/instructions`,
      action: t('Open'),
      done: openIns.length === 0,
      urgent: true,
      body: openIns.length ? (
        <>
          <span className="text-attn font-medium">{t('{n} of {total} not confirmed.', { n: openIns.length, total: ins.instructions.length })}</span>{' '}
          {t('{c} add cost and {r} are risks. Each one is quoted from the tender with its page.', { c: costN, r: riskN })}
        </>
      ) : (
        <span className="text-muted">{t('All {n} handled. They go into the pricing report.', { n: ins.instructions.length })}</span>
      ),
    },
    {
      n: 3,
      title: t('Choose the offer price'),
      to: `${base}/pricing`,
      action: t('Open'),
      done: !!chosen,
      urgent: true,
      body: chosen ? (
        <span className="text-muted">
          {t('CHF {bid} · {name}, {m}% margin · {w} win chance.', { bid: fmt0(chosen.bid), name: t(chosen.name), m: chosen.margin_pct.toFixed(1), w: fmtShare(chosen.win) })}
          {!pcOn && ' ' + t('Project costs are not in the price.')}
        </span>
      ) : (
        <>
          <span className="text-attn font-medium">{t('Not chosen yet.')}</span>{' '}
          {!pcOn && t('Project costs are not in the price (CHF {pc} if all are switched on).', { pc: fmt0(allProjectCosts(tot)) }) + ' '}
          {t('At the standard {m}% margin the price would be CHF {p}.', { m: std.toFixed(1), p: fmt0(tot.standard_price) })}
        </>
      ),
    },
    {
      n: 4,
      title: t('Export and submit'),
      to: `${base}/export`,
      action: t('Open'),
      done: !!tender.submission,
      urgent: false,
      body: (
        <span className="text-muted">
          {tender.submission
            ? t('Submitted at CHF {p} on {d}.', { p: fmt0(tender.submission.offer_price), d: fmtDateTime(tender.submission.at) })
            : t('Offer workbook, SIA interface file and pricing report. Open points above do not block the export.')}
        </span>
      ),
    },
    {
      n: 5,
      title: t('After the award: record the outcome'),
      to: `${base}/outcome`,
      action: t('Open'),
      done: !!tender.outcome,
      urgent: false,
      body: (
        <span className="text-muted">
          {tender.outcome
            ? t('Outcome recorded.')
            : t('Winning price and number of bidders from the award notice, so the next tender starts from real numbers.')}
        </span>
      ),
    },
  ]
  const left = steps.slice(0, 3).filter((x) => !x.done).length
  const next = steps.find((x) => !x.done)
  const cta =
    next?.n === 1
      ? open.length === 1
        ? t('Continue: review 1 line')
        : t('Continue: review {n} lines', { n: open.length })
      : next?.n === 2
        ? t('Continue: confirm {n} instructions', { n: openIns.length })
        : next?.n === 3
          ? t('Continue: choose the price')
          : next?.n === 4
            ? t('Continue: export')
            : next
              ? t('Record the outcome')
              : null
  const rule = tender.submission_rule

  return (
    <main className="flex-auto flex flex-wrap items-start">
      <section aria-label={t('What is left')} className="flex-[999_1_640px] min-w-0 px-6 pt-7 pb-10 flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[24px] leading-[1.25] font-semibold">
              {left === 0 ? t('Ready to submit') : left === 1 ? t('1 step left before you can submit') : t('{n} steps left before you can submit', { n: left })}
            </h1>
            <span className="text-muted">
              {left === 0
                ? t('Every line is checked, the instructions are handled and the price is chosen.')
                : t('The tender is read and every line has a first price. This is what still needs you.')}
            </span>
          </div>
          {next && cta && (
            <LinkButton to={next.to} variant="primary">
              {cta}
            </LinkButton>
          )}
        </div>

        <ol className="m-0 p-0 list-none flex flex-col border-t border-ink">
          {steps.map((st, i) => (
            <li
              key={st.n}
              className={cx('grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-4 gap-y-1 items-center py-4', i < steps.length - 1 && 'border-b border-rowrule')}
            >
              <span className={cx('font-mono', st.done ? 'text-ink' : st.urgent ? 'text-attn' : 'text-muted')}>{st.n}</span>
              <span className={cx('text-[16px] font-semibold', !st.urgent && !st.done && st.n === 5 && 'text-muted')}>
                {st.title}
                {st.done && <span className="ml-2.5 text-[13px] font-medium text-ink align-middle">· {t('Done')}</span>}
              </span>
              <LinkButton to={st.to}>{st.action}</LinkButton>
              <span />
              <span className="col-[2/-1]">{st.body}</span>
            </li>
          ))}
        </ol>
      </section>

      <aside aria-label={t('Tender facts')} className="flex-[1_1_360px] max-w-[460px] min-w-0 px-6 pt-7 pb-10 border-l border-rule flex flex-col gap-6">
        <section className="flex flex-col gap-1.5 p-4 border border-ink">
          <span className="text-[13px] text-muted">{t('Submission due')}</span>
          <span className="text-[26px] leading-[1.2] font-semibold">{fmtDaysLeft(tender.due_at, lang)}</span>
          <span className="font-mono">{fmtDateTime(tender.due_at)}</span>
          {rule && (
            <span className="text-[13px] text-muted">
              {lang === 'de' ? rule.text_de : rule.text_en} {t('Read from the tender, p. {page}.', { page: rule.page })}{' '}
              <button type="button" onClick={() => setPageOpen(true)} className="border-0 bg-transparent p-0 min-h-0 text-accent underline underline-offset-2">
                {t('Show on page')}
              </button>
            </span>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[15px] font-semibold">{t('Price so far')}</h2>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
            <span className="py-[7px] border-b border-rowrule">{t('Direct cost, {n} lines', { n: ps.length })}</span>
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
            {chosen ? t('Chosen by you in Pricing. You can still change it.') : t('Not the offer price yet. It becomes final in step 3.')}
          </span>
        </section>

        <section className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[15px] font-semibold">{t('Tender')}</h2>
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <span className="text-muted">{t('Client')}</span>
            <span>{tender.client}</span>
            <span className="text-muted">{t('Trade')}</span>
            <span>{tender.trade}</span>
            <span className="text-muted">{t('Document')}</span>
            <span className="break-words">
              {tender.file_name} · {t('{n} pages', { n: tender.page_count })}
            </span>
            <span className="text-muted">{t('Priced with')}</span>
            <span>
              {t('Catalogue ({p} products) and install rules ({r}) from', { p: ref?.catalog.length ?? 56, r: ref?.rules.length ?? 22 })}{' '}
              <Link to="/reference">{t('Reference data')}</Link>
            </span>
          </div>
        </section>
      </aside>
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
