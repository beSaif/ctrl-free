// Line detail provenance: what each value on the line (quantity, unit price, hours, waste, labour rate)
// is derived from, opened from the note next to the value. Read-only; data comes from the position,
// the reference bundle (GET /api/reference), the tender's pricing settings and the line's log.
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { getApiMode } from '../api/client'
import type { CatalogRow, LogEntry, Position, PositionPrice, PricingResponse, QuoteGroup, ReferenceResponse, RuleRow } from '../api/types'
import { Source, SrcChange, SrcFoot, SrcRows, SrcStep } from '../components/Source'
import { fmt2, fmtDateTime, fmtNum, fmtQty, fmtShortDate, fmtSigned, fmtUnit } from '../lib/format'
import { factorLabel, roleLabel } from '../lib/lines'
import { lastChange, rec, whoLabel } from '../lib/trace'

export interface Trace {
  tenderId: string
  /** this line's log entries, newest first */
  log: LogEntry[]
  ref?: ReferenceResponse
  pricing?: PricingResponse
  cat: Record<string, CatalogRow>
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

const FILES = { catalog: 'catalog.csv', rules: 'productivity.csv', parameters: 'project_parameters.json' } as const

function useFileLabel() {
  const t = useT()
  const lang = useLang()
  return (ref: ReferenceResponse | undefined, kind: keyof typeof FILES) => {
    const s = ref?.source?.[kind]
    const file = typeof s === 'string' ? s : (s?.file ?? FILES[kind])
    const v = [...(ref?.versions ?? [])].reverse().find((x) => x.kind === kind)
    return v
      ? t('{file} · version {v}, imported {when} by {who}', { file, v: v.version, when: fmtShortDate(v.saved_at, lang), who: whoLabel(v.by, t, true) })
      : t('{file} · version 1 (as delivered)', { file })
  }
}

function RefLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to}>{children}</Link>
}

function Changed({ e, path, fmt, now }: { e: LogEntry; path: string; fmt: (v: unknown) => string; now?: string }) {
  const t = useT()
  const before = rec(e.before)[path]
  return (
    <SrcChange>
      <span className="font-medium">{t('Changed by {who} · {when}', { who: whoLabel(e.by, t, true), when: fmtDateTime(e.at) })}</span>
      <br />
      <span className="font-mono text-[12.5px]">
        {fmt(before)} → {now ?? fmt(rec(e.after)[path])}
      </span>
    </SrcChange>
  )
}

function matchedBy(p: Position, t: T): string {
  const m = p.match
  if (!m?.product_id) return t('No product matched')
  const how =
    m.method === 'llm' || m.method === 'cache'
      ? t('Picked by AI from the {n} closest catalogue products', { n: m.candidates?.length || 5 })
      : m.method === 'learned'
        ? t('Learned from an earlier tender')
        : m.method === 'manual'
          ? t('Picked by hand')
          : t('Picked by the matching rules from the {n} closest catalogue products', { n: m.candidates?.length || 5 })
  return `${how} (${Math.round((m.confidence ?? 0) * 100)}%)`
}

// ---- quantity ---------------------------------------------------------------------------

export function QtySource({ p, trace, label, color }: { p: Position; trace: Trace; label: ReactNode; color: string }) {
  const t = useT()
  const qtyLine = p.source?.lines?.find((l) => l.role === 'qty')?.text
  const ch = p.overrides?.quantity != null ? lastChange(trace.log, 'overrides.quantity') : undefined
  const page = p.source?.page ?? p.page
  const fmtQ = (v: unknown) => (num(v) === null ? t('tender value ({q})', { q: fmtQty(p.quantity) }) : fmtQty(num(v)))
  return (
    <Source label={label} color={color} title={t('Where the quantity comes from')}>
      <SrcStep title={t('Tender')}>
        <SrcRows
          rows={[
            [t('Page'), t('p. {page}', { page })],
            [t('System'), p.system],
            ...(p.section_name ? [[t('Section'), `${p.section ?? ''} ${p.section_name}`.trim()] as [string, string]] : []),
            [t('Quantity read'), `${fmtQty(p.quantity)} ${p.unit_raw ?? fmtUnit(p.unit)}${p.unit_raw && p.unit && p.unit_raw !== p.unit ? ` → ${fmtUnit(p.unit)}` : ''}`],
          ]}
        />
        {qtyLine && (
          <blockquote className="m-0 px-2.5 py-1.5 border border-rule bg-hl font-mono text-[12.5px] whitespace-pre-wrap">«{qtyLine.replace(/\s{2,}/g, '   ')}»</blockquote>
        )}
        {p.variant_de && <span className="text-muted">{t('One size of a block with several sizes: {v}', { v: p.variant_de })}</span>}
        <span className="text-muted">{t('Read by the PDF parser from the line marked on the page crop. The quantity is taken as written; nothing is estimated.')}</span>
      </SrcStep>
      {ch && <Changed e={ch} path="overrides.quantity" fmt={fmtQ} />}
      <SrcFoot>
        <button
          type="button"
          className="p-0 border-0 bg-transparent text-accent underline cursor-pointer"
          onClick={() => document.getElementById('line-tender-crop')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        >
          {t('Show the marked row')}
        </button>
        {getApiMode() === 'real' && (
          <a href={`/api/tenders/${trace.tenderId}/pdf#page=${page}`} target="_blank" rel="noreferrer">
            {t('Open p. {page} of the PDF', { page })}
          </a>
        )}
      </SrcFoot>
    </Source>
  )
}

// ---- unit price -------------------------------------------------------------------------

type CatRow = Partial<CatalogRow> & { price_list?: string | null; price_list_date?: string | null; supplier?: string | null }

function catalogRows(row: CatRow, t: T): [ReactNode, ReactNode][] {
  const list = num(row.list_price_chf)
  const disc = num(row.discount_pct)
  const out: [ReactNode, ReactNode][] = [
    [t('Product'), row.product_id ?? '–'],
    [t('Description'), row.description ?? '–'],
  ]
  const mm = [row.manufacturer, row.model].filter(Boolean).join(' ')
  if (mm) out.push([t('Manufacturer, model'), mm])
  if (row.supplier) out.push([t('Supplier'), row.supplier])
  if (row.price_list) out.push([t('Price list'), row.price_list_date ? `${row.price_list} · ${row.price_list_date}` : row.price_list])
  if (list !== null) out.push([t('List price'), `CHF ${fmt2(list)}`])
  if (disc !== null) out.push([t('Discount'), `${fmtNum(disc, disc % 1 ? 1 : 0)}%`])
  out.push([t('Net price'), `CHF ${fmt2(row.net_cost_chf)} / ${fmtUnit(row.unit)}`])
  return out
}

function NetArithmetic({ row }: { row: CatRow }) {
  const list = num(row.list_price_chf)
  const disc = num(row.discount_pct)
  if (list === null || disc === null) return null
  return (
    <span className="font-mono text-[12.5px] text-muted">
      {fmt2(list)} − {fmtNum(disc, disc % 1 ? 1 : 0)}% = {fmt2(list * (1 - disc / 100))}
    </span>
  )
}

export function UnitPriceSource({
  p,
  trace,
  label,
  color,
  group,
}: {
  p: Position
  trace: Trace
  label: ReactNode
  color: string
  group?: QuoteGroup
}) {
  const t = useT()
  const lang = useLang()
  const fileLabel = useFileLabel()
  const pr = p.pricing
  const pid = p.overrides?.product_id ?? p.match?.product_id ?? p.product?.product_id ?? undefined
  const row: CatRow = { ...(pid ? trace.cat[pid] : {}), ...(p.product ?? {}) }
  const hasRow = !!row.product_id
  const budget = row.supplier_quote_required || row.source_type === 'supplier_package' || pr?.unit_price_source === 'supplier_package'
  const q = p.supplier_quote
  const typed = p.overrides?.unit_price != null ? lastChange(trace.log, 'overrides.unit_price') : undefined
  const quoteEntry = q ? lastChange(trace.log, 'supplier_quote') : undefined
  const prodChange = p.overrides?.product_id ? lastChange(trace.log, 'overrides.product_id') : undefined
  const fmtP = (v: unknown) => (num(v) === null ? t('catalogue price') : `CHF ${fmt2(num(v))}`)
  return (
    <Source label={label} color={color} title={budget ? t('Where the budget and quote prices come from') : t('Where the unit price comes from')}>
      {hasRow ? (
        <SrcStep title={budget ? t('Budget price: catalogue row (supplier package)') : t('Catalogue row')}>
          <SrcRows rows={catalogRows(row, t)} />
          <NetArithmetic row={row} />
          {budget && <span className="text-muted">{t('A supplier package figure is a budget, not a confirmed price. It stays in use until a supplier quote is entered.')}</span>}
          <span className="text-muted">
            {prodChange ? t('Product chosen by {who} · {when}', { who: whoLabel(prodChange.by, t, true), when: fmtDateTime(prodChange.at) }) : matchedBy(p, t)}
          </span>
        </SrcStep>
      ) : (
        <SrcStep title={t('Catalogue row')}>
          <span>{t('This product is not in the catalogue, so there is no budget price.')}</span>
        </SrcStep>
      )}
      {budget && (
        <SrcStep title={t('Supplier quote')}>
          {q ? (
            <SrcRows
              rows={[
                [t('Quoted price'), `CHF ${fmt2(q.unit_price)}`, true],
                [t('From'), q.source || '–'],
                [t('Entered by'), whoLabel(q.by ?? quoteEntry?.by, t)],
                [t('When'), fmtDateTime(q.received_at ?? quoteEntry?.at)],
                ...(num(row.net_cost_chf) !== null ? [[t('Against budget'), fmtSigned(q.unit_price - (row.net_cost_chf as number))] as [string, string]] : []),
              ]}
            />
          ) : (
            <span>
              {t('No quote yet.')}{' '}
              {group
                ? group.sent
                  ? t('Request sent by {who} · {when}.', { who: whoLabel(group.sent_by ?? 'You', t, true), when: fmtShortDate(group.sent_at, lang) })
                  : t('Request not sent yet.')
                : ''}
            </span>
          )}
        </SrcStep>
      )}
      {typed && <Changed e={typed} path="overrides.unit_price" fmt={fmtP} />}
      {pr?.sources?.unit_price && (
        <span className="text-muted">
          {t('Price used')}: <span className="font-mono text-[12.5px]">CHF {fmt2(pr.net_unit_cost)}</span> · {pr.sources.unit_price}
        </span>
      )}
      <SrcFoot>
        <span>{fileLabel(trace.ref, 'catalog')}</span>
        {hasRow && <RefLink to={`/reference?tab=cat&id=${encodeURIComponent(row.product_id!)}`}>{t('Open the row in Reference data')}</RefLink>}
      </SrcFoot>
    </Source>
  )
}

// ---- hours ------------------------------------------------------------------------------

function changedSetting(pricing: PricingResponse | undefined, path: string): { by: string; at: string } | null {
  let cur: unknown = pricing?.settings?.changed_by
  for (const k of path.split('.')) cur = rec(cur)[k]
  const c = rec(cur)
  return typeof c.by === 'string' ? { by: c.by, at: String(c.at ?? '') } : null
}

function ruleFor(trace: Trace, code: string | null | undefined): RuleRow | undefined {
  return code ? trace.ref?.rules.find((r) => r.install_code === code) : undefined
}

function installCodeOf(p: Position): string | null {
  const pr = p.pricing as (PositionPrice & { install_code?: string | null }) | null | undefined
  return pr?.install_code ?? p.overrides?.install_code ?? p.product?.install_code ?? p.match?.install_code ?? null
}

export function HoursSource({ p, trace, label, color, hourly }: { p: Position; trace: Trace; label: ReactNode; color: string; hourly: boolean }) {
  const t = useT()
  const lang = useLang()
  const fileLabel = useFileLabel()
  const pr = p.pricing
  const code = installCodeOf(p)
  const rule = ruleFor(trace, code)
  const typed = p.overrides?.hours != null ? lastChange(trace.log, 'overrides.hours') : undefined
  const calc = pr?.calculated?.hours ?? pr?.calculated_hours
  const fmtH = (v: unknown) => (num(v) === null ? t('install rule') : `${fmt2(num(v))} h`)
  const keys = rule ? (Array.isArray(rule.factor_keys) ? rule.factor_keys : String(rule.factor_keys || '').split('|').filter(Boolean)) : []
  const ruleChange = p.overrides?.install_code ? lastChange(trace.log, 'overrides.install_code') : undefined

  // the arithmetic, one factor at a time
  const steps: string[] = []
  if (pr && !hourly) {
    let h = pr.quantity * pr.base_hours_per_unit
    steps.push(`${fmtQty(pr.quantity)} ${fmtUnit(p.unit)} × ${fmt2(pr.base_hours_per_unit)} h = ${fmt2(h)} h`)
    for (const f of pr.factors) {
      h = f.op === '÷' ? h / f.value : h * f.value
      steps.push(`${f.op} ${f.value.toFixed(2)} ${factorLabel(f.key, t)} = ${fmt2(h)} h`)
    }
  }

  return (
    <Source label={label} color={color} title={t('Where the hours come from')} width={480}>
      {typed && <Changed e={typed} path="overrides.hours" fmt={fmtH} now={`${fmt2(pr?.hours)} h`} />}
      {typed && calc !== undefined && <span className="text-muted">{t('The calculation below gives {h} h and is not used while the typed hours are set.', { h: fmt2(calc) })}</span>}
      {hourly ? (
        <SrcStep title={t('Hourly work')}>
          <span>{t('The tender asks for {h} h on p. {page}. Hours are taken as written: no install rule and no site factors.', { h: fmtQty(p.quantity), page: p.page })}</span>
        </SrcStep>
      ) : !pr ? (
        <span>{t('This line has no price yet, so no hours.')}</span>
      ) : !code ? (
        <span>{t('No install rule for this line, so no hours.')}</span>
      ) : (
        <>
          <SrcStep title={t('Calculation')}>
            <div className="flex flex-col font-mono text-[12.5px]">
              {steps.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </div>
            {calc !== undefined && !typed && Math.abs(calc - pr.hours) >= 0.005 && <span className="text-muted">{t('Rounded: {h} h', { h: fmt2(pr.hours) })}</span>}
          </SrcStep>
          <SrcStep title={t('Install rule {code}', { code })}>
            <SrcRows
              rows={[
                [t('Work'), rule?.work_type ?? '–'],
                [t('Hours per unit'), `${fmt2(pr.base_hours_per_unit)} h / ${fmtUnit(rule?.unit ?? p.unit)}`],
                [t('Role'), roleLabel(pr.role, t)],
                [t('Rate'), `CHF ${fmtNum(pr.rate, 0)}/h`],
              ]}
            />
            <span className="text-muted">
              {ruleChange
                ? t('Rule chosen by {who} · {when}', { who: whoLabel(ruleChange.by, t, true), when: fmtDateTime(ruleChange.at) })
                : t("The product's install code in catalog.csv ({pid}) points to this rule.", { pid: p.overrides?.product_id ?? p.match?.product_id ?? '–' })}
            </span>
          </SrcStep>
          {pr.factors.length > 0 && (
            <SrcStep title={t('Site factors')}>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                {pr.factors.map((f) => {
                  const ch = changedSetting(trace.pricing, `factors.${f.key}`)
                  const def = trace.pricing?.defaults?.factors?.[f.key]
                  return (
                    <div key={f.key} className="contents">
                      <span className="flex flex-col">
                        <span>{factorLabel(f.key, t)}</span>
                        <Link to={`/reference?tab=params&key=productivity_factors.${f.key}`} className="self-start font-mono text-[11.5px]">
                          productivity_factors.{f.key}
                        </Link>
                        {ch && (
                          <span className="text-[12.5px] text-accent">
                            {t('Changed for this tender by {who} · {when} (default {d})', { who: whoLabel(ch.by, t, true), when: fmtShortDate(ch.at, lang), d: def?.toFixed(2) ?? '–' })}
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[12.5px] text-right">
                        {f.op} {f.value.toFixed(2)}
                      </span>
                    </div>
                  )
                })}
              </div>
              {pr.factors.some((f) => f.key === 'mounting_height_sports_hall') && keys.includes('mounting_height_school') && (
                <span className="text-muted">{t("This line is in a sports hall system, so the sports hall ceiling height replaces the rule's school height.")}</span>
              )}
            </SrcStep>
          )}
        </>
      )}
      <SrcFoot>
        <span>{fileLabel(trace.ref, 'rules')}</span>
        {pr && pr.factors.length > 0 && <span>{fileLabel(trace.ref, 'parameters')}</span>}
        {code && !hourly && <RefLink to={`/reference?tab=rules&code=${encodeURIComponent(code)}`}>{t('Open the rule in Reference data')}</RefLink>}
        {pr && pr.factors.length > 0 && <RefLink to={`/t/${trace.tenderId}/pricing`}>{t('Change site factors in Pricing')}</RefLink>}
      </SrcFoot>
    </Source>
  )
}

// ---- labour rate ------------------------------------------------------------------------

export function RateSource({ p, trace, label, hourly }: { p: Position; trace: Trace; label: ReactNode; hourly: boolean }) {
  const t = useT()
  const fileLabel = useFileLabel()
  const pr = p.pricing
  if (!pr) return <>{label}</>
  const code = hourly ? trace.ref?.rules.find((r) => r.labour_role === pr.role)?.install_code : installCodeOf(p)
  return (
    <Source label={label} color="inherit" className="" title={t('Where the labour rate comes from')}>
      <SrcRows
        rows={[
          [t('Role'), roleLabel(pr.role, t)],
          [t('Rate'), `CHF ${fmtNum(pr.rate, 0)}/h`],
          [t('Install rule'), code ?? '–'],
        ]}
      />
      <span className="text-muted">
        {hourly
          ? t('Hourly work: the role is picked from the words of the line (commissioning or engineering, else installer); the rate is that role\'s rate in the install rules.')
          : t('Role and rate are columns of the install rule (labour_role, default_hourly_rate_chf).')}
      </span>
      <span className="font-mono text-[12.5px]">
        {fmt2(pr.hours)} h × CHF {fmtNum(pr.rate, 0)}/h = CHF {fmt2(pr.labour)}
      </span>
      <SrcFoot>
        <span>{fileLabel(trace.ref, 'rules')}</span>
        {code && <RefLink to={`/reference?tab=rules&code=${encodeURIComponent(code)}`}>{t('Open the rule in Reference data')}</RefLink>}
      </SrcFoot>
    </Source>
  )
}

// ---- waste ------------------------------------------------------------------------------

export function WasteSource({ p, trace, label }: { p: Position; trace: Trace; label: ReactNode }) {
  const t = useT()
  const lang = useLang()
  const fileLabel = useFileLabel()
  const pr = p.pricing
  if (!pr) return <>{label}</>
  const def = trace.pricing?.defaults?.material_waste_pct
  const ch = changedSetting(trace.pricing, 'material_waste_pct')
  const w = fmtNum(pr.waste_pct, pr.waste_pct % 1 ? 1 : 0)
  return (
    <Source label={label} color="inherit" className="" title={t('Where the waste allowance comes from')}>
      <SrcRows
        rows={[
          [t('Material waste'), `${w}%`],
          [t('Default'), def !== undefined ? `${fmtNum(def, def % 1 ? 1 : 0)}% · allowances.material_waste_pct` : 'allowances.material_waste_pct'],
        ]}
      />
      {ch ? (
        <SrcChange>{t('Changed for this tender by {who} · {when} (default {d}%)', { who: whoLabel(ch.by, t, true), when: fmtShortDate(ch.at, lang), d: def ?? '–' })}</SrcChange>
      ) : (
        <span className="text-muted">{t('The same allowance applies to every line of the tender.')}</span>
      )}
      <span className="font-mono text-[12.5px]">
        {fmtQty(pr.quantity)} {fmtUnit(p.unit)} × CHF {fmt2(pr.net_unit_cost)} × (1 + {w}%) = CHF {fmt2(pr.material)}
      </span>
      <SrcFoot>
        <span>{fileLabel(trace.ref, 'parameters')}</span>
        <RefLink to="/reference?tab=params&key=allowances.material_waste_pct">{t('Open in Reference data')}</RefLink>
        <RefLink to={`/t/${trace.tenderId}/pricing`}>{t('Change in Pricing')}</RefLink>
      </SrcFoot>
    </Source>
  )
}
