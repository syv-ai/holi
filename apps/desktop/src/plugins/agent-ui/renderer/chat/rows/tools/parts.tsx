/**
 * The pieces a tool card's body is made of: a chip, a code block with a copy
 * button, a clipped text with its "Show all", the pictures a result carried,
 * a link. A tool result can be hundreds of kilobytes, so nothing here draws
 * more than it has to until it is asked: text is clipped by lines and by
 * characters, and a heavy leaf block opts out of layout work while it is off
 * screen (`content-visibility`).
 *
 * State shows by background colour, never by an edge or a ring
 * (docs/ui-system.md, Rules).
 */
import { Check, Copy, ImageIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon, IconButton } from '@/primitives'
import { cn } from '@/plugin-api'
import type { ToolItem } from '../../../../../agent/renderer/chat/items'
import { ChatMarkdown } from '../../ChatMarkdown'
import { bytesLabel, isRec, isWebUrl, textOf, unwrap } from './coerce'

/** A small fact: a count, a status, a size. Neutral background; a bad one is
 *  destructive text, never a tinted backdrop. */
export function Chip({
  children,
  tone = 'default',
  className,
}: {
  children: ReactNode
  tone?: 'default' | 'bad'
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-chat-chip=""
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs leading-none whitespace-nowrap tabular-nums',
        tone === 'bad' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

export interface Clipped {
  text: string
  clipped: boolean
  /** Lines of the original that are not in `text`. */
  moreLines: number
}

function countLines(text: string): number {
  if (text === '') return 0
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** The head of a text: at most `lines` lines and `chars` characters. */
export function clip(text: string, lines: number, chars: number): Clipped {
  const source = typeof text === 'string' ? text : ''
  let out = source
  if (out.length > chars) {
    out = out.slice(0, Math.max(0, chars))
    // Not in the middle of a surrogate pair.
    const last = out.charCodeAt(out.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  }
  if (Number.isFinite(lines)) {
    let cut = -1
    let seen = 0
    for (let i = out.indexOf('\n'); i !== -1; i = out.indexOf('\n', i + 1)) {
      seen++
      if (seen >= lines) {
        cut = i
        break
      }
    }
    if (cut !== -1) out = out.slice(0, cut)
  }
  const clipped = out.length < source.length
  return {
    text: out,
    clipped,
    moreLines: clipped ? Math.max(0, countLines(source) - countLines(out)) : 0,
  }
}

/** The most a "Show all" shows: past this the rest is said, not drawn. */
export const SHOW_ALL_CHARS = 30_000

/**
 * A text clipped to `lines` and `chars`, with a "Show all" that lifts the clip
 * (to `expandedChars`, never without a limit). The children draw whatever text
 * they are given.
 */
export function Clip({
  text,
  lines,
  chars,
  expandedChars = SHOW_ALL_CHARS,
  children,
}: {
  text: string
  lines: number
  chars: number
  expandedChars?: number
  children: (shown: string, expanded: boolean) => ReactNode
}): React.JSX.Element {
  const [all, setAll] = useState(false)
  const head = clip(text, lines, chars)
  const shown = all ? clip(text, Infinity, expandedChars) : head
  const hidden = text.length - shown.text.length
  return (
    <>
      {children(shown.text, all)}
      {(head.clipped || all) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {head.clipped && (
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={all}
              className="text-muted-foreground"
              onClick={() => setAll((v) => !v)}
            >
              {all ? 'Show less' : 'Show all'}
              {!all && head.moreLines > 0 && ` (${head.moreLines} more lines)`}
            </Button>
          )}
          {all && hidden > 0 && (
            <span data-chat-more="">{`${bytesLabel(hidden)} more not shown`}</span>
          )}
        </div>
      )}
    </>
  )
}

/** Copy to the clipboard, and say so for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string
  label?: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  const copy = (): void => {
    try {
      const written = navigator.clipboard?.writeText(text)
      void Promise.resolve(written).catch(() => undefined)
    } catch {
      // No clipboard in this window: nothing to say.
    }
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? 'Copied' : label}
      size="sm"
      className={className}
      onClick={copy}
    />
  )
}

const PRE =
  'overflow-auto rounded-lg bg-muted/40 px-2.5 py-2 font-mono text-xs [content-visibility:auto] [contain-intrinsic-size:auto_8rem]'

/** Monospace text that scrolls rather than grows. */
export function Pre({
  children,
  tone = 'default',
  wrap = true,
  tall = false,
  className,
}: {
  children: ReactNode
  tone?: 'default' | 'error' | 'muted'
  wrap?: boolean
  tall?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        PRE,
        tall ? 'max-h-[32rem]' : 'max-h-64',
        wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
        tone === 'error' && 'text-destructive',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'default' && 'text-foreground/90',
        className,
      )}
    >
      {children}
    </pre>
  )
}

/**
 * Text in a monospace block, clipped, with a copy button that appears on
 * hover or focus and copies all of it. `startLine` draws a gutter of line
 * numbers (Read's).
 */
export function CodeBlock({
  text,
  lines = 40,
  chars = 4000,
  expandedChars,
  wrap = true,
  startLine,
  tone = 'default',
  copy = true,
  label,
}: {
  text: string
  lines?: number
  chars?: number
  expandedChars?: number
  wrap?: boolean
  /** The number of the first line: the block gets a gutter. */
  startLine?: number
  tone?: 'default' | 'error' | 'muted'
  copy?: boolean
  /** What the block holds, for assistive tech: "Command", "Output". */
  label?: string
}): React.JSX.Element {
  const source = typeof text === 'string' ? text : ''
  return (
    <div className="group relative flex flex-col gap-1" data-chat-code={label ?? ''}>
      <Clip text={source} lines={lines} chars={chars} expandedChars={expandedChars}>
        {(shown, expanded) => (
          <Pre tone={tone} wrap={wrap && startLine === undefined} tall={expanded}>
            {startLine === undefined ? shown : <Numbered text={shown} start={startLine} />}
          </Pre>
        )}
      </Clip>
      {copy && source !== '' && (
        <CopyButton
          text={source}
          label={label === undefined ? 'Copy' : `Copy ${label.toLowerCase()}`}
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </div>
  )
}

function Numbered({ text, start }: { text: string; start: number }): React.JSX.Element {
  const rows = text.split('\n')
  const width = String(start + rows.length).length
  return (
    <>
      {rows.map((line, i) => (
        <div key={i} className="flex">
          <span
            aria-hidden
            className="shrink-0 pr-3 text-right text-muted-foreground/60 select-none"
            style={{ minWidth: `${width + 1}ch` }}
          >
            {start + i}
          </span>
          <span className="min-w-0 whitespace-pre">{line === '' ? ' ' : line}</span>
        </div>
      ))}
    </>
  )
}

/** Markdown, clipped as its source is. */
export function Markdown({
  text,
  lines = 30,
  chars = 4000,
}: {
  text: string
  lines?: number
  chars?: number
}): React.JSX.Element {
  return (
    <Clip text={text} lines={lines} chars={chars}>
      {(shown) => <ChatMarkdown text={shown} />}
    </Clip>
  )
}

/** The pictures a result carried: a chip each, never the bytes. */
export function imagesOf(item: ToolItem): { mediaType: string; bytes: number }[] {
  const images: unknown = item?.result?.images
  if (!Array.isArray(images)) return []
  return images.filter(isRec).map((image) => ({
    mediaType: typeof image.mediaType === 'string' ? image.mediaType : 'image',
    bytes: typeof image.bytes === 'number' ? image.bytes : 0,
  }))
}

export function ImageChips({ item }: { item: ToolItem }): React.JSX.Element | null {
  const images = imagesOf(item)
  if (images.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5" data-chat-images="">
      {images.slice(0, 12).map((image, i) => (
        <Chip key={i}>
          <Icon icon={ImageIcon} size="sm" />
          {image.bytes > 0 ? `Image · ${bytesLabel(image.bytes)}` : 'Image'}
        </Chip>
      ))}
    </div>
  )
}

/** What a failed call said, without the harness's wrapper. */
export function ErrorPane({ item }: { item: ToolItem }): React.JSX.Element | null {
  const text = unwrap(textOf(item))
  if (text === '') return null
  return <CodeBlock text={text} lines={12} chars={2000} tone="error" copy={false} label="Error" />
}

/** A small caption over a part of a body. */
export function Caption({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="text-xs text-muted-foreground">{children}</div>
}

/** A part of a body that opens and closes on its own ("Prompt", "Script"). */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string
  children: ReactNode
  defaultOpen?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-1" data-chat-disclosure={label}>
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        className="w-fit text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? `Hide ${label.toLowerCase()}` : label}
      </Button>
      {open && children}
    </div>
  )
}

/** A link out: the browser opens it, never the app's own window. */
export function WebLink({
  url,
  children,
  className,
}: {
  url: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  if (!isWebUrl(url)) return <span className={className}>{children}</span>
  return (
    <a
      href={url}
      className={cn('text-brand underline-offset-2 hover:underline', className)}
      onClick={(event) => {
        event.preventDefault()
        void window.holi?.openExternal?.(url)
      }}
    >
      {children}
    </a>
  )
}

/** A body's parts, one under the other. */
export function Stack({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-2">{children}</div>
}
