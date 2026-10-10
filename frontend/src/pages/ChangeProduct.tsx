// N05 Change product: the closest catalogue products with why / unit price / line total / change,
// live line total and price at standard margin, variant warning with the tender's rule.
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useT } from '../i18n'
import { useCandidates, useInstructions, usePatchPosition, usePosition, usePricing, useReference, useTender } from '../api/hooks'
import type { Candidate } from '../api/types'
import { Button, ErrorBox, IconBack, LinkButton, Loading, SearchBox, TextInput } from '../components/ui'
import { cx } from '../lib/cx'
import { PdfCrop } from '../components/PdfCrop'
import { CompareChecks, ComparisonPanel } from '../components/Equivalence'
import { candidateComparison, candidateTag, isVariantOf, lineExtras } from '../api/learned'
import { fmt0, fmt2, fmtQty, fmtSigned, fmtUnit } from '../lib/format'
import { standardPriceFor } from '../lib/pricing'

const GRID = 'grid grid-cols-[28px_minmax(0,1.3fr)_88px_minmax(0,1.4fr)_96px_92px] gap-x-3'

export function ChangeProduct() {
  const { id = '', lv = '' } = useParams()
  const [params] = useSearchParams()
  const t = useT()
  const nav = useNavigate()
  const back = `/t/${id}/lines/${lv}${params.toString() ? '?' + params.toString() : ''}`
  const { data: p, isLoading, error } = usePosition(id, lv)
  const { data: tender } = useTender(id)
  const { data: pr } = usePricing(id)
  const { data: ref } = useReference()
  const { data: ins } = useInstructions(id)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => {
    const h = setTimeout(() => setDq(q), 250)
    return () => clearTimeout(h)
  }, [q])
  const cq = useCandidates(id, lv, searching ? dq : '')
  const base = useCandidates(id, lv, '')
  const patch = usePatchPosition(id)
  const [picked, setSel] = useState<string | null>(null)
  const [typed, setReason] = useState<string | null>(null)
  const reasonRef = useRef<HTMLInputElement>(null)
  const sel = picked ?? p?.overrides?.product_id ?? p?.match?.product_id ?? null
  const reason = typed ?? p?.variant_reason ?? ''

  if (isLoading) return <Loading label={t('Loading')} />
  if (!p) return <ErrorBox error={error} label={t('This line was not found.')} />

  const list: Candidate[] = cq.data ?? []
  const all = [...(base.data ?? []), ...list]
  const current = all.find((c) => c.current) ?? null
  const suggestedId = p.match?.product_id ?? null
  const chosen = all.find((c) => c.product_id === sel) ?? null
  const curTotal = p.pricing?.direct ?? current?.line_total ?? 0
  const lineTotal = chosen?.line_total ?? curTotal
  const delta = lineTotal - curTotal
  const priceNow = pr?.totals.standard_price ?? null
  const priceNew = chosen?.standard_price ?? standardPriceFor(pr, delta)
  // a variant under the tender's rule: the product differs from what the tender specifies (an attribute, or a
  // prescribed make). Another make's equivalent product is no variant. Without comparisons: any other product.
  const ex = lineExtras(p)
  const chosenCmp = chosen ? candidateComparison(chosen) : null
  const compared = all.some((c) => candidateComparison(c))
  const isVariant = !!sel && (compared ? isVariantOf(chosenCmp) : sel !== suggestedId)
  const unchanged = sel === (current?.product_id ?? p.overrides?.product_id ?? suggestedId)
  const variantRule = ins?.instructions.find((i) => /variant/i.test(i.type))
  const needReason = isVariant && !reason.trim()
  const reasonOnly = unchanged && isVariant && reason.trim() !== (p.variant_reason ?? '')
  const differs = (chosenCmp?.rows ?? []).filter((r) => r.verdict === 'differs')
  const sysName = p.system.replace(/^\d+(\.\d+)*\s+/, '')
  const makeCaption =
    ex.makeRule && ex.makeRule.kind !== 'none'
      ? ex.makeRule.kind === 'example'
        ? t('The tender names {make} as an example ("{w}"). An equivalent product from another make is fine.', {
            make: [ex.makeRule.make, ex.makeRule.model].filter(Boolean).join(' '),
            w: ex.makeRule.wording ?? 'z.B.',
          })
        : ex.makeRule.kind === 'prescribed'
          ? t('The tender prescribes {make}. Another make is a variant and needs a reason.', { make: [ex.makeRule.make, ex.makeRule.model].filter(Boolean).join(' ') })
          : t('The tender leaves the make for you to fill in: any product that meets the description.')
      : null

  const use = async () => {
    if (!sel) return
    if (needReason) {
      reasonRef.current?.focus()
      return
    }
    await patch.mutateAsync({ lv, body: { product_id: sel === suggestedId ? null : sel, variant_reason: isVariant ? reason.trim() : null } })
    nav(back)
  }

  return (
    <div className="flex-auto flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5 border-b border-rule">
        <LinkButton to={back} size="sm" className="pl-2.5">
          <IconBack />
          {t('Back to the line')}
        </LinkButton>
        <span className="flex-auto" />
        <span className="text-[13px] text-muted">{t('Change product for one line')}</span>
      </div>

      <main className="flex-auto flex justify-center px-6 pt-7 pb-12">
        <div className="w-full max-w-[1240px] flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] text-muted">
              {p.lv_id} · {t('p. {page}', { page: p.page })} · {sysName}
            </span>
            <h1 className="m-0 text-[26px] leading-[1.25] font-semibold">{t('Change product')}</h1>
            <span className="text-muted">
              {p.title_de} · {fmtQty(p.pricing?.quantity ?? p.quantity)} {fmtUnit(p.unit)}
            </span>
          </div>

          <div className="flex flex-wrap items-start gap-x-10 gap-y-7">
            <div className="flex-[1_1_400px] min-w-0">
              {p.source && (
                <PdfCrop
                  tenderId={id}
                  source={p.source}
                  pageCount={tender?.page_count}
                  caption={
                    makeCaption ??
                    (p.make_hint
                      ? t('The tender names a make as an example ("z.B"). Another make is allowed as a variant with a reason.')
                      : t('The tender names no make. Pick the product that fits the text.'))
                  }
                />
              )}
            </div>

            <section className="flex-[1_1_560px] min-w-0 flex flex-col gap-3.5">
              <fieldset className="m-0 p-0 border-0">
                <legend className="pb-2 font-semibold text-[15px]">
                  {searching && dq ? t('Products matching “{q}”', { q: dq }) : t('The {n} closest products in the catalogue', { n: (base.data ?? []).length || 5 })}
                </legend>
                {searching && (
                  <SearchBox value={q} onChange={setQ} label={t('Search all products')} placeholder={t('Search by name, size or product id')} className="mb-2 max-w-[420px]" />
                )}
                <div className="overflow-x-auto">
                  <div className="min-w-[640px]" role="radiogroup" aria-label={t('Products')}>
                    <div className={cx(GRID, 'py-1.5 border-b border-ink text-[13px] text-muted font-medium')}>
                      <span />
                      <span>{t('Product')}</span>
                      <span className="text-right">{t('Unit price')}</span>
                      <span>{t('Why it is listed')}</span>
                      <span className="text-right">{t('Line total')}</span>
                      <span className="text-right">{t('Change')}</span>
                    </div>
                    {(cq.isLoading ? [] : list).map((c) => {
                      const on = c.product_id === sel
                      const d = (c.line_total ?? 0) - curTotal
                      const cmp = candidateComparison(c)
                      const tag = candidateTag(c)
                      return (
                        <button
                          key={c.product_id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setSel(c.product_id)}
                          className={cx(GRID, 'items-center w-full min-h-[52px] py-1.5 border-0 border-b border-rowrule text-left text-ink', on ? 'bg-sel' : 'bg-white hover:bg-panel')}
                        >
                          <span className="inline-flex w-4 h-4 ml-1.5 border-[1.5px] border-ink rounded-full items-center justify-center" aria-hidden="true">
                            <span className="w-2 h-2 rounded-full" style={{ background: on ? '#121212' : 'transparent' }} />
                          </span>
                          <span className="flex flex-col min-w-0">
                            <span className="font-medium">
                              {c.description ?? c.product_id}
                              {c.product_id === suggestedId && <span className="text-accent text-[12.5px] font-normal">{'  · ' + t(tag === 'learned' ? 'learned from you' : 'suggested match')}</span>}
                              {tag === 'rules_pick' && <span className="text-muted text-[12.5px] font-normal">{'  · ' + t('code’s own pick')}</span>}
                              {c.supplier_quote_required && <span className="text-attn text-[12.5px] font-normal">{'  · ' + t('budget price')}</span>}
                            </span>
                            <span className="font-mono text-[12.5px] text-muted">
                              {c.product_id}
                              {c.model ? ` · ${c.manufacturer ? c.manufacturer + ' ' : ''}${c.model}` : ''}
                            </span>
                          </span>
                          <span className="font-mono text-right">{fmt2(c.unit_price ?? c.net_cost_chf)}</span>
                          <span className="flex flex-col gap-0.5 min-w-0">
                            <span className={c.product_id === suggestedId ? 'text-ink' : 'text-muted'}>{c.why}</span>
                            {cmp && <CompareChecks cmp={cmp} className="text-[12.5px] text-muted" />}
                          </span>
                          <span className="font-mono text-right">{fmt2(c.line_total)}</span>
                          <span className="font-mono text-right text-muted">{c.current ? t('current') : fmtSigned(c.diff ?? d)}</span>
                        </button>
                      )
                    })}
                    {cq.isLoading && <div className="py-4 text-muted">{t('Loading')}</div>}
                    {!cq.isLoading && list.length === 0 && <div className="py-4 text-muted">{t('No product matches.')}</div>}
                  </div>
                </div>
              </fieldset>

              <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
                <button
                  type="button"
                  onClick={() => {
                    setSearching((v) => !v)
                    setQ('')
                  }}
                  className="min-h-8 p-0 border-0 bg-transparent text-accent underline underline-offset-2"
                >
                  {searching ? t('Back to the closest products') : t('Search all {n} products', { n: ref?.catalog.length ?? 56 })}
                </button>
                <Link to={back} className="inline-flex items-center min-h-8 underline underline-offset-2">{t('None fits: ask a supplier from the line')}</Link>
              </div>

              {chosenCmp && chosen && (
                <ComparisonPanel
                  key={chosen.product_id}
                  cmp={chosenCmp}
                  rule={ex.makeRule ? { ...ex.makeRule, product_manufacturer: chosen.manufacturer ?? null, manufacturer_differs: chosenCmp.rows.some((r) => r.key === 'make' && r.verdict !== 'same'), variant_needed: chosenCmp.rows.some((r) => r.key === 'make' && r.verdict === 'differs') } : null}
                  defaultOpen
                  title={t('Tender asks · We offer with {p}', { p: chosen.product_id })}
                />
              )}
              {compared && !isVariant && sel && sel !== suggestedId && chosenCmp && (
                <span className="text-[13px] text-muted">{t('Equivalent to what the tender asks: no variant needed.')}</span>
              )}

              {isVariant && (
                <section className="flex flex-col gap-2 px-3.5 py-3 border border-attn">
                  <span className="font-semibold text-attn">{t('This differs from what the tender specifies')}</span>
                  {differs.length > 0 && (
                    <span className="text-[13px]">
                      {differs.map((r) => `${t(r.attribute)}: ${r.tender ?? '–'} → ${r.product ?? '–'}`).join(' · ')}
                    </span>
                  )}
                  {variantRule ? (
                    <>
                      <span className="text-[13px] text-muted">
                        {variantRule.type} · p. {variantRule.page}
                        {variantRule.section ? ` · ${variantRule.section}` : ''}
                      </span>
                      <blockquote className="m-0 text-[13.5px] leading-[1.55]">«{variantRule.text_de}»</blockquote>
                    </>
                  ) : (
                    <span className="text-[13px] text-muted">{t('Offering another product than specified usually needs a written reason.')}</span>
                  )}
                  <label className="flex flex-col gap-1 text-[13px] text-muted">
                    {t('Reason for the variant (goes into the offer)')}
                    <TextInput
                      ref={reasonRef}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={t('e.g. technically equivalent, cheaper')}
                      aria-invalid={needReason}
                      required
                    />
                  </label>
                </section>
              )}

              <div className="flex flex-wrap justify-between items-center gap-3 pt-4 border-t border-rule">
                <div className="flex flex-col gap-0.5" aria-live="polite">
                  <span>
                    {t('Line total')} <span className="font-mono font-medium">CHF {fmt2(lineTotal)}</span>{' '}
                    <span className="text-muted">{Math.abs(delta) < 0.005 ? t('unchanged') : t('{d} vs. now', { d: fmtSigned(delta) })}</span>
                  </span>
                  <span className="text-[13px] text-muted">
                    {t('Price at standard margin CHF {p}', { p: fmt0(priceNew) })} ·{' '}
                    {priceNew === priceNow || priceNow === null || priceNew === null
                      ? t('unchanged after rounding to 1’000')
                      : t('{d} vs. now', { d: fmtSigned(priceNew - priceNow, 0) })}
                  </span>
                </div>
                <div className="flex gap-2">
                  <LinkButton to={back}>{t('Cancel')}</LinkButton>
                  <Button variant="primary" onClick={use} disabled={!sel || (unchanged && !reasonOnly) || patch.isPending} title={needReason ? t('Add a reason for the variant') : undefined}>
                    {reasonOnly ? t('Save the reason') : t('Use this product')}
                  </Button>
                </div>
              </div>
              {needReason && !unchanged && <span className="text-[13px] text-attn self-end">{t('Add a reason for the variant first.')}</span>}
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
