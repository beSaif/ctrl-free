// Class helpers for the UI primitives.
export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ')
}

export type BtnVariant = 'primary' | 'secondary' | 'dark' | 'link' | 'quiet'
export type BtnSize = 'md' | 'sm' | 'xs'

const base = 'inline-flex items-center gap-2 rounded-[2px] no-underline whitespace-nowrap transition-colors disabled:cursor-default'
const variants: Record<BtnVariant, string> = {
  primary: 'bg-accent text-white! font-medium hover:bg-accent-hover disabled:bg-stone border border-transparent',
  secondary: 'bg-white text-ink! border border-rule hover:border-ink disabled:text-stone! disabled:hover:border-rule',
  dark: 'bg-ink text-white! font-medium border border-ink hover:bg-black',
  link: 'bg-transparent text-accent! underline underline-offset-2 hover:text-accent-hover! px-0! border-0 min-h-8!',
  quiet: 'bg-transparent text-muted! border-0 hover:text-ink!',
}
const sizes: Record<BtnSize, string> = {
  md: 'min-h-10 px-4',
  sm: 'min-h-9 px-3.5',
  xs: 'min-h-8 px-2.5 text-[13px]',
}

export function btnClass(variant: BtnVariant = 'secondary', size: BtnSize = 'md', extra?: string) {
  return cx(base, variants[variant], sizes[size], extra)
}

