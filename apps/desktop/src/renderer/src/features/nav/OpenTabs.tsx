/**
 * The open tabs, as the nav menu's second section (docs/features/nav-menu.md):
 * in the same bar as its shortcuts, after a line the menu draws, or on a row
 * of their own under them where the dock wraps. One icon per tab, the one its
 * pane is showing marked. Pressing an icon goes to its tab; pressing it twice
 * keeps a preview tab open, as on a strip. Resting the pointer on one opens a
 * small label over it, above the bar: the tab's name (a preview's in italics)
 * and buttons that keep it open and close it. The bar never changes size
 * under the pointer, and nothing covers the icon. A tab that opens pops up
 * into its place as the bar springs wider to make room; one that closes
 * shrinks away. Past what the bar has room for the section scrolls: the
 * current tab is kept in view, and a count at each edge says what is off it
 * and lists it, as a strip's does. A tab whose surface is a menu item's one
 * page (Home, the board, mail) is not listed: its item is the way to it.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { FileText, Pin, X } from 'lucide-react'
import { TabOverflowMenu, tabIcon, tabName, tabTooltip } from '@/composites/tab-look'
import { cn } from '@/lib/cn'
import {
  NOTHING_OFFSCREEN,
  offscreenTabs,
  revealScroll,
  sameOffscreen,
  type Offscreen,
} from '@/lib/tab-overflow'
import { Button, HoverCard, Icon, IconButton, pop, popAt, popFrom, popLeave } from '@/primitives'
import { closeTabWithExitAtom } from '@/state/pane-exit'
import {
  focusTabAtom,
  pinTabAtom,
  placedTabs,
  tabKey,
  workspaceAtom,
  type PlacedTab,
} from '@/state/panes'
import { useTabLook } from '@/state/tab-look'

/** The geometry, in px, which the bar that holds the section is sized from:
 *  a tab, and how many tabs it asks room for before it scrolls. */
const TAB = 32
const MOST = 12

/** How wide the section would like to be with `count` tabs; the menu adds its
 *  line, and gives less where it has less. */
export function openTabsWidth(count: number): number {
  return Math.min(count, MOST) * TAB
}

/** The tabs the section lists, pane by pane: every file, every tab of a
 *  surface that is one per thing (an app), and a surface's only page when no
 *  menu item (`onMenu`, by surface) is the way to it. */
export function listedTabs(placed: readonly PlacedTab[], onMenu: ReadonlySet<string>): PlacedTab[] {
  return placed.filter(
    ({ tab }) => tab.kind !== 'surface' || tab.id !== undefined || !onMenu.has(tab.surface),
  )
}

const isPreview = ({ tab }: PlacedTab): boolean => tab.kind === 'note' && tab.preview === true

export function OpenTabs({
  onMenu,
  wrap = false,
}: {
  /** The surfaces a menu item goes to. */
  onMenu: ReadonlySet<string>
  /** Wrapping rows, for a sidebar or a rail, rather than one scrolling row. */
  wrap?: boolean
}): React.JSX.Element | null {
  const workspace = useAtomValue(workspaceAtom)
  const focusTab = useSetAtom(focusTabAtom)
  const pinTab = useSetAtom(pinTabAtom)
  const closeTab = useSetAtom(closeTabWithExitAtom)
  const { marks, sources } = useTabLook()
  const still = useReducedMotion() ?? false
  const tabs = listedTabs(placedTabs(workspace), onMenu)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const cellRefs = useRef(new Map<string, HTMLElement>())
  const [offscreen, setOffscreen] = useState<Offscreen>(NOTHING_OFFSCREEN)

  const keys = tabs.map(({ tab }) => tabKey(tab))
  /** The list's identity, for effects that follow it. */
  const keyList = keys.join('\n')
  const keysRef = useRef(keys)
  keysRef.current = keys
  const currentAt = tabs.findIndex((t) => t.showing && t.pane === workspace.active)
  const currentKey = currentAt === -1 ? null : keys[currentAt]!

  const span = (key: string) => {
    const el = cellRefs.current.get(key)
    return el === undefined ? { left: 0, width: 0 } : { left: el.offsetLeft, width: el.offsetWidth }
  }

  // What is off each edge, on scroll, resize or a change of tabs. Written back
  // only on a change, since scroll fires continuously.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (wrap || scroller === null) return
    const measure = () => {
      const next = offscreenTabs(
        keysRef.current.map(span),
        scroller.scrollLeft,
        scroller.clientWidth,
      )
      setOffscreen((prev) => (sameOffscreen(prev, next) ? prev : next))
    }
    measure()
    scroller.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [keyList, wrap])

  /** Scroll a tab fully into the section, by its key. On the scroller only,
   *  so nothing the menu clips with is scrolled with it. */
  const reveal = (key: string) => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const left = revealScroll(span(key), scroller.scrollLeft, scroller.clientWidth)
    if (left !== scroller.scrollLeft) scroller.scrollLeft = left
  }

  // Keep the current tab in view. Keyed on its identity, and on the list so a
  // tab that opens before it does not push it out.
  useLayoutEffect(() => {
    if (!wrap && currentKey !== null) reveal(currentKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, keyList, wrap])

  if (tabs.length === 0) return null

  return (
    <div
      role="group"
      aria-label="Open tabs"
      data-open-tabs=""
      className={cn('relative flex min-w-0 items-center', wrap ? 'flex-wrap' : 'flex-1')}
    >
      <div
        ref={scrollerRef}
        data-open-tabs-scroller=""
        className={cn(
          'relative flex min-w-0 items-center',
          wrap ? 'flex-wrap' : 'flex-1 overflow-x-auto [scrollbar-width:none]',
        )}
      >
        {/* Popping out of the flow as it leaves, so the rest close up while
            it shrinks. */}
        <AnimatePresence mode="popLayout">
          {tabs.map((placed) => {
            const { tab, pane, index, showing } = placed
            const key = tabKey(tab)
            const current = key === currentKey
            const preview = isPreview(placed)
            const name = tabName(tab, sources)
            return (
              <motion.div
                key={key}
                ref={(el: HTMLDivElement | null) => {
                  if (el === null) cellRefs.current.delete(key)
                  else cellRefs.current.set(key, el)
                }}
                layout={still ? false : 'position'}
                initial={still ? false : popFrom}
                animate={popAt}
                exit={still ? undefined : { ...popFrom, transition: popLeave }}
                transition={pop}
                className="shrink-0"
              >
                <HoverCard
                  side={wrap ? 'right' : 'top'}
                  openDelay={60}
                  className="rounded-full py-0.5 pr-0.5 pl-3"
                  content={
                    <div data-open-tab-label={key} className="flex items-center gap-1.5">
                      <span className={cn('max-w-56 truncate text-xs', preview && 'italic')}>
                        {tabTooltip(tab, sources)}
                      </span>
                      {preview && (
                        <IconButton
                          icon={Pin}
                          label={`Keep ${name} open`}
                          tooltip={false}
                          size="sm"
                          shape="round"
                          onClick={() => pinTab({ pane, index })}
                        />
                      )}
                      <IconButton
                        icon={X}
                        label={`Close ${name}`}
                        tooltip={false}
                        size="sm"
                        shape="round"
                        onClick={() => closeTab(pane, index)}
                      />
                    </div>
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-current={current ? 'page' : undefined}
                    aria-label={preview ? `${name}, preview` : name}
                    data-open-tab={key}
                    data-preview={preview ? '' : undefined}
                    className={cn(
                      'size-8 shrink-0 rounded-full p-0',
                      current ? 'bg-accent' : showing && 'bg-accent/50',
                      // A preview is the one tab a browse replaces: its glyph
                      // is quieter, as its name is italic on a strip.
                      preview && 'text-muted-foreground',
                    )}
                    onClick={(event) => {
                      // The second press of a double press keeps it, as a
                      // double click on a strip's tab does.
                      if (event.detail === 2 && preview) pinTab({ pane, index })
                      else focusTab(tab)
                    }}
                    // A middle press closes, as it does on a tab anywhere; the
                    // keyboard closes the focused tab with ⌘W.
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(pane, index)
                    }}
                  >
                    {/* A note has no mark of its own, so it wears the file's. */}
                    {tabIcon(tab, marks, sources) ?? (
                      <Icon icon={FileText} size="sm" tone={preview ? 'muted' : 'inherit'} />
                    )}
                  </Button>
                </HoverCard>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
      {!wrap && (
        <>
          <TabOverflowMenu
            side="left"
            surface="popover"
            indices={offscreen.left}
            tabs={tabs.map((t) => t.tab)}
            marks={marks}
            sources={sources}
            onReveal={(i) => {
              focusTab(tabs[i]!.tab)
              reveal(keys[i]!)
            }}
          />
          <TabOverflowMenu
            side="right"
            surface="popover"
            indices={offscreen.right}
            tabs={tabs.map((t) => t.tab)}
            marks={marks}
            sources={sources}
            onReveal={(i) => {
              focusTab(tabs[i]!.tab)
              reveal(keys[i]!)
            }}
          />
        </>
      )}
    </div>
  )
}
