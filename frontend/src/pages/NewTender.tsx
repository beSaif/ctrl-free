// N02 New tender: dialog over the tender list. Upload the PDF (or use the Oberglatt demo tender);
// the tender shows in the list right away and is read in the background.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useT } from '../i18n'
import { useCreateTender, useReference } from '../api/hooks'
import { Button, Dialog, Field, IconFile, IconUpload, TextInput } from '../components/ui'
import { fmtBytes } from '../lib/format'

/** Count pages in a PDF without a PDF library (good enough for a hint). */
async function countPages(f: File): Promise<number | null> {
  try {
    const buf = await f.slice(0, Math.min(f.size, 40 * 1024 * 1024)).arrayBuffer()
    const txt = new TextDecoder('latin1').decode(buf)
    const n = (txt.match(/\/Type\s*\/Page(?!s)/g) ?? []).length
    return n || null
  } catch {
    return null
  }
}

/** 22.09.2026 10:00 -> 2026-09-22T10:00:00 */
function toIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (!m) return null
  const p = (x: string) => x.padStart(2, '0')
  return `${m[3]}-${p(m[2])}-${p(m[1])}T${p(m[4] ?? '00')}:${m[5] ?? '00'}:00`
}

export function NewTender() {
  const t = useT()
  const nav = useNavigate()
  const create = useCreateTender()
  const { data: ref } = useReference()
  const [file, setFile] = useState<File | null>(null)
  const [pages, setPages] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [client, setClient] = useState('')
  const [trade, setTrade] = useState('')
  const [due, setDue] = useState('')
  const [profile, setProfile] = useState('school')
  const [dragOver, setDragOver] = useState(false)
  const close = () => nav('/')
  const dueIso = due.trim() ? toIso(due) : null
  const dueBad = !!due.trim() && !dueIso

  const pick = async (f: File | undefined | null) => {
    if (!f) return
    setFile(f)
    setPages(null)
    setPages(await countPages(f))
  }

  const submit = async () => {
    if (!file || dueBad) return
    const form = new FormData()
    form.append('file', file)
    if (name.trim()) form.append('name', name.trim())
    if (client.trim()) form.append('client', client.trim())
    if (trade.trim()) form.append('trade', trade.trim())
    if (dueIso) form.append('due_at', dueIso)
    form.append('profile', profile)
    const r = await create.mutateAsync({ form })
    nav(`/?created=${r.id}`)
  }
  const demo = async () => {
    const r = await create.mutateAsync({ demo: true })
    nav(`/?created=${r.id}`)
  }

  return (
    <Dialog
      open
      onClose={close}
      title={t('New tender')}
      closeLabel={t('Close')}
      footer={
        <>
          <Button onClick={demo} disabled={create.isPending} className="mr-auto">
            {t('Use the Oberglatt demo tender')}
          </Button>
          <Button onClick={close}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!file || dueBad || create.isPending}
            title={t('The PDF is read in the background. The tender shows in the list right away and opens as soon as it is priced.')}
          >
            {create.isPending ? t('Creating…') : t('Create tender')}
          </Button>
        </>
      }
    >
      <form
        className="px-6 py-5 flex flex-col gap-[18px]"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="font-semibold">{t('Tender documents')}</span>
          {file ? (
            <div className="grid grid-cols-[20px_minmax(0,1fr)_auto_auto] gap-3 items-center px-3 py-2.5 border border-rule">
              <IconFile />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</span>
              <span className="font-mono text-[13px] text-muted">
                {pages ? `${t('{n} pages', { n: pages })} · ` : ''}
                {fmtBytes(file.size)}
              </span>
              <button type="button" onClick={() => setFile(null)} className="min-h-8 px-2.5 border-0 bg-transparent text-muted hover:text-ink">
                {t('Remove')}
              </button>
            </div>
          ) : (
            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                void pick(e.dataTransfer.files[0])
              }}
              className={`flex items-center gap-3 px-4 py-5 border border-dashed cursor-pointer ${dragOver ? 'border-accent bg-sel' : 'border-stone'}`}
            >
              <IconUpload />
              <span className="flex flex-col">
                <span className="font-medium">{t('Drop the tender PDF here or choose a file')}</span>
                <span className="text-[13px] text-muted">{t('The bill of quantities (LV) as PDF, as you got it from the client.')}</span>
              </span>
              <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
          )}
          {file && (
            <label className="self-start inline-flex items-center min-h-[34px] px-3 border border-rule rounded-[2px] cursor-pointer hover:border-ink focus-within:outline-2 focus-within:outline-accent">
              {t('Replace file')}
              <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3.5">
          <Field label={t('Name')} className="sm:col-span-2">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Read from the tender')} />
          </Field>
          <Field label={t('Client')}>
            <TextInput value={client} onChange={(e) => setClient(e.target.value)} placeholder={t('Read from the tender')} />
          </Field>
          <Field label={t('Trade')}>
            <TextInput value={trade} onChange={(e) => setTrade(e.target.value)} placeholder={t('Read from the tender')} />
          </Field>
          <Field label={t('Submission due')} hint={dueBad ? <span className="text-attn">{t('Use the format 22.09.2026 10:00')}</span> : t('Leave empty: read from the tender')}>
            <TextInput mono value={due} onChange={(e) => setDue(e.target.value)} placeholder="22.09.2026 10:00" aria-invalid={dueBad} />
          </Field>
          <Field label={t('Starting values')} hint={t('You can change every value later in Pricing')}>
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              className="min-h-9 px-2 border border-rule rounded-[2px] bg-white text-[14px] text-ink"
            >
              <option value="school">{t('School building (default parameters)')}</option>
              <option value="sports_hall">{t('Sports hall')}</option>
            </select>
          </Field>
        </div>

        <span className="text-[13px] text-muted">
          {t('Priced with the product catalogue ({p} products) and install rules ({r}) from', { p: ref?.catalog.length ?? 56, r: ref?.rules.length ?? 22 })}{' '}
          <Link to="/reference">{t('Reference data')}</Link>.
        </span>
        {create.error && (
          <span role="alert" className="text-attn">
            {t('Could not create the tender.')} {create.error instanceof Error ? create.error.message : ''}
          </span>
        )}
      </form>
    </Dialog>
  )
}
