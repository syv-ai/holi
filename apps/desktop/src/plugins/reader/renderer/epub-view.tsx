/**
 * An EPUB, through the vendored foliate-js (vendor/foliate/vendored.md),
 * one page at a time. The one module that imports it, loaded lazily so the
 * main chunk never carries it.
 *
 * - **No book script runs.** foliate's chapter frames are sandboxed
 *   `allow-same-origin` only (the vendored patch), and a script the book lists
 *   is never even unpacked.
 * - **Nothing outside the book loads.** Every chapter gets `INERT_CSP` first
 *   in its head as it is unpacked; what the book packs becomes `blob:` URLs,
 *   which the policy allows, and a web address it names does not load.
 * - **Links**: one within the book turns to it; a web or mail link opens in
 *   the browser; nothing navigates a frame.
 * - **Text takes the theme's colours**, which a frame cannot read, so they are
 *   resolved and handed to foliate again when the mode flips. A book's own CSS
 *   may still set its colours.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ListTree } from 'lucide-react'
import { ErrorState } from '@/composites/empty-state'
import { IconButton } from '@/composites/icon-button'
import { PaneToolbar } from '@/composites/pane-toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { activeModeAtom } from '@/plugin-api'
import { guardChapters } from './epub-chapters'
import { followLink, forwardShortcuts, openOutside, withInertPolicy } from './inert-frame'
import { themeColour } from './inert-frame-host'
import { ReaderLoading } from './reader-pane'
import type { Book, Relocation, TocItem, View } from './vendor/foliate/view.js'

/** The chapter types foliate unpacks as documents, which get the policy. */
const CHAPTER_TYPES = new Set(['application/xhtml+xml', 'text/html'])

/** The stylesheet foliate puts into every chapter: the theme's text colours. */
function bookStyles(mode: string): string {
  return `html { color-scheme: ${mode}; color: ${themeColour('--foreground')}; background: transparent; }
a:any-link { color: ${themeColour('--primary')}; }`
}

export function EpubView({ bytes, name }: { bytes: Uint8Array<ArrayBuffer>; name: string }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<View | null>(null)
  const mode = useAtomValue(activeModeAtom)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const [state, setState] = useState<'opening' | 'open' | { error: string }>('opening')
  const [attempt, setAttempt] = useState(0)
  const [toc, setToc] = useState<readonly TocItem[]>([])
  const [chapter, setChapter] = useState<string | null>(null)
  const [fraction, setFraction] = useState(0)

  useEffect(() => {
    const parent = host.current
    if (parent === null) return
    let live = true
    let view: View | null = null
    let opened: Book | null = null
    const unforward: Array<() => void> = []
    setState('opening')
    void (async () => {
      try {
        const { makeBook } = await import('./vendor/foliate/view.js')
        const book: Book = await makeBook(new File([bytes], name, { type: 'application/epub+zip' }))
        opened = book
        if (!live) {
          book.destroy()
          return
        }
        guardChapters(book)
        book.transformTarget?.addEventListener('load', (event) => {
          const detail = (event as CustomEvent<{ isScript: boolean; allow: boolean }>).detail
          if (detail.isScript) detail.allow = false
        })
        book.transformTarget?.addEventListener('data', (event) => {
          const detail = (event as CustomEvent<{ type: string; data: unknown }>).detail
          if (!CHAPTER_TYPES.has(detail.type)) return
          const type = detail.type as 'application/xhtml+xml' | 'text/html'
          detail.data = Promise.resolve(detail.data).then((markup) =>
            withInertPolicy(String(markup), type),
          )
        })
        if (!live) return
        view = document.createElement('foliate-view') as View
        view.className = 'block min-h-0 flex-1'
        view.addEventListener('external-link', (event) => {
          event.preventDefault()
          openOutside((event as CustomEvent<{ href_: string }>).detail.href_)
        })
        view.addEventListener('relocate', (event) => {
          const detail = (event as CustomEvent<Relocation>).detail
          setFraction(detail.fraction)
          setChapter(detail.tocItem?.label ?? null)
        })
        view.addEventListener('load', (event) => {
          const { doc } = (event as CustomEvent<{ doc: Document }>).detail
          unforward.push(forwardShortcuts(doc, parent))
          doc.addEventListener('keydown', (key) => turnPage(view, key))
          // foliate takes clicks on `a[href]`; any other link (an SVG
          // `xlink:href`, an image map's `area`) would navigate the frame.
          doc.addEventListener(
            'click',
            (click) => {
              if ((click.target as Element | null)?.closest?.('a[href]') == null) followLink(click)
            },
            true,
          )
        })
        parent.append(view)
        viewRef.current = view
        await view.open(book)
        view.renderer.setStyles?.(bookStyles(modeRef.current))
        await view.init({ showTextStart: true })
        if (!live) return
        setToc(book.toc ?? [])
        setState('open')
      } catch (err) {
        if (live) setState({ error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      live = false
      for (const undo of unforward) undo()
      view?.close()
      view?.remove()
      opened?.destroy()
      viewRef.current = null
    }
  }, [bytes, name, attempt])

  useEffect(() => {
    viewRef.current?.renderer?.setStyles?.(bookStyles(mode))
  }, [mode])

  if (typeof state === 'object')
    return (
      <ErrorState
        title="This book didn’t open"
        message={state.error}
        onRetry={() => {
          setState('opening')
          setAttempt((n) => n + 1)
        }}
      />
    )

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      tabIndex={-1}
      // Only keys from the pane itself: the contents menu is portalled, but its
      // arrow keys still bubble here through React.
      onKeyDown={(event) => {
        if (event.currentTarget.contains(event.target as Node))
          turnPage(viewRef.current, event.nativeEvent)
      }}
    >
      <PaneToolbar>
        {toc.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Contents">
                <ListTree />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <TocEntries items={toc} go={(href) => quietly(viewRef.current?.goTo(href))} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {chapter ?? name}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {Math.round(fraction * 100)}%
        </span>
        <IconButton label="Previous page" onClick={() => quietly(viewRef.current?.goLeft())}>
          <ChevronLeft />
        </IconButton>
        <IconButton label="Next page" onClick={() => quietly(viewRef.current?.goRight())}>
          <ChevronRight />
        </IconButton>
      </PaneToolbar>
      {state === 'opening' && <ReaderLoading />}
      <div ref={host} className={state === 'open' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} />
    </div>
  )
}

/** The arrow keys turn the page, from the pane or from inside a chapter. */
function turnPage(view: View | null, event: KeyboardEvent): void {
  if (view === null || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'ArrowLeft') quietly(view.goLeft())
  else if (event.key === 'ArrowRight') quietly(view.goRight())
}

/** A page turn that fails (the book closing under it) has nothing to show. */
function quietly(turn: Promise<unknown> | undefined): void {
  void turn?.catch(() => {})
}

/** The book's contents, a submenu for each part that has chapters of its own. */
function TocEntries({ items, go }: { items: readonly TocItem[]; go: (href: string) => void }) {
  return items.map((item, i) =>
    item.subitems != null && item.subitems.length > 0 ? (
      <DropdownMenuSub key={`${item.href}-${i}`}>
        <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => go(item.href)}>{item.label}</DropdownMenuItem>
          <TocEntries items={item.subitems} go={go} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ) : (
      <DropdownMenuItem key={`${item.href}-${i}`} onSelect={() => go(item.href)}>
        {item.label}
      </DropdownMenuItem>
    ),
  )
}
