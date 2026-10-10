// N11 Reference data: product catalogue, install rules, default parameters; import a new version.
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLang, useT, type T } from '../i18n'
import { useImportReference, useReference } from '../api/hooks'
import type { ReferenceResponse } from '../api/types'
import { ErrorBox, FilterTabs, Loading, SearchBox, Td, Th } from '../components/ui'
import { fmt2, fmtShortDate, fmtUnit } from '../lib/format'
import { C } from '../lib/lines'
import { PriceLists } from './PriceLists'

type Tab = 'cat' | 'rules' | 'params' | 'lists'
const KIND: Record<Tab, string> = { cat: 'catalog', rules: 'rules', parameters: 'parameters', params: 'parameters', lists: 'price-lists' } as Record<Tab, string>

const FACTOR_SHORT: Record<string, string> = {
  site_efficiency: '÷ site efficiency',
  mounting_height_school: 'height',
  mounting_height_sports_hall: 'height',
  school_logistics: 'logistics',
  timber_interface: 'timber',
}

function num(v: unknown, d = 2) {
  return typeof v === 'number' ? v.toFixed(d) : String(v ?? '–')
}

function paramGroups(p: Record<string, unknown>, t: T) {
  const g = (k: string) => (p[k] ?? {}) as Record<string, unknown>
  const b = g('stretch_bid_optimization')
  const c = g('commercial')
  const a = g('allowances')
  const f = g('productivity_factors')
  const pc = g('project_costs')
  const sm = (b.scenario_margins_pct ?? {}) as Record<string, number>
  const sign = (v: unknown) => (typeof v === 'number' ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) : '–')
  return [
    {
      title: t('Bid model'),
      rows: [
        [t('Reference win chance'), num(b.reference_win_probability)],
        [t('Competition'), sign(b.competition_adjustment)],
        [t('Strategic appetite'), sign(b.strategic_appetite_adjustment)],
        [t('Price sensitivity per 1%'), num(b.price_sensitivity_probability_points_per_1pct_price)],
        [t('Win chance range'), `${num(b.minimum_probability)}–${num(b.maximum_probability)}`],
        [t('Option margins'), Object.values(sm).map((x) => x.toFixed(1)).join(' / ') + '%'],
      ],
    },
    {
      title: t('Commercial'),
      rows: [
        [t('Overhead'), num(c.overhead_pct, 1) + '%'],
        [t('Standard margin'), num(c.target_margin_pct, 1) + '%'],
        [t('Round price to'), 'CHF ' + String(c.round_to_chf ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '’')],
      ],
    },
    {
      title: t('Allowances'),
      rows: [
        [t('Material waste'), num(a.material_waste_pct, 1) + '%'],
        [t('Small material'), num(a.small_material_pct, 1) + '%'],
        [t('Transport and equipment'), num(a.transport_equipment_pct, 1) + '%'],
        [t('Supplier package contingency'), num(a.supplier_package_contingency_pct, 1) + '%'],
      ],
    },
    {
      title: t('Site factors (school)'),
      rows: [
        [t('Site efficiency'), num(f.site_efficiency)],
        [t('School logistics'), '× ' + num(f.school_logistics)],
        [t('Mounting height, school'), '× ' + num(f.mounting_height_school)],
        [t('Mounting height, sports hall'), '× ' + num(f.mounting_height_sports_hall)],
        [t('Timber interface'), '× ' + num(f.timber_interface)],
      ],
    },
    {
      title: t('Project costs'),
      rows: [
        [t('Engineering'), `${pc.engineering_hours ?? '–'} h × ${pc.engineering_rate_chf_per_h ?? '–'}`],
        [t('Commissioning'), `${pc.commissioning_hours ?? '–'} h × ${pc.commissioning_rate_chf_per_h ?? '–'}`],
        [t('Hygiene inspection'), String(pc.hygiene_inspection_chf ?? '–').replace(/\B(?=(\d{3})+(?!\d))/g, '’')],
        [t('Documentation'), String(pc.documentation_chf ?? '–').replace(/\B(?=(\d{3})+(?!\d))/g, '’')],
      ],
    },
  ]
}

function sourceText(data: ReferenceResponse, tab: Tab, lang: 'en' | 'de', t: T) {
  const key = tab === 'cat' ? 'catalog' : tab === 'rules' ? 'rules' : 'parameters'
  const s = data.source?.[key]
  const def = tab === 'cat' ? 'catalog.csv' : tab === 'rules' ? 'productivity.csv' : 'project_parameters.json'
  if (!s) return def
  if (typeof s === 'string') return s
  const file = s.file ?? def
  return s.imported_at ? `${file} · ${t('imported {d}', { d: fmtShortDate(s.imported_at, lang) })}` : file
}

export function Reference() {
  const t = useT()
  const lang = useLang()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'rules' || raw === 'params' || raw === 'lists' ? raw : 'cat'
  const { data, isLoading, error } = useReference()
  const imp = useImportReference()
  const fileRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the reference data.')} />

  const cat = data.catalog.filter((c) => !q.trim() || `${c.product_id} ${c.description} ${c.category} ${c.model}`.toLowerCase().includes(q.toLowerCase()))
  const rules = data.rules
  const supplierN = data.catalog.filter((c) => c.supplier_quote_required || c.source_type === 'supplier_package').length

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 px-6 pt-4 pb-2.5 border-b border-rule">
        <h1 className="m-0 text-[20px] font-semibold">{t('Reference data')}</h1>
        <FilterTabs
          label={t('Reference data')}
          value={tab}
          onChange={(k) => setParams(k === 'cat' ? {} : { tab: k }, { replace: true })}
          items={[
            { key: 'cat', label: t('Product catalogue'), count: data.catalog.length },
            { key: 'rules', label: t('Install rules'), count: rules.length },
            { key: 'params', label: t('Default parameters') },
            { key: 'lists', label: t('Price lists') },
          ]}
        />
        <span className="flex-auto" />
        {tab !== 'lists' && <span className="text-[13px] text-muted">{sourceText(data, tab, lang, t)}</span>}
        <label hidden={tab === 'lists'} className="inline-flex items-center min-h-[34px] px-3.5 border border-ink rounded-[2px] bg-white cursor-pointer hover:bg-panel focus-within:outline-2 focus-within:outline-accent">
          {imp.isPending ? t('Importing…') : t('Import new version')}
          <input
            ref={fileRef}
            type="file"
            accept={tab === 'params' ? '.json,application/json' : '.csv,text/csv'}
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setMsg(null)
              try {
                await imp.mutateAsync({ kind: KIND[tab], file: f })
                setMsg(t('Imported {f}. New tenders start from this version.', { f: f.name }))
              } catch (err) {
                setMsg(t('Import failed: {e}', { e: err instanceof Error ? err.message : String(err) }))
              }
              if (fileRef.current) fileRef.current.value = ''
            }}
          />
        </label>
      </div>
      {msg && (
        <div role="status" className="px-6 py-2 text-[13px] border-b border-rule bg-panel">
          {msg}
        </div>
      )}

      <main className="px-6 pb-8">
        {tab === 'lists' && <PriceLists />}
        {tab === 'cat' && (
          <>
            <div className="py-3">
              <SearchBox value={q} onChange={setQ} label={t('Search products')} placeholder={t('Search products')} className="max-w-[320px]" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse">
                <thead>
                  <tr>
                    <Th>{t('Product')}</Th>
                    <Th>{t('Description')}</Th>
                    <Th>{t('Category')}</Th>
                    <Th>{t('Model')}</Th>
                    <Th>{t('Unit')}</Th>
                    <Th className="text-right">{t('Net cost')}</Th>
                    <Th>{t('Install rule')}</Th>
                    <Th>{t('Price source')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {cat.map((c) => {
                    const sup = c.supplier_quote_required || c.source_type === 'supplier_package'
                    return (
                      <tr key={c.product_id}>
                        <Td className="py-[7px] font-mono text-[13px]">{c.product_id}</Td>
                        <Td className="py-[7px]">{c.description}</Td>
                        <Td className="py-[7px] text-muted">{c.category}</Td>
                        <Td className="py-[7px] text-muted">{[c.manufacturer, c.model].filter(Boolean).join(' ')}</Td>
                        <Td className="py-[7px]">{fmtUnit(c.unit)}</Td>
                        <Td className="py-[7px] text-right font-mono">{fmt2(c.net_cost_chf)}</Td>
                        <Td className="py-[7px] font-mono text-[13px]">{c.install_code}</Td>
                        <Td className="py-[7px]">
                          <span className="inline-flex items-center gap-2" style={{ color: sup ? C.attn : C.muted }}>
                            <span className="w-2 h-2" style={{ background: sup ? C.attn : C.muted }} aria-hidden="true" />
                            {sup ? t('Supplier package') : t('Catalogue')}
                          </span>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2.5 mb-0 text-[13px] text-muted">
              {t('Showing {a} of {b} products.', { a: cat.length, b: data.catalog.length })}{' '}
              {t('{n} "Supplier package" prices are budget figures: lines using them go to Review until a quote is entered.', { n: supplierN })}
            </p>
          </>
        )}

        {tab === 'rules' && (
          <div className="overflow-x-auto pt-2">
            <table className="w-full min-w-[960px] border-collapse">
              <thead>
                <tr>
                  <Th>{t('Rule')}</Th>
                  <Th>{t('Work')}</Th>
                  <Th>{t('Unit')}</Th>
                  <Th className="text-right">{t('Hours per unit')}</Th>
                  <Th>{t('Role')}</Th>
                  <Th className="text-right">{t('CHF / h')}</Th>
                  <Th>{t('Site factors applied')}</Th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const keys = Array.isArray(r.factor_keys) ? r.factor_keys : String(r.factor_keys || '').split('|').filter(Boolean)
                  return (
                    <tr key={r.install_code}>
                      <Td className="py-[7px] font-mono text-[13px]">{r.install_code}</Td>
                      <Td className="py-[7px]">{r.work_type}</Td>
                      <Td className="py-[7px]">{fmtUnit(r.unit)}</Td>
                      <Td className="py-[7px] text-right font-mono">{fmt2(r.base_hours_per_unit)}</Td>
                      <Td className="py-[7px] text-muted">{t(r.labour_role.replace(/_/g, ' '))}</Td>
                      <Td className="py-[7px] text-right font-mono">{r.default_hourly_rate_chf ? r.default_hourly_rate_chf : '–'}</Td>
                      <Td className="py-[7px] text-muted text-[13px]">{keys.map((k) => t(FACTOR_SHORT[k] ?? k)).join(' · ') || '–'}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'params' && (
          <>
            <div className="flex flex-wrap gap-8 pt-4">
              {paramGroups(data.parameters, t).map((g) => (
                <section key={g.title} className="flex-[1_1_300px] flex flex-col">
                  <h2 className="m-0 mb-1.5 text-[15px] font-semibold">{g.title}</h2>
                  {g.rows.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 py-[7px] border-b border-rowrule">
                      <span>{k}</span>
                      <span className="font-mono">{v}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <p className="mt-3.5 mb-0 text-[13px] text-muted">
              {t('These are the starting values for every new tender. In a tender, the estimator overrides them under Pricing; overrides apply to that tender only.')}
            </p>
          </>
        )}
      </main>
    </div>
  )
}
