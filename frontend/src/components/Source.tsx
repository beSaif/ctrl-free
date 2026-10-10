// Provenance popover: an inline link-styled trigger (the note next to a value) that opens where the
// value comes from: tender page, catalogue row, install rule, setting, and who changed it.
// Non-modal; Esc or a click outside closes it. It has role="dialog", so page shortcuts
// (J/K/Enter on Line detail) stay quiet while it is open.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { cx } from '../lib/cx'
import { IconClose } from './ui'

const FOCUSABLE = 'a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function Source({
  label,
  title,
  children,
  color,
  className = 'text-[13px]',
  width = 440,
}: {
  /** the trigger text, e.g. "From the install rule" */
  label: ReactNode
  /** popover heading, e.g. "Where the hours come from" */
  title: ReactNode
  children: ReactNode
  color?: string
  /** trigger classes; defaults to the 13px note size, pass '' to inherit */
  className?: string
  width?: number
}) {
  const t = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setPos(null)
    if (refocus) btn.current?.focus()
  }, [])

  // below the trigger, flipped above when there is more room there; kept inside the viewport (scrolls when taller)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = btn.current?.getBoundingClientRect()
      if (!r) return
      const w = Math.min(width, window.innerWidth - 24)
      const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12))
      const h = (pop.current?.scrollHeight ?? 0) + 2
      const below = window.innerHeight - r.bottom - 18
      const above = r.top - 18
      const up = h > below && above > below
      const maxH = Math.max(160, up ? above : below)
      const top = up ? Math.max(12, r.top - 6 - Math.min(h, maxH)) : r.bottom + 6
      setPos((p) => (p && p.top === top && p.left === left && p.width === w && p.maxH === maxH ? p : { top, left, width: w, maxH }))
    }
    place()
    const raf = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, width])

  useEffect(() => {
    if (!open) return
    pop.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        close(true)
      } else if (e.key === 'Tab' && pop.current) {
        const f = Array.from(pop.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (!f.length) return
        const a = f[0]
        const b = f[f.length - 1]
        if (e.shiftKey && (document.activeElement === a || document.activeElement === pop.current)) {
          e.preventDefault()
          b.focus()
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault()
          a.focus()
        }
      }
    }
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node
      if (pop.current?.contains(n) || btn.current?.contains(n)) return
      close(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={cx(
          'inline p-0 border-0 bg-transparent text-left cursor-pointer underline decoration-dotted underline-offset-[3px] hover:decoration-solid',
          className,
        )}
        style={{ color }}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="dialog"
            aria-labelledby={id + '-h'}
            tabIndex={-1}
            className="fixed z-40 bg-white border border-ink flex flex-col outline-none text-[13px] text-ink overflow-y-auto"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: pos?.width ?? width, maxHeight: pos?.maxH ?? 'calc(100vh - 24px)' }}
          >
            <div className="flex justify-between items-center gap-3 pl-3.5 pr-2 py-1.5 border-b border-rule">
              <h3 id={id + '-h'} className="m-0 text-[14px] font-semibold">
                {title}
              </h3>
              <button
                type="button"
                aria-label={t('Close')}
                onClick={() => close(true)}
                className="inline-flex w-8 h-8 border border-transparent rounded-[2px] items-center justify-center bg-white hover:border-rule"
              >
                <IconClose />
              </button>
            </div>
            <div className="px-3.5 py-3 flex flex-col gap-3">{children}</div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** Label / value rows inside a popover (values in mono). */
export function SrcRows({ rows }: { rows: [ReactNode, ReactNode, boolean?][] }) {
  return (
    <div className="grid grid-cols-[minmax(110px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([k, v, accent], i) => (
        <div key={i} className="contents">
          <span className="text-muted">{k}</span>
          <span className={cx('font-mono text-[12.5px] break-words', accent && 'text-accent')}>{v}</span>
        </div>
      ))}
    </div>
  )
}

/** A titled block inside a popover: one step of the derivation chain. */
export function SrcStep({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="m-0 text-[12px] font-medium uppercase tracking-[0.04em] text-muted">{title}</h4>
      {children}
    </section>
  )
}

/** "Changed by Lea · 10 Oct 14:20, was 5": the human edit on top of the calculated value. */
export function SrcChange({ children }: { children: ReactNode }) {
  return <div className="px-2.5 py-2 border-l-[3px] border-accent bg-sel text-[13px]">{children}</div>
}

/** Footer line: the file the value comes from, and links. */
export function SrcFoot({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-2 border-t border-rowrule text-[12.5px] text-muted">{children}</div>
}
