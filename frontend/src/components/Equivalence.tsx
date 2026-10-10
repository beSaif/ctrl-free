// "Tender asks · We offer": the attribute comparison between the tender line and a catalogue product
// (equivalent products across manufacturers), the make rule, the learned-match badge and
// "Apply to N similar lines". Used on Line detail's Product row and on Change product.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { useUndo } from '../api/hooks'
import { lineExtras, useApplySimilar, type ApplySimilarResult, type Comparison, type CompareRow, type LearnedRef, type MakeRule, type Verdict } from '../api/learned'
import type { Position } from '../api/types'
import { Button, IconCheck, IconChevron } from './ui'
import { cx } from '../lib/cx'
import { fmtShortDate } from '../lib/format'
import { C } from '../lib/lines'

const VERDICT_FG: Record<Verdict, string> = { same: C.ink, equivalent: C.ink, differs: C.attn, unknown: C.faint }

function matchLabel(label: string, t: T) {
  const k = 'match.' + label
  return t(k) === k ? label : t(k)
}

function verdictWord(v: Verdict, t: T) {
  return { same: t('Same'), equivalent: t('Equivalent'), differs: t('Differs'), unknown: t('Not stated') }[v]
}

export function VerdictMark({ v }: { v: Verdict }) {
  const t = useT()
  return (
    <span className="inline-flex items-center justify-center w-3.5 font-mono" style={{ color: VERDICT_FG[v] }} title={verdictWord(v, t)}>
      {v === 'same' ? <IconCheck size={11} /> : v === 'equivalent' ? '≈' : v === 'differs' ? '×' : '?'}
      <span className="sr-only">{verdictWord(v, t)}</span>
    </span>
  )
}

/** "type ✓ size ✓ unit ✓": one mark per compared attribute. */
export function CompareChecks({ cmp, className }: { cmp: Comparison; className?: string }) {
  const t = useT()
  const lang = useLang()
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5', className)}>
      {cmp.summary.checks.map((c) => (
        <span key={c.key} className="inline-flex items-center gap-0.5" style={{ color: c.verdict === 'differs' ? C.attn : undefined }}>
          {lang === 'en' ? t(c.attribute).toLowerCase() : t(c.attribute)} <VerdictMark v={c.verdict} />
        </span>
      ))}
    </span>
  )
}

function makeKindLabel(kind: MakeRule['kind'] | undefined, t: T) {
  if (kind === 'example') return t('example make')
  if (kind === 'named') return t('make named')
  if (kind === 'prescribed') return t('prescribed make')
  if (kind === 'open') return t('make left open')
  return ''
}

/** One sentence on how the tender names the make, and what that means for our product. */
function makeRuleSentence(rule: MakeRule | null, t: T, otherwiseDiffers = false): string | null {
  if (!rule) return null
  const named = [rule.make, rule.model].filter(Boolean).join(' ')
  const vr = rule.variant_rule
  if (rule.kind === 'example')
    return rule.manufacturer_differs && !otherwiseDiffers
      ? t('The tender names {make} as an example ("{w}"): an equivalent product from another make is fine, no variant needed.', { make: named, w: rule.wording ?? 'z.B.' })
      : t('The tender names {make} as an example ("{w}").', { make: named, w: rule.wording ?? 'z.B.' })
  if (rule.kind === 'prescribed') {
    const how = rule.wording ? `"${rule.wording}"` : t('without "or equivalent"')
    if (!rule.variant_needed) return t('The tender prescribes {make} ({how}).', { make: named, how })
    return vr
      ? t('The tender prescribes {make} ({how}). {mf} is another make: offer it as a variant with a reason ({rule}, p. {page}).', {
          make: named,
          how,
          mf: rule.product_manufacturer ?? t('Our product'),
          rule: vr.type,
          page: vr.page,
        })
      : t('The tender prescribes {make} ({how}). {mf} is another make: offer it as a variant with a reason.', {
          make: named,
          how,
          mf: rule.product_manufacturer ?? t('Our product'),
        })
  }
  if (rule.kind === 'named')
    return rule.manufacturer_differs && !otherwiseDiffers
      ? t('The tender names {make} without "or equivalent". We offer an equivalent product from another make, as Equans prices these lines.', { make: named })
      : t('The tender names {make}.', { make: named })
  if (rule.kind === 'open') return t('The tender leaves the make for you to fill in: any product that meets the description.')
  return null
}

/** Materials and "with actuator" are a small fixed vocabulary: shown in the UI language. */
function value(r: CompareRow, v: string, t: T) {
  return r.key === 'material' || r.key === 'actuator' ? t(v) : v
}

function Row({ r }: { r: CompareRow }) {
  const t = useT()
  return (
    <>
      <span className="py-1.5 border-t border-rowrule flex flex-col">
        <span className="text-muted">{t(r.attribute)}</span>
        <span className="inline-flex items-center gap-1 text-[12.5px]" style={{ color: VERDICT_FG[r.verdict] }}>
          <VerdictMark v={r.verdict} />
          {verdictWord(r.verdict, t)}
        </span>
      </span>
      <span className="py-1.5 border-t border-rowrule min-w-0 flex flex-col">
        <span>{r.tender ? value(r, r.tender, t) : r.key === 'make' ? t('left open') : '–'}</span>
        {r.snippet && <span className="text-[12.5px] text-muted whitespace-pre-line break-words">«{r.snippet}»</span>}
      </span>
      <span className="py-1.5 border-t border-rowrule min-w-0 flex flex-col">
        <span>{r.product ? value(r, r.product, t) : '–'}</span>
        {r.note && <span className="text-[12.5px] text-muted">{t(r.note)}</span>}
      </span>
    </>
  )
}

/** Compact "Tender asks · We offer" with a one-line summary; expands into the attribute table. */
export function ComparisonPanel({ cmp, rule, defaultOpen, title }: { cmp: Comparison; rule?: MakeRule | null; defaultOpen?: boolean; title?: string }) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen ?? cmp.verdict === 'differs')
  const kind = makeKindLabel(cmp.summary.make_kind, t)
  const sentence = makeRuleSentence(rule ?? null, t, cmp.verdict === 'differs')
  return (
    // the differing checks are already orange in the summary, so the box itself stays neutral
    <div className="flex flex-col border border-rule">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-start gap-2 w-full px-2.5 py-2 border-0 bg-white text-left text-ink hover:bg-panel"
      >
        <span className="mt-[3px]">
          <IconChevron open={open} />
        </span>
        <span className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[12.5px] text-muted">{title ?? t('Tender asks · We offer')}</span>
          <span className="text-[13.5px] break-words">
            {cmp.summary.tender ?? '–'}
            {kind && <span className="text-muted"> ({kind})</span>}
            <span className="text-muted"> → </span>
            {cmp.summary.product ?? cmp.product_id}
          </span>
          <span className="text-[13px] flex flex-wrap items-center gap-x-2">
            <span className="font-medium" style={{ color: VERDICT_FG[cmp.verdict] }}>
              {verdictWord(cmp.verdict, t)}:
            </span>
            <CompareChecks cmp={cmp} />
          </span>
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-2">
          <div className="grid grid-cols-[112px_minmax(0,1.2fr)_minmax(0,1fr)] gap-x-3 text-[13px]">
            <span className="py-1 text-[12.5px] text-muted" />
            <span className="py-1 text-[12.5px] text-muted font-medium">{t('Tender asks')}</span>
            <span className="py-1 text-[12.5px] text-muted font-medium">{t('We offer')}</span>
            {cmp.rows.map((r) => (
              <Row key={r.key} r={r} />
            ))}
          </div>
          {sentence && <span className="text-[13px]" style={{ color: rule?.variant_needed ? C.attn : C.muted }}>{sentence}</span>}
          <span className="text-[12.5px] text-faint">{t('Compared in code from the tender text and the catalogue row; "Not stated" means one side does not say.')}</span>
        </div>
      )}
    </div>
  )
}

/** "Learned from Oberglatt LV0021": this line's product comes from an estimator's earlier decision. */
export function LearnedBadge({ learned }: { learned: LearnedRef }) {
  const t = useT()
  const lang = useLang()
  return (
    <span className="self-start inline-flex flex-wrap items-center gap-x-1.5 px-2 py-[3px] border border-accent text-[12.5px] text-accent">
      <Link to={`/reference?tab=learned&rule=${encodeURIComponent(learned.rule_id)}`} className="no-underline hover:underline" title={t('See what was learned and how often it was confirmed')}>
        {t('Learned from {tender} {lv}', { tender: learned.tender_name ?? learned.tender_id, lv: learned.lv_id })}
      </Link>
      <span className="text-muted">· {t('chosen by {who} on {when}', { who: t(learned.by === 'You' ? 'you' : learned.by), when: fmtShortDate(learned.at, lang) })}</span>
    </span>
  )
}

function ApplySimilar({ tenderId, p }: { tenderId: string; p: Position }) {
  const t = useT()
  const { similar } = lineExtras(p)
  const apply = useApplySimilar(tenderId)
  const undo = useUndo(tenderId)
  const [done, setDone] = useState<ApplySimilarResult | null>(null)
  if (done)
    return (
      <span className="flex flex-wrap items-center gap-x-2.5 text-[13px]">
        <span>{done.applied === 1 ? t('Applied to 1 similar line.') : t('Applied to {n} similar lines.', { n: done.applied })}</span>
        {done.log_id && (
          <Button
            variant="link"
            className="text-[13px]"
            disabled={undo.isPending}
            onClick={async () => {
              await undo.mutateAsync(done.log_id!)
              setDone(null)
            }}
          >
            {t('Undo')}
          </Button>
        )}
      </span>
    )
  if (!similar || similar.count === 0) return null
  return (
    <div className="flex flex-col gap-1 mt-1 px-2.5 py-2 border border-rule">
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Button
          size="xs"
          disabled={apply.isPending}
          onClick={async () => {
            try {
              setDone(await apply.mutateAsync(p.lv_id))
            } catch {
              /* shown below */
            }
          }}
        >
          {similar.count === 1 ? t('Apply to 1 similar line in this tender') : t('Apply to {n} similar lines in this tender', { n: similar.count })}
        </Button>
        <span className="text-[12.5px] text-muted">
          {similar.confirm ? t('Sets {p} and confirms them, as on this line.', { p: similar.product_id }) : t('Sets {p}, as on this line.', { p: similar.product_id })}
        </span>
      </span>
      <span className="text-[12.5px] text-muted">
        {t('Same tender wording')}: <span className="font-mono">{similar.label}</span>
      </span>
      <span className="flex flex-wrap gap-x-2 text-[12.5px] font-mono">
        {similar.lv_ids.map((x) => (
          <Link key={x} to={`/t/${tenderId}/lines/${x}`}>
            {x}
          </Link>
        ))}
      </span>
      {apply.error && <span role="alert" className="text-[13px] text-attn">{apply.error instanceof Error ? apply.error.message : t('Could not save.')}</span>}
    </div>
  )
}

/** Below the product on Line detail: learned badge, Tender asks · We offer, Apply to similar lines. */
export function ProductEquivalence({ tenderId, p }: { tenderId: string; p: Position }) {
  const t = useT()
  const x = lineExtras(p)
  return (
    <>
      {x.learned && <LearnedBadge learned={x.learned} />}
      {x.learned && x.rulesPick && (
        <span className="text-[12.5px] text-muted">
          {x.rulesPick.product_id
            ? t('Without what you taught, the code would pick {p} ({l}).', { p: x.rulesPick.product_id, l: matchLabel(x.rulesPick.label, t) })
            : t('Without what you taught, the code found no product.')}
        </span>
      )}
      {x.comparison && (
        <div className="mt-1">
          <ComparisonPanel key={p.lv_id + x.comparison.product_id} cmp={x.comparison} rule={x.makeRule} defaultOpen={false} />
        </div>
      )}
      {!x.comparison && x.makeRule && makeRuleSentence(x.makeRule, t) && <span className="text-[13px] text-muted">{makeRuleSentence(x.makeRule, t)}</span>}
      <ApplySimilar key={p.lv_id} tenderId={tenderId} p={p} />
    </>
  )
}
