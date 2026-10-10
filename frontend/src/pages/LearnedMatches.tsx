// N11 Reference -> Learned matches: what estimators taught (tender wording -> product), who taught it,
// where and when, and how often it was applied, confirmed and overridden. Disable or delete a rule.
import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { useDeleteLearned, useLearned, useSetLearnedEnabled, type LearnedRule } from '../api/learned'
import { Button, ErrorBox, Loading, Td, Th } from '../components/ui'
import { cx } from '../lib/cx'
import { fmtShortDate, fmtUnit } from '../lib/format'
import { C } from '../lib/lines'
import { Source } from '../components/Source'

const KIND_WORD: Record<string, string> = { taught: 'Taught', confirmed: 'Confirmed', applied: 'Applied', overridden: 'Overridden' }

/** History lines grouped per action, person and tender: "Applied · Assist · 10 Oct · <tender> t_ab12cd · LV0021 LV0068 …". */
function historyGroups(r: LearnedRule) {
  const groups = new Map<string, { key: string; kind: string; by: string; at: string; tender_id: string; tender_name: string | null; exists: boolean; lines: string[] }>()
  for (const e of r.evidence) {
    const key = `${e.kind}|${e.by}|${e.tender_id}`
    const g = groups.get(key) ?? { key, kind: e.kind, by: e.by, at: e.at, tender_id: e.tender_id, tender_name: e.tender_name, exists: e.exists, lines: [] }
    if (!g.lines.includes(e.lv_id)) g.lines.push(e.lv_id)
    if (e.at > g.at) g.at = e.at
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({ ...g, lines: g.lines.sort() })).sort((a, b) => (a.at < b.at ? 1 : -1))
}

function SourceLink({ e }: { e: { tender_id: string; tender_name: string | null; lv_id: string; page?: number; exists: boolean } }) {
  const t = useT()
  const label = `${e.tender_name ?? e.tender_id} · ${e.lv_id}${e.page ? ' · ' + t('p. {page}', { page: e.page }) : ''}`
  return e.exists ? (
    <Link to={`/t/${e.tender_id}/lines/${e.lv_id}`}>{label}</Link>
  ) : (
    <span className="text-muted" title={t('The tender was deleted; what it taught stays.')}>
      {label} · {t('tender deleted')}
    </span>
  )
}

function Status({ r }: { r: LearnedRule }) {
  const t = useT()
  if (r.active) return <span className="text-muted">{t('Applies to new tenders')}</span>
  const [fg, text] = r.stopped === 'overridden' ? [C.attn, t('Stopped: overridden more often than confirmed')] : [C.faint, t('Disabled')]
  return (
    <span className="inline-flex items-center gap-2" style={{ color: fg }}>
      <span className="w-2 h-2 flex-none" style={{ background: fg }} aria-hidden="true" />
      {text}
    </span>
  )
}

function RuleRow({ r, selected }: { r: LearnedRule; selected: boolean }) {
  const t = useT()
  const lang = useLang()
  const toggle = useSetLearnedEnabled()
  const del = useDeleteLearned()
  const [open, setOpen] = useState(selected)
  const [asking, setAsking] = useState(false)
  const product = r.product
  return (
    <Fragment>
      <tr className={cx(selected && 'bg-sel')}>
        <Td className="py-2 align-top">
          <span className="flex flex-col gap-0.5">
            <span>{r.wording_de ?? '–'}</span>
            <span className="font-mono text-[12px] text-muted">{r.label}</span>
          </span>
        </Td>
        <Td className="py-2 align-top">
          <span className="flex flex-col gap-0.5">
            <span>{product?.description ?? r.product_id}</span>
            <span className="font-mono text-[12px] text-muted">
              {r.product_id}
              {product?.manufacturer ? ` · ${product.manufacturer} ${product.model ?? ''}` : ''}
              {r.install_code ? ` · ${t('install rule {c}', { c: r.install_code })}` : ''}
            </span>
            {r.note && <span className="text-[12.5px] text-muted">«{r.note}»</span>}
          </span>
        </Td>
        <Td className="py-2 align-top">
          {r.from ? (
            <span className="flex flex-col gap-0.5">
              <span>{t('{who} · {when}', { who: t(r.from.by), when: fmtShortDate(r.from.at, lang) })}</span>
              <span className="text-[13px]">
                <SourceLink e={r.from} />
              </span>
            </span>
          ) : (
            '–'
          )}
        </Td>
        <Td className="py-2 align-top text-right font-mono">{r.times_applied}</Td>
        <Td className="py-2 align-top text-right font-mono">{r.times_confirmed}</Td>
        <Td className={cx('py-2 align-top text-right font-mono', r.times_overridden > 0 && 'font-semibold')}>
          {r.times_overridden}
        </Td>
        <Td className="py-2 align-top">
          <span className="flex flex-col gap-1">
            <Status r={r} />
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <Button variant="link" className="text-[13px]" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? t('Hide history') : t('History')}
              </Button>
              <Button variant="link" className="text-[13px]" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}>
                {r.enabled ? t('Disable') : t('Enable')}
              </Button>
              {asking ? (
                <span className="inline-flex items-center gap-2 text-[13px]">
                  {t('Delete this rule?')}
                  <Button variant="link" className="text-[13px] text-attn!" disabled={del.isPending} onClick={() => del.mutate(r.id)}>
                    {t('Delete')}
                  </Button>
                  <Button variant="link" className="text-[13px]" onClick={() => setAsking(false)}>
                    {t('Cancel')}
                  </Button>
                </span>
              ) : (
                <Button variant="link" className="text-[13px]" onClick={() => setAsking(true)}>
                  {t('Delete')}
                </Button>
              )}
            </span>
          </span>
        </Td>
      </tr>
      {open && (
        <tr className={cx(selected && 'bg-sel')}>
          <td colSpan={7} className="px-3 pb-3 border-b border-rowrule">
            <div className="flex flex-col gap-1.5 pl-3 border-l border-rule text-[13px]">
              {historyGroups(r).map((g) => (
                <span key={g.key} className="flex flex-wrap gap-x-2">
                  <span className="w-[86px] flex-none" style={{ color: g.kind === 'overridden' ? C.attn : C.ink }}>
                    {t(KIND_WORD[g.kind] ?? g.kind)}
                  </span>
                  <span className="text-muted w-[120px] flex-none">
                    {t(g.by)} · {fmtShortDate(g.at, lang)}
                  </span>
                  <span className="flex flex-wrap gap-x-1.5 min-w-0">
                    <span>{g.tender_name ?? g.tender_id}</span>
                    <span className="font-mono text-[12px] text-faint">{g.tender_id}</span>
                    {!g.exists && <span className="text-muted">· {t('tender deleted')}</span>}
                    <span className="text-muted">·</span>
                    {g.lines.map((x) =>
                      g.exists ? (
                        <Link key={x} to={`/t/${g.tender_id}/lines/${x}`} className="font-mono text-[12.5px]">
                          {x}
                        </Link>
                      ) : (
                        <span key={x} className="font-mono text-[12.5px] text-muted">
                          {x}
                        </span>
                      ),
                    )}
                  </span>
                </span>
              ))}
              {r.unit && <span className="text-muted">{t('Only for lines counted in {u}.', { u: fmtUnit(r.unit) })}</span>}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  )
}

export function LearnedMatches() {
  const t = useT()
  const [params] = useSearchParams()
  const sel = params.get('rule')
  const { data, isLoading, error } = useLearned()
  if (isLoading) return <Loading label={t('Loading')} />
  if (error || !data) return <ErrorBox error={error} label={t('Could not load the learned matches.')} />
  return (
    <div className="flex flex-col gap-3 pt-3">
      <Source label={t('How learning works')} title={t('Learned matches')} className="self-start text-[13px] text-muted">
        <p className="m-0 leading-[1.55]">
          {t(
            'When you change a line’s product, or confirm a match that needed you, ctrl-free remembers it for that tender wording. New tenders use it first and show where it came from; the code’s own pick stays in the list so you can compare. A rule overridden more often than confirmed stops applying.',
          )}
        </p>
      </Source>
      {data.rules.length === 0 ? (
        <div className="px-4 py-6 border border-rule text-muted">
          {t('Nothing learned yet. Change a product on a line, or confirm a weak match, and it shows up here.')}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse">
              <thead>
                <tr>
                  <Th>{t('Tender wording')}</Th>
                  <Th>{t('→ Product')}</Th>
                  <Th>{t('Taught by')}</Th>
                  <Th className="text-right">{t('Applied')}</Th>
                  <Th className="text-right">{t('Confirmed')}</Th>
                  <Th className="text-right">{t('Overridden')}</Th>
                  <Th>{t('Status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((r) => (
                  <RuleRow key={r.id} r={r} selected={r.id === sel} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="m-0 text-[13px] text-muted">
            {t('{a} of {n} rules apply to new tenders. Applied {k} times so far.', { a: data.counts.active, n: data.counts.total, k: data.counts.applied })}
          </p>
        </>
      )}
    </div>
  )
}
