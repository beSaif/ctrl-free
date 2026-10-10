// N11 Reference data, "Price lists" tab: supplier price lists and Equans' negotiated prices.
// Lists in priority order (first wins), activate / deactivate, reorder, delete, the rows of one list,
// and the import dialog (column mapping, matched / not matched rows, effect on open tenders).
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useT, plural, type T } from '../i18n'
import {
  previewPriceList,
  useCreatePriceList,
  useDeletePriceList,
  useOrderPriceLists,
  usePatchPriceList,
  usePriceList,
  usePriceLists,
  type Mapping,
  type PriceList,
  type PriceListMeta,
  type PriceListPreview,
  type PriceListRow,
  type PriceListSource,
  type TenderEffect,
} from '../api/priceLists'
import { Button, Dialog, ErrorBox, Field, FilterTabs, IconFile, IconUpload, Loading, Marker, Td, TextInput, Th } from '../components/ui'
import { cx } from '../lib/cx'
import { fmt2, fmtDate, fmtSigned, fmtUnit } from '../lib/format'
import { C } from '../lib/lines'
import { Source } from '../components/Source'

const SELECT = 'min-h-9 px-2 border border-rule rounded-[2px] bg-white text-[14px] text-ink'

function kindLabel(k: string, t: T) {
  return k === 'negotiated' ? t('Equans negotiated') : t('Supplier list')
}

function stateView(l: PriceList, t: T): { label: string; fg: string } {
  if (l.state === 'in_effect') return { label: t('In effect'), fg: C.accent }
  if (l.state === 'not_yet_valid') return { label: t('Valid from {d}', { d: fmtDate(l.valid_from) }), fg: C.attn }
  if (l.state === 'expired') return { label: t('Expired {d}', { d: fmtDate(l.valid_to) }), fg: C.attn }
  return { label: t('Off'), fg: C.muted }
}

function validText(l: Pick<PriceListMeta, 'valid_from' | 'valid_to'>, t: T) {
  if (l.valid_from && l.valid_to) return `${fmtDate(l.valid_from)} – ${fmtDate(l.valid_to)}`
  if (l.valid_from) return t('from {d}', { d: fmtDate(l.valid_from) })
  return t('always')
}

function matchWords(r: PriceListRow, t: T) {
  if (r.match_by === 'product_id') return t('by product id')
  if (r.match_by === 'manufacturer+model') return t('by manufacturer and model')
  if (r.match_by === 'model') return t('by model')
  return ''
}

function problemText(p: string, t: T) {
  const m = /^Unit differs: list says (.*), catalogue (.*)$/.exec(p)
  if (m) return t('Unit differs: list says {a}, catalogue {b}', { a: m[1], b: m[2] })
  const d = /^Same product as row (\d+), which is used$/.exec(p)
  if (d) return t('Same product as row {n}, which is used', { n: d[1] })
  return t(p)
}

function Delta({ v }: { v: number }) {
  return (
    <span className="font-mono" style={{ color: v < -0.005 ? C.accent : v > 0.005 ? C.attn : C.muted }}>
      {fmtSigned(v)}
    </span>
  )
}

/** The tender's name, with its id when several open tenders share the name (the same tender uploaded twice). */
function effectName(e: TenderEffect, all: TenderEffect[]) {
  return all.filter((x) => x.name === e.name).length > 1 ? `${e.tender_id} · ${e.name}` : e.name
}

/** "Oberglatt: 52 lines, direct cost −10'230.97" per open tender. */
function EffectLines({ effect, t }: { effect: TenderEffect[]; t: T }) {
  if (!effect.length) return <span className="text-muted">{t('No open tender')}</span>
  return (
    <span className="flex flex-col gap-0.5">
      {effect.map((e) => (
        <span key={e.tender_id} className="flex flex-col">
          <Delta v={e.direct_delta} />
          <span className="text-[13px] text-muted max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap" title={effectName(e, effect)}>
            {plural(t, e.lines_changed, '1 line', '{n} lines')} · {effectName(e, effect)}
          </span>
        </span>
      ))}
    </span>
  )
}

function Precedence({ t }: { t: T }) {
  const steps = [t('Unit price typed on the line'), t('Supplier quote for this tender'), t('Active price lists, top to bottom'), t('Standard catalogue')]
  return (
    <section className="flex flex-col gap-1.5 py-3.5 border-b border-rule">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="m-0 text-[15px] font-semibold">{t('Which net price a line uses')}</h2>
        <Source label={t('How the order works')} title={t('Which net price a line uses')} className="text-[13px] text-muted">
          <p className="m-0 leading-[1.55]">
            {t('The first that has a price wins. New lists are placed by rule: Equans negotiated prices above supplier lists, the most recent first. Change the order with the arrows; it applies to every tender. Every change re-prices all tenders and logs each line whose unit price moves, with the old and the new price.')}
          </p>
        </Source>
      </div>
      <ol className="m-0 p-0 list-none flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-muted">{i + 1}</span>
            <span className={i === 2 ? 'font-semibold' : ''}>{s}</span>
            {i < steps.length - 1 && <span className="text-faint" aria-hidden="true">›</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}

export function PriceLists() {
  const t = useT()
  const { data, isLoading, error } = usePriceLists()
  const patch = usePatchPriceList()
  const order = useOrderPriceLists()
  const del = useDeletePriceList()
  // the open list lives in the URL (?tab=lists&list=pl_…) so it can be linked
  const [params, setParams] = useSearchParams()
  const selected = params.get('list')
  const setSelected = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (id) n.set('list', id)
      else n.delete('list')
      return n
    }, { replace: true })
  const [importing, setImporting] = useState<PriceListSource | 'pick' | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Price lists need the backend. Start it and reload.')} />
  const lists = data.lists
  const sel = lists.find((l) => l.id === selected) ?? null
  const busy = patch.isPending || order.isPending || del.isPending

  const move = (i: number, d: -1 | 1) => {
    const ids = lists.map((l) => l.id)
    ;[ids[i], ids[i + d]] = [ids[i + d], ids[i]]
    order.mutate(ids)
  }
  const run = async (p: Promise<unknown>, ok: string) => {
    setMsg(null)
    try {
      await p
      setMsg(ok)
    } catch (e) {
      setMsg(t('Could not save: {e}', { e: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <>
      <Precedence t={t} />
      <div className="flex flex-wrap items-center gap-3 py-3">
        <h2 className="m-0 text-[15px] font-semibold">{t('Price lists, in priority order')}</h2>
        <span className="flex-auto" />
        {lists.length > 1 && (
          <Button variant="link" className="text-[13px]" disabled={busy} onClick={() => order.mutate(['default'])}>
            {t('Reset to default order')}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={() => setImporting('pick')}>
          {t('Import price list')}
        </Button>
      </div>
      {msg && (
        <div role="status" className="px-3 py-2 mb-2 text-[13px] border border-rule bg-panel">
          {msg}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse">
          <thead>
            <tr>
              <Th className="w-[84px]">{t('Priority')}</Th>
              <Th>{t('Price list')}</Th>
              <Th>{t('Valid')}</Th>
              <Th>{t('State')}</Th>
              <Th className="text-right">{t('Rows matched')}</Th>
              <Th className="text-right">{t('Prices it sets')}</Th>
              <Th>{t('Effect on open tenders (direct cost)')}</Th>
              <Th className="text-right">{t('Actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l, i) => {
              const st = stateView(l, t)
              return (
                <tr key={l.id} className={cx('cursor-pointer hover:bg-panel', selected === l.id && 'row-selected')} onClick={() => setSelected(selected === l.id ? null : l.id)}>
                  <Td className="py-2">
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono text-[13px] w-5">{i + 1}</span>
                      <Button size="xs" variant="quiet" aria-label={t('Move up')} disabled={busy || i === 0} onClick={(e) => { e.stopPropagation(); move(i, -1) }}>
                        ↑
                      </Button>
                      <Button size="xs" variant="quiet" aria-label={t('Move down')} disabled={busy || i === lists.length - 1} onClick={(e) => { e.stopPropagation(); move(i, 1) }}>
                        ↓
                      </Button>
                    </span>
                  </Td>
                  <Td className="py-2">
                    <span className="flex flex-col">
                      <span className="font-medium">{l.name}</span>
                      <span className="text-[13px] text-muted">
                        {kindLabel(l.kind, t)}
                        {l.supplier ? ` · ${l.supplier}` : ''}
                      </span>
                    </span>
                  </Td>
                  <Td className="py-2 font-mono text-[13px] whitespace-nowrap">{validText(l, t)}</Td>
                  <Td className="py-2">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap" style={{ color: st.fg }}>
                      <Marker color={st.fg} />
                      {st.label}
                    </span>
                  </Td>
                  <Td className="py-2 text-right font-mono">
                    {l.counts.matched} / {l.counts.rows}
                  </Td>
                  <Td className="py-2 text-right font-mono">{l.state === 'in_effect' ? l.counts.in_use : '–'}</Td>
                  <Td className="py-2">
                    <span className="block text-[12px] text-muted">{l.active ? t('compared with it off') : t('if you activate it')}</span>
                    <EffectLines effect={l.effect} t={t} />
                  </Td>
                  <Td className="py-2 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {confirmDel === l.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-[13px]">{t('Delete?')}</span>
                        <Button size="xs" variant="dark" disabled={busy} onClick={() => { setConfirmDel(null); if (selected === l.id) setSelected(null); void run(del.mutateAsync(l.id), t('Deleted {n}. Tenders are re-priced.', { n: l.name })) }}>
                          {t('Delete')}
                        </Button>
                        <Button size="xs" variant="quiet" onClick={() => setConfirmDel(null)}>
                          {t('Cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button
                          size="xs"
                          variant={l.active ? 'secondary' : 'primary'}
                          disabled={busy}
                          onClick={() =>
                            void run(
                              patch.mutateAsync({ id: l.id, patch: { active: !l.active } }),
                              l.active ? t('{n} is off. Tenders are re-priced.', { n: l.name }) : t('{n} is on. Tenders are re-priced.', { n: l.name }),
                            )
                          }
                        >
                          {l.active ? t('Deactivate') : t('Activate')}
                        </Button>
                        <Button size="xs" variant="quiet" disabled={busy} onClick={() => setConfirmDel(l.id)}>
                          {t('Delete')}
                        </Button>
                      </span>
                    )}
                  </Td>
                </tr>
              )
            })}
            <tr>
              <Td className="py-2 font-mono text-[13px] text-muted">{lists.length + 1}</Td>
              <Td className="py-2">
                <span className="flex flex-col">
                  <span className="font-medium">{t('Standard catalogue')}</span>
                  <span className="text-[13px] text-muted">catalog.csv · {t('used when no list has the product')}</span>
                </span>
              </Td>
              <Td className="py-2 font-mono text-[13px]">{t('always')}</Td>
              <Td className="py-2">
                <span className="inline-flex items-center gap-2" style={{ color: C.muted }}>
                  <Marker color={C.muted} />
                  {t('Fallback')}
                </span>
              </Td>
              <Td className="py-2" colSpan={4} />
            </tr>
          </tbody>
        </table>
      </div>

      {!lists.length && (
        <div className="flex flex-col gap-2 mt-4 px-4 py-4 border border-dashed border-stone">
          <span className="font-medium">{t('No price lists yet: every line uses the standard catalogue.')}</span>
          <span className="text-[13px] text-muted">{t("Import a supplier's price list or Equans' negotiated prices as CSV or XLSX. Headers in German or English are recognised.")}</span>
          <DemoButtons files={data.demo_files} onPick={(name) => setImporting({ demo: name })} t={t} />
        </div>
      )}

      {sel && <ListDetail id={sel.id} t={t} />}

      {importing && <ImportDialog start={importing === 'pick' ? null : importing} demoFiles={data.demo_files} onClose={() => setImporting(null)} onDone={(m) => setMsg(m)} />}
    </>
  )
}

function DemoButtons({ files, onPick, t }: { files: { name: string }[]; onPick: (name: string) => void; t: T }) {
  if (!files.length) return null
  return (
    <span className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-muted">{t('Try a demo file:')}</span>
      {files.map((f) => (
        <Button key={f.name} size="xs" onClick={() => onPick(f.name)}>
          <IconFile />
          {f.name}
        </Button>
      ))}
    </span>
  )
}

// ------------------------------------------------------------------ one list's rows

function ListDetail({ id, t }: { id: string; t: T }) {
  const { data, isLoading, error } = usePriceList(id)
  const [flt, setFlt] = useState<'all' | 'used' | 'unmatched'>('all')
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the price list.')} />
  const rows = data.rows_detail.filter((r) => (flt === 'all' ? true : flt === 'used' ? r.in_use : !!r.problem))
  return (
    <section className="flex flex-col gap-2 mt-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="m-0 text-[16px] font-semibold">{data.name}</h2>
        <span className="text-[13px] text-muted">
          {kindLabel(data.kind, t)}
          {data.supplier ? ` · ${data.supplier}` : ''} · {t('valid {v}', { v: validText(data, t) })} · {data.currency} ·{' '}
          <a href={`/api/reference/price-lists/${encodeURIComponent(data.id)}/file`}>{data.original_name}</a> · {t('imported {d}', { d: fmtDate(data.created_at) })}
        </span>
      </div>
      <p className="m-0 text-[13px] text-muted">
        {t('{m} of {r} rows matched a catalogue product; this list sets the price of {u} products ({c} cheaper, {d} dearer than the catalogue).', {
          m: data.counts.matched,
          r: data.counts.rows,
          u: data.counts.in_use,
          c: data.counts.cheaper,
          d: data.counts.dearer,
        })}
      </p>
      <FilterTabs
        label={t('Rows')}
        value={flt}
        onChange={setFlt}
        items={[
          { key: 'all', label: t('All rows'), count: data.rows_detail.length },
          { key: 'used', label: t('Price in use'), count: data.rows_detail.filter((r) => r.in_use).length },
          { key: 'unmatched', label: t('Not matched'), count: data.rows_detail.filter((r) => r.problem).length },
        ]}
      />
      <RowsTable rows={rows} t={t} detail />
    </section>
  )
}

function RowsTable({ rows, t, detail }: { rows: PriceListRow[]; t: T; detail?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] border-collapse">
        <thead>
          <tr>
            <Th>{t('Row')}</Th>
            <Th>{t('In the list')}</Th>
            <Th>{t('Unit')}</Th>
            <Th className="text-right">{t('List net')}</Th>
            <Th>{t('Catalogue product')}</Th>
            <Th className="text-right">{t('Catalogue')}</Th>
            <Th className="text-right">{t('Difference')}</Th>
            {detail && <Th>{t('Price in use')}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = r.product_id || [r.manufacturer, r.model].filter(Boolean).join(' ')
            const diff = r.net_price != null && r.catalog_net != null ? r.net_price - r.catalog_net : null
            return (
              <tr key={r.line}>
                <Td className="py-[7px] font-mono text-[13px] text-muted">{r.line}</Td>
                <Td className="py-[7px]">
                  <span className="flex flex-col">
                    <span>
                      <span className="font-mono text-[13px]">{key || '–'}</span>
                      {r.article_no && <span className="font-mono text-[12px] text-muted"> · {r.article_no}</span>}
                    </span>
                    {r.description && <span className="text-[13px] text-muted">{r.description}</span>}
                  </span>
                </Td>
                <Td className="py-[7px]">{r.unit ? fmtUnit(r.unit) : '–'}</Td>
                <Td className="py-[7px] text-right font-mono">
                  {fmt2(r.net_price)}
                  {r.list_price != null && r.discount_pct ? (
                    <span className="block text-[12px] text-muted">
                      {fmt2(r.list_price)} − {+r.discount_pct.toFixed(2)}%
                    </span>
                  ) : null}
                </Td>
                <Td className="py-[7px]">
                  {r.problem ? (
                    <span className="flex flex-col">
                      {r.matched_product_id && <span className="font-mono text-[13px]">{r.matched_product_id}</span>}
                      <span className="inline-flex items-center gap-2" style={{ color: C.attn }}>
                        <Marker color={C.attn} />
                        {problemText(r.problem, t)}
                      </span>
                    </span>
                  ) : (
                    <span className="flex flex-col">
                      <span className="font-mono text-[13px]">{r.matched_product_id}</span>
                      <span className="text-[12px] text-muted">
                        {r.catalog_description ? `${r.catalog_description} · ` : ''}
                        {matchWords(r, t)}
                      </span>
                    </span>
                  )}
                </Td>
                <Td className="py-[7px] text-right font-mono text-muted">{fmt2(r.catalog_net)}</Td>
                <Td className="py-[7px] text-right">{diff != null ? <Delta v={diff} /> : '–'}</Td>
                {detail && (
                  <Td className="py-[7px] text-[13px]">
                    {r.problem ? (
                      <span className="text-muted">–</span>
                    ) : r.in_use ? (
                      <span style={{ color: C.accent }}>{t('This list')}</span>
                    ) : (
                      <span className="text-muted">
                        {fmt2(r.used_price)} · {r.used_source === 'Catalogue' ? t('Catalogue') : r.used_source}
                      </span>
                    )}
                  </Td>
                )}
              </tr>
            )
          })}
          {!rows.length && (
            <tr>
              <Td colSpan={detail ? 8 : 7} className="py-3 text-muted">
                {t('No rows here.')}
              </Td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ import dialog

function ImportDialog({
  start,
  demoFiles,
  onClose,
  onDone,
}: {
  start: PriceListSource | null
  demoFiles: { name: string }[]
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const t = useT()
  const [src, setSrc] = useState<PriceListSource | null>(start)
  const [prev, setPrev] = useState<PriceListPreview | null>(null)
  const [mapping, setMapping] = useState<Mapping | undefined>(undefined)
  const [meta, setMeta] = useState<PriceListMeta | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [flt, setFlt] = useState<'all' | 'unmatched'>('all')
  const [dragOver, setDragOver] = useState(false)
  const create = useCreatePriceList()

  // re-read the file whenever the mapping or a field that changes matching / priority changes
  const key = JSON.stringify([mapping, meta?.supplier, meta?.kind, meta?.valid_from, meta?.valid_to])
  useEffect(() => {
    if (!src) return
    let stale = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setErr(null)
      try {
        const p = await previewPriceList(src, mapping, meta ?? undefined)
        if (stale) return
        setPrev(p)
        if (!meta) setMeta(p.meta)
      } catch (e) {
        if (!stale) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!stale) setLoading(false)
      }
    }, meta ? 350 : 0)
    return () => {
      stale = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, key])

  const pick = (s: PriceListSource) => {
    setSrc(s)
    setPrev(null)
    setMapping(undefined)
    setMeta(null)
  }
  const save = async (activate: boolean) => {
    if (!src || !prev || !meta) return
    setErr(null)
    try {
      await create.mutateAsync({ src, mapping: mapping ?? prev.mapping, meta, activate })
      onDone(activate ? t('{n} imported and on. Tenders are re-priced.', { n: meta.name }) : t('{n} imported, not active yet.', { n: meta.name }))
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  const fileName = src ? ('file' in src ? src.file.name : src.demo) : ''
  const rows = useMemo(() => (prev ? prev.rows.filter((r) => flt === 'all' || r.problem) : []), [prev, flt])
  const canSave = !!prev && !!meta && !prev.missing.length && !!meta.name.trim() && !create.isPending && !loading
  const set = (k: keyof PriceListMeta) => (e: { target: { value: string } }) => setMeta((m) => (m ? { ...m, [k]: e.target.value || null } : m))

  return (
    <Dialog
      open
      onClose={onClose}
      width={1080}
      title={t('Import price list')}
      closeLabel={t('Close')}
      footer={
        <>
          <Button onClick={onClose} className="mr-auto">
            {t('Cancel')}
          </Button>
          <Button disabled={!canSave} onClick={() => void save(false)}>
            {t('Save, not active')}
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void save(true)}>
            {create.isPending ? t('Saving…') : t('Save and activate')}
          </Button>
        </>
      }
    >
      <div className="px-6 py-5 flex flex-col gap-[18px]">
        {!src ? (
          <>
            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (f) pick({ file: f })
              }}
              className={`flex items-center gap-3 px-4 py-5 border border-dashed cursor-pointer ${dragOver ? 'border-accent bg-sel' : 'border-stone'}`}
            >
              <IconUpload />
              <span className="flex flex-col">
                <span className="font-medium">{t('Drop the price list here or choose a file')}</span>
                <span className="text-[13px] text-muted">{t('CSV or XLSX from the supplier, or Equans’ own negotiated prices. Rows are matched to the catalogue by product id, or by manufacturer and model.')}</span>
              </span>
              <input
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) pick({ file: f })
                }}
              />
            </label>
            <DemoButtons files={demoFiles} onPick={(name) => pick({ demo: name })} t={t} />
          </>
        ) : (
          <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2.5 border border-rule">
            <IconFile />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {fileName}
              {prev?.title_lines.length ? <span className="text-[13px] text-muted"> · {prev.title_lines.filter(Boolean)[0]}</span> : null}
            </span>
            <button type="button" onClick={() => { setSrc(null); setPrev(null); setMeta(null); setMapping(undefined) }} className="min-h-8 px-2.5 border-0 bg-transparent text-muted hover:text-ink">
              {t('Choose another file')}
            </button>
          </div>
        )}

        {err && (
          <div role="alert" className="px-3 py-2 text-[13px] border" style={{ borderColor: C.attn, color: C.attn }}>
            {err}
          </div>
        )}
        {src && !prev && !err && <Loading label={t('Reading the price list…')} />}

        {prev && meta && (
          <>
            <section className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
              <Field label={t('Name')} className="col-span-2">
                <TextInput value={meta.name} onChange={set('name')} />
              </Field>
              <Field label={t('Supplier')}>
                <TextInput value={meta.supplier ?? ''} onChange={set('supplier')} />
              </Field>
              <Field label={t('Kind')}>
                <select value={meta.kind} onChange={set('kind')} className={SELECT}>
                  <option value="negotiated">{t('Equans negotiated')}</option>
                  <option value="supplier">{t('Supplier list')}</option>
                </select>
              </Field>
              <Field label={t('Valid from')}>
                <TextInput type="date" value={meta.valid_from ?? ''} onChange={set('valid_from')} />
              </Field>
              <Field label={t('Valid to (optional)')}>
                <TextInput type="date" value={meta.valid_to ?? ''} onChange={set('valid_to')} />
              </Field>
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="m-0 text-[15px] font-semibold">{t('Columns')}</h2>
              <p className="m-0 text-[13px] text-muted">{t('Found from the file’s headers. Change a column if it is wrong; you need a price and our product id or the model.')}</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                {prev.fields.map((f) => {
                  const v = (mapping ?? prev.mapping)[f.key] ?? ''
                  const needed = prev.missing.includes(f.key)
                  return (
                    <Field key={f.key} label={<span style={needed ? { color: C.attn } : undefined}>{t(f.label)}</span>}>
                      <select
                        value={v}
                        onChange={(e) => setMapping({ ...(mapping ?? prev.mapping), [f.key]: e.target.value || null })}
                        className={SELECT}
                        style={needed ? { borderColor: C.attn } : undefined}
                      >
                        <option value="">{t('not in the file')}</option>
                        {prev.headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )
                })}
              </div>
            </section>

            <section className="flex flex-col gap-2" aria-busy={loading}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="m-0 text-[15px] font-semibold">{t('Preview')}</h2>
                <span className="text-[14px]">
                  {t('{r} rows · {m} matched · {u} not matched · {c} cheaper and {d} dearer than the catalogue', {
                    r: prev.counts.rows,
                    m: prev.counts.matched,
                    u: prev.counts.unmatched,
                    c: prev.counts.cheaper,
                    d: prev.counts.dearer,
                  })}
                </span>
              </div>
              {prev.effect.map((e) => (
                <p key={e.tender_id} className="m-0 px-3 py-2 border border-rule bg-panel text-[14px]">
                  {e.lines_changed ? (
                    <>
                      {t('Activating it re-prices {n} on {t}: direct cost', { n: plural(t, e.lines_changed, '1 line', '{n} lines'), t: effectName(e, prev.effect) })} <Delta v={e.direct_delta} />,{' '}
                      {t('cost incl. transport and overhead')} <Delta v={e.cost_delta} />.
                    </>
                  ) : (
                    t('Activating it changes no price on {t}: lists above it already price these products, or the tender does not use them.', { t: effectName(e, prev.effect) })
                  )}
                </p>
              ))}
              <FilterTabs
                label={t('Rows')}
                value={flt}
                onChange={setFlt}
                items={[
                  { key: 'all', label: t('All rows'), count: prev.rows.length },
                  { key: 'unmatched', label: t('Not matched'), count: prev.counts.unmatched },
                ]}
              />
              <div className={cx('max-h-[360px] overflow-y-auto', loading && 'opacity-60')}>
                <RowsTable rows={rows.slice(0, 500)} t={t} />
              </div>
              {rows.length > 500 && <span className="text-[13px] text-muted">{t('Showing the first 500 rows.')}</span>}
            </section>
          </>
        )}
      </div>
    </Dialog>
  )
}
