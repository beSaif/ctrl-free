// Small UI primitives in the v4 style: 2px radius, no shadows, no gradients.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, type LinkProps } from 'react-router-dom'
import { btnClass, cx, type BtnSize, type BtnVariant } from '../lib/cx'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ComponentPropsWithRef<'button'> & { variant?: BtnVariant; size?: BtnSize }) {
  return <button type={type} className={btnClass(variant, size, className)} {...rest} />
}

export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: LinkProps & { variant?: BtnVariant; size?: BtnSize }) {
  return <Link className={btnClass(variant, size, className)} {...rest} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="font-mono text-[11.5px] leading-none px-[5px] py-[2px] border border-current rounded-[2px] opacity-75">
      {children}
    </span>
  )
}

export function Marker({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block flex-none w-2 h-2', className)} style={{ background: color }} />
}

/** Assist mark: small rotated square outline. */
export function AssistMark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block flex-none w-[7px] h-[7px] border-[1.5px] border-ink rotate-45', className)} />
}

export function AssistTag({ title }: { title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 px-1 border border-dashed border-ink rounded-[2px] text-[11px] font-sans leading-[16px] text-ink align-middle">
      <AssistMark className="w-[5px]! h-[5px]! border!" />
      Assist
    </span>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono', className)}>{children}</span>
}

export interface TabItem<K extends string> {
  key: K
  label: ReactNode
  count?: ReactNode
}

/** Filled pill tabs (N04/N06/N11 filter bars). */
export function FilterTabs<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem<K>[]
  value: K
  onChange: (k: K) => void
  label: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    refs.current[n]?.focus()
    onChange(items[n].key)
  }
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
      {items.map((it, i) => {
        const on = it.key === value
        return (
          <button
            key={it.key}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(it.key)}
            className={cx(
              'min-h-[34px] px-3 border rounded-[2px]',
              on ? 'bg-ink border-ink text-white font-semibold' : 'bg-white border-rule text-ink hover:border-ink',
            )}
          >
            {it.label}
            {it.count !== undefined && it.count !== '' && <span className="font-mono text-[13px] ml-1.5">{it.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Underlined tabs (N01 tender tabs). */
export function UnderlineTabs<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem<K>[]
  value: K
  onChange: (k: K) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1">
      {items.map((it) => {
        const on = it.key === value
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.key)}
            className={cx(
              'min-h-[34px] px-3 border-0 border-b-2 bg-transparent',
              on ? 'border-accent text-ink font-semibold' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {it.label}
            {it.count !== undefined && <span className="font-mono text-[13px] ml-1.5">{it.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

export interface SegOption<V> {
  value: V
  label: ReactNode
  hint?: ReactNode
}

/** Two or three small pressed/unpressed buttons in one box, for a view setting (Original · Filled, Fit page · Fit width). */
export function Toggle2<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex border border-rule rounded-[2px]">
      {options.map(([v, l], i) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx(
            'min-h-8 px-2.5 border-0 text-[13px]',
            i > 0 && 'border-l border-rule',
            value === v ? 'bg-ink text-white font-medium' : 'bg-white text-ink hover:bg-panel',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

/** Radio group of option buttons with an effect line (N07). */
export function SegmentedControl<V extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: SegOption<V>[]
  value: V
  onChange: (v: V) => void
  label: string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const idx = options.findIndex((o) => o.value === value)
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return
    e.preventDefault()
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
    const n = (i + d + options.length) % options.length
    refs.current[n]?.focus()
    onChange(options[n].value)
  }
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-[52px] px-3.5 py-1.5 border rounded-[2px] flex flex-col items-start justify-center gap-px text-left',
              on ? 'bg-ink border-ink text-white' : 'bg-white border-rule text-ink hover:border-ink',
            )}
          >
            <span className="font-medium">{o.label}</span>
            {o.hint && <span className="text-[12.5px]">{o.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Stepper({
  label,
  value,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  pending,
}: {
  label: string
  value: ReactNode
  onDec: () => void
  onInc: () => void
  decDisabled?: boolean
  incDisabled?: boolean
  pending?: boolean
}) {
  return (
    <span className="inline-flex items-center border border-rule rounded-[2px]">
      <button
        type="button"
        aria-label={`− ${label}`}
        onClick={onDec}
        disabled={decDisabled}
        className="w-9 h-9 border-0 border-r border-rule bg-white hover:bg-panel disabled:text-stone"
      >
        −
      </button>
      <span aria-live="polite" className={cx('min-w-[76px] text-center font-mono', pending && 'text-muted')}>
        {value}
      </span>
      <button
        type="button"
        aria-label={`+ ${label}`}
        onClick={onInc}
        disabled={incDisabled}
        className="w-9 h-9 border-0 border-l border-rule bg-white hover:bg-panel disabled:text-stone"
      >
        +
      </button>
    </span>
  )
}

export function Toggle({
  checked,
  onChange,
  children,
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cx('flex items-center gap-3 min-h-10 cursor-pointer', className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 m-0 accent-accent"
      />
      {children}
    </label>
  )
}

export function TextInput({ className, mono, strong, ...rest }: ComponentPropsWithRef<'input'> & { mono?: boolean; strong?: boolean }) {
  return (
    <input
      className={cx(
        'min-h-9 px-2.5 border rounded-[2px] bg-white text-[14px] text-ink placeholder:text-faint',
        strong ? 'border-ink' : 'border-rule',
        mono && 'font-mono',
        className,
      )}
      {...rest}
    />
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1 text-[13px] text-muted', className)}>
      {label}
      {children}
      {hint && <span>{hint}</span>}
    </label>
  )
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
  className?: string
}) {
  return (
    <label className={cx('flex items-center gap-2 min-h-[34px] px-2.5 border border-rule rounded-[2px] focus-within:border-ink', className)}>
      <IconSearch />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-auto min-w-0 border-0 outline-none bg-transparent placeholder:text-faint"
      />
    </label>
  )
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cx('px-3 py-2 border-b border-ink font-medium text-[13px] text-muted text-left first:pl-0 last:pr-0', className)} {...rest} />
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx('p-3 border-b border-rowrule align-top first:pl-0 last:pr-0', className)} {...rest} />
}

/** Modal dialog with Esc to close and focus kept inside. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 680,
  closeLabel = 'Close',
  hideTitle,
  fill,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  closeLabel?: string
  hideTitle?: boolean
  /** take the full viewport height (the body scrolls inside, e.g. a tender page) */
  fill?: boolean
}) {
  const id = useId()
  const ref = useRef<HTMLElement>(null)
  // callers pass a fresh onClose every render; keep it in a ref so typing (a re-render) does not
  // re-run the effect below and pull focus back to the first field
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close]), a[href]')
    ;(first ?? el)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
      if (e.key === 'Tab' && el) {
        const f = Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        if (!f.length) return
        const a = f[0]
        const b = f[f.length - 1]
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault()
          b.focus()
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault()
          a.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div
      className={cx('fixed inset-0 z-50 bg-[rgba(18,18,18,0.45)] flex justify-center items-start px-4 overflow-y-auto', fill ? 'py-4' : 'py-16')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className={cx('w-full bg-white border border-ink flex flex-col outline-none', fill && 'h-[calc(100vh-2rem)]')}
        style={{ maxWidth: width }}
      >
        <div className={cx('flex justify-between items-center gap-3 px-6 py-4 border-b border-rule', hideTitle && 'sr-only')}>
          <h1 id={id} className="m-0 text-[18px] font-semibold">
            {title}
          </h1>
          <button
            type="button"
            data-close
            aria-label={closeLabel}
            onClick={onClose}
            className="inline-flex w-9 h-9 border border-rule rounded-[2px] items-center justify-center bg-white hover:border-ink"
          >
            <IconClose />
          </button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 px-6 py-3.5 border-t border-rule">{footer}</div>}
      </section>
    </div>,
    document.body,
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <span aria-hidden="true" className="w-3 h-3 border-[1.5px] border-muted border-t-transparent rounded-full animate-spin" />
      {label}
    </span>
  )
}

export function ProgressBar({ value, label, width = 180, dark }: { value: number; label: string; width?: number; dark?: boolean }) {
  const pct = Math.max(0, Math.min(100, value * 100))
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="h-1 bg-rowrule" style={{ width }}>
      <div className={cx('h-1 transition-[width] duration-500', dark ? 'bg-ink' : 'bg-accent')} style={{ width: pct + '%' }} />
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="p-6">
      <Spinner label={label} />
    </div>
  )
}

export function ErrorBox({ error, label }: { error: unknown; label?: string }) {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return (
    <div role="alert" className="m-6 p-3 border border-attn text-attn max-w-[640px]">
      {label ?? 'Something went wrong.'} {msg && <span className="text-muted">({msg})</span>}
    </div>
  )
}

// ---- icons (inline stroke SVG) -------------------------------------------------------

export function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--color-muted)" strokeWidth="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3.5 3.5" />
    </svg>
  )
}

export function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-ink)" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
    </svg>
  )
}

export function IconBack() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M7.5 2.5L4 6l3.5 3.5" />
    </svg>
  )
}

export function IconChevron({ open }: { open?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="var(--color-ink)"
      strokeWidth="1.6"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
    >
      <path d="M4 2.5l3.5 3.5L4 9.5" />
    </svg>
  )
}

export function IconFile() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-muted)" strokeWidth="1.4" aria-hidden="true">
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </svg>
  )
}

export function IconUpload() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--color-muted)" strokeWidth="1.4" aria-hidden="true">
      <path d="M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 11v2.5h11V11" />
    </svg>
  )
}

export function IconCheck({ color = 'currentColor', size = 12 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 6.3l2.3 2.3 4.7-5" />
    </svg>
  )
}

/** Show-on-demand block: a quiet "Label ▸" toggle with an optional count/summary; the body renders only when open.
 *  Use it for detail people need sometimes (history, explanations, proof), not for the main task on a screen. */
export function Disclosure({
  label,
  summary,
  defaultOpen = false,
  open: openProp,
  onToggle,
  className,
  children,
}: {
  label: ReactNode
  /** quiet text after the label, e.g. "2 changed" or "(3)" */
  summary?: ReactNode
  defaultOpen?: boolean
  /** controlled mode */
  open?: boolean
  onToggle?: (open: boolean) => void
  className?: string
  children: ReactNode
}) {
  const id = useId()
  const [inner, setInner] = useState(defaultOpen)
  const open = openProp ?? inner
  const toggle = () => {
    setInner(!open)
    onToggle?.(!open)
  }
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className="inline-flex items-center gap-2 min-h-8 p-0 border-0 bg-transparent text-left text-ink hover:text-accent"
      >
        <IconChevron open={open} />
        <span className="font-semibold">{label}</span>
        {summary != null && <span className="text-muted font-normal text-[13px]">{summary}</span>}
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  )
}
