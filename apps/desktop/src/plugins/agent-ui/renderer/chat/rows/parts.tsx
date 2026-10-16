/**
 * The small pieces the chat's rows share: a clipped raw-JSON view with a copy
 * button, and the disclosure that opens it. Colour is background or plain
 * text, never an edge (docs/ui-system.md, Rules).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button, Icon } from '@/primitives'
import { cn } from '@/plugin-api'

/** How much of a raw item a fallback shows. All of it can still be copied. */
export const RAW_CLIP = 4096

export function clipText(text: string, max: number = RAW_CLIP): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} more characters`
}

/** An item as JSON for a person to read. Never throws: a value that cannot be
 *  serialised says so instead of taking the fallback down with it. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return '[This could not be turned into text]'
  }
}

/** Text from a field that should be a string and, in a malformed item, may
 *  not be. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const COPIED_MS = 1500

/** A text button that copies, and says so for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  className,
  ...rest
}: {
  /** The text, or a function that makes it when asked (a large item is not
   *  serialised for every render). */
  text: string | (() => string)
  label?: string
  className?: string
} & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn('font-normal text-muted-foreground', className)}
      onClick={() => {
        void copyText(typeof text === 'function' ? text() : text).then((ok) => {
          if (!ok) return
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), COPIED_MS)
        })
      }}
      {...rest}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

/** The motion for a row's contents opening (`index.css`, `disclose`): mounted
 *  only while open, so a large body costs nothing closed. */
export function Disclose({
  open,
  children,
}: {
  open: boolean
  children: ReactNode
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div data-slot="disclose" data-state="open">
      <div>{children}</div>
    </div>
  )
}

/** The button of a disclosure: a chevron, then what it opens. */
export function Toggle({
  open,
  onToggle,
  children,
  className,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-expanded={open}
      onClick={onToggle}
      className={cn('h-auto min-h-6 justify-start gap-1 px-1 py-0.5 font-normal', className)}
    >
      <Icon icon={ChevronRight} size="sm" className={cn('motion-respond', open && 'rotate-90')} />
      {children}
    </Button>
  )
}

/** A block of raw text: preformatted, scrollable, a heavy leaf the browser may
 *  skip while it is off screen. */
export function RawBlock({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'agent-chat-heavy max-h-64 overflow-auto rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground',
        className,
      )}
    >
      {text}
    </pre>
  )
}

/** The raw JSON of an item behind a disclosure, with a Copy button. */
export function RawDisclosure({
  raw,
  label = 'Show details',
}: {
  raw: string | (() => string)
  label?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-start gap-1">
      <Toggle open={open} onToggle={() => setOpen((o) => !o)}>
        {label}
      </Toggle>
      <Disclose open={open}>
        <div className="flex flex-col items-start gap-1 pl-5" data-chat-raw="">
          <RawBlock text={clipText(typeof raw === 'function' ? raw() : raw)} className="w-full" />
          <CopyButton text={raw} />
        </div>
      </Disclose>
    </div>
  )
}
