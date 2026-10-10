// Tender PDF traceability: a crop of the rendered page around the position's block, with the
// description lines tinted and the quantity line highlighted. "Open full page" shows the page.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT } from '../i18n'
import { pageImageUrl, useApiMode } from '../api/client'
import type { SourceLine } from '../api/types'
import { Button, Dialog } from './ui'

export interface CropSource {
  page: number
  page_size?: number[] | null
  block_bbox?: number[] | null
  qty_bbox?: number[] | null
  lines?: SourceLine[]
}

const DESC_BG = 'var(--color-panel)'
const QTY_BG = 'var(--color-hl)'
const PAD = 10

type Box = [number, number, number, number]
const isBox = (b: unknown): b is Box => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number')

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function highlights(src: CropSource): { box: Box; bg: string }[] {
  const out: { box: Box; bg: string }[] = []
  const withBox = (src.lines ?? []).filter((l) => isBox(l.bbox))
  if (withBox.length) {
    for (const l of withBox) {
      if (l.role === 'qty') out.push({ box: l.bbox as Box, bg: QTY_BG })
      else if (l.role === 'desc') out.push({ box: l.bbox as Box, bg: DESC_BG })
    }
  } else {
    if (isBox(src.block_bbox)) out.push({ box: src.block_bbox, bg: DESC_BG })
  }
  if (isBox(src.qty_bbox) && !out.some((h) => h.bg === QTY_BG)) out.push({ box: src.qty_bbox, bg: QTY_BG })
  return out
}

function unionBox(src: CropSource): Box | null {
  if (isBox(src.block_bbox)) return src.block_bbox
  const bs = (src.lines ?? []).map((l) => l.bbox).filter(isBox)
  if (!bs.length) return null
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]
}

/** Split "Grösse  Ø 10 cm      Stk 5" into description and quantity part. */
function splitQty(text: string): [string, string] {
  const m = text.match(/^(.*?)\s{2,}((?:Stk|St\.|m2|m²|m3|m|kg|psch|LE|h|Std)\.?\s+[\d'.,]+)\s*$/)
  return m ? [m[1], m[2]] : [text, '']
}

/** Text rendering of the source lines, used when the page image is not available. */
export function SourceText({ lines, text }: { lines?: SourceLine[]; text?: string }) {
  const ls: SourceLine[] = lines?.length ? lines : (text ?? '').split('\n').map((t) => ({ text: t, role: 'desc' }))
  return (
    <div className="font-mono text-[12.5px] leading-[1.7] flex flex-col">
      {ls.map((l, i) => {
        const [d, q] = splitQty(l.text)
        const bg = l.role === 'qty' ? QTY_BG : l.role === 'desc' ? DESC_BG : 'transparent'
        return (
          <div key={i} className="flex justify-between gap-3 px-1" style={{ background: bg }}>
            <span className="whitespace-pre-wrap">{d}</span>
            {q && <span className={l.role === 'qty' ? 'flex-none font-semibold' : 'flex-none'}>{q}</span>}
          </div>
        )
      })}
    </div>
  )
}

function PageImage({
  url,
  pageSize,
  crop,
  marks,
  onError,
  maxHeight,
}: {
  url: string
  pageSize: number[]
  crop: Box | null
  marks: { box: Box; bg: string }[]
  onError: () => void
  maxHeight?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [pw, ph] = pageSize
  const c: Box = crop
    ? [Math.max(0, crop[0] - PAD), Math.max(0, crop[1] - PAD), Math.min(pw, crop[2] + PAD), Math.min(ph, crop[3] + PAD)]
    : [0, 0, pw, ph]
  const s = width ? width / (c[2] - c[0]) : 0
  const h = (c[3] - c[1]) * s
  return (
    <div ref={ref} className="relative overflow-hidden bg-white" style={{ height: width ? Math.min(h, maxHeight ?? h) : 120 }}>
      {width > 0 && (
        <>
          <img
            src={url}
            alt=""
            onError={onError}
            className="absolute max-w-none select-none"
            style={{ left: -c[0] * s, top: -c[1] * s, width: pw * s }}
            draggable={false}
          />
          {marks.map((m, i) => (
            <span
              key={i}
              aria-hidden="true"
              className="absolute mix-blend-multiply"
              style={{
                left: (m.box[0] - c[0] - 2) * s,
                top: (m.box[1] - c[1] - 1) * s,
                width: (m.box[2] - m.box[0] + 4) * s,
                height: (m.box[3] - m.box[1] + 2) * s,
                background: m.bg,
              }}
            />
          ))}
        </>
      )}
    </div>
  )
}

export function PdfCrop({
  tenderId,
  source,
  pageCount,
  heading,
  fallback,
  caption,
  pdfLink,
}: {
  tenderId: string
  source: CropSource
  pageCount?: number
  heading?: ReactNode
  fallback?: ReactNode
  caption?: ReactNode
  /** Tender PDF page for this source: replaces the "Open full page" popup with a link to it. */
  pdfLink?: string
}) {
  const t = useT()
  useApiMode()
  const [failedPage, setFailedPage] = useState<number | null>(null)
  const failed = failedPage === source.page
  const [open, setOpen] = useState(false)
  const url = pageImageUrl(tenderId, source.page, 2)
  const crop = unionBox(source)
  const canImage = !!url && !failed && !!source.page_size && source.page_size.length === 2 && !!crop
  return (
    <section className="flex flex-col gap-2">
      <div className="flex justify-between items-baseline gap-3">
        <h2 className="m-0 text-[15px] font-semibold">{heading ?? t('Tender PDF · p. {page}', { page: source.page })}</h2>
        {pdfLink ? (
          <Link to={pdfLink} className="inline-flex items-center min-h-8 text-[13px] underline underline-offset-2">
            {t('Open in Tender PDF')}
          </Link>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="min-h-8 border-0 bg-transparent p-0 text-[13px] text-accent underline underline-offset-2 hover:text-accent-hover">
            {t('Open full page')}
          </button>
        )}
      </div>
      <div className="border border-stone bg-panel p-4">
        <div className="bg-white border border-rule px-[18px] py-4 flex flex-col">
          {canImage ? (
            <PageImage url={url!} pageSize={source.page_size!} crop={crop} marks={highlights(source)} onError={() => setFailedPage(source.page)} maxHeight={420} />
          ) : (
            (fallback ?? <SourceText lines={source.lines} />)
          )}
        </div>
      </div>
      {caption && <span className="text-[13px] text-muted">{caption}</span>}
      <PageViewer open={open} onClose={() => setOpen(false)} tenderId={tenderId} source={source} pageCount={pageCount} fallback={fallback} />
    </section>
  )
}

interface ViewerProps {
  open: boolean
  onClose: () => void
  tenderId: string
  source: CropSource
  pageCount?: number
  fallback?: ReactNode
}

export function PageViewer(props: ViewerProps) {
  // mounted only while open, so it always starts on the source page
  return props.open ? <PageViewerOpen key={props.source.page} {...props} /> : null
}

function PageViewerOpen({ open, onClose, tenderId, source, pageCount, fallback }: ViewerProps) {
  const t = useT()
  const [page, setPage] = useState(source.page)
  const [failed, setFailed] = useState<Record<number, boolean>>({})
  const max = pageCount ?? Math.max(source.page, 1)
  const url = pageImageUrl(tenderId, page, 2)
  const onSource = page === source.page
  const size = source.page_size && source.page_size.length === 2 ? source.page_size : [595, 842]
  const go = (d: number) => setPage((p) => Math.min(max, Math.max(1, p + d)))
  return (
    <Dialog open={open} onClose={onClose} title={t('Tender PDF · p. {page}', { page })} width={900} closeLabel={t('Close')}>
      <div
        className="flex flex-wrap items-center gap-2 px-6 py-2.5 border-b border-rule"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') go(-1)
          if (e.key === 'ArrowRight') go(1)
        }}
      >
        <Button size="sm" onClick={() => go(-1)} disabled={page <= 1}>
          {t('Previous page')}
        </Button>
        <Button size="sm" onClick={() => go(1)} disabled={page >= max}>
          {t('Next page')}
        </Button>
        <span className="text-[13px] text-muted font-mono">{t('p. {page} of {pages}', { page, pages: max })}</span>
        <span className="flex-auto" />
        {!onSource && (
          <Button size="sm" variant="link" onClick={() => setPage(source.page)}>
            {t('Back to p. {page}', { page: source.page })}
          </Button>
        )}
      </div>
      <div className="p-6 bg-panel max-h-[75vh] overflow-auto">
        {url && !failed[page] ? (
          <div className="border border-rule bg-white">
            <PageImage
              url={url}
              pageSize={size}
              crop={null}
              marks={onSource ? highlights(source) : []}
              onError={() => setFailed((f) => ({ ...f, [page]: true }))}
            />
          </div>
        ) : (
          <div className="bg-white border border-rule p-6 flex flex-col gap-4">
            <span className="text-muted">{t('The page image is not available here (demo data). This is the text read from the page:')}</span>
            {onSource ? (fallback ?? <SourceText lines={source.lines} />) : <span className="text-muted">{t('No text for this page in the demo.')}</span>}
          </div>
        )}
      </div>
    </Dialog>
  )
}
