/**
 * The open tabs, as the nav menu's second section (docs/features/nav-menu.md):
 * in the same bar as its shortcuts, after a line that sets the two apart. One
 * icon per tab, the one its pane is showing marked. Pressing an icon goes to
 * its tab. Resting the pointer on one opens a small label over it, above the
 * bar: the tab's name and a button that closes it. The bar never changes size
 * under the pointer, and nothing covers the icon. A tab that opens pops up
 * into its place as the bar springs wider to make room; one that closes
 * shrinks away. A tab whose surface is a
 * menu item's one page (Home, the board, mail) is not listed: its item is the
 * way to it.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileText, X } from 'lucide-react'
import { tabIcon, tabKey, tabName, tabTooltip } from '@/composites/tab-look'
import { cn } from '@/lib/cn'
import { Button, HoverCard, Icon, IconButton, pop, popAt, popFrom, popLeave } from '@/primitives'
import { closeTabWithExitAtom } from '@/state/pane-exit'
import { focusTabAtom, placedTabs, workspaceAtom, type PlacedTab } from '@/state/panes'
import { useTabLook } from '@/state/tab-look'

/** The geometry, in px, which the bar that holds the section is sized from:
 *  a tab, the line before them with its margins, and how many tabs show
 *  before the section scrolls. */
const TAB = 32
const LINE = 9
const MOST = 12

/** How wide the section is with `count` tabs. */
export function openTabsWidth(count: number): number {
  return count === 0 ? 0 : LINE + Math.min(count, MOST) * TAB
}

/** The tabs the section lists, pane by pane: every file, every tab of a
 *  surface that is one per thing (an app), and a surface's only page when no
 *  menu item (`onMenu`, by surface) is the way to it. */
export function listedTabs(placed: readonly PlacedTab[], onMenu: ReadonlySet<string>): PlacedTab[] {
  return placed.filter(
    ({ tab }) => tab.kind !== 'surface' || tab.id !== undefined || !onMenu.has(tab.surface),
  )
}

export function OpenTabs({
  onMenu,
  wrap = false,
}: {
  /** The surfaces a menu item goes to. */
  onMenu: ReadonlySet<string>
  /** Wrapping rows with no line before them, for a sidebar or a rail. */
  wrap?: boolean
}): React.JSX.Element | null {
  const workspace = useAtomValue(workspaceAtom)
  const focusTab = useSetAtom(focusTabAtom)
  const closeTab = useSetAtom(closeTabWithExitAtom)
  const { marks, sources } = useTabLook()
  const still = useReducedMotion() ?? false
  const tabs = listedTabs(placedTabs(workspace), onMenu)
  if (tabs.length === 0) return null

  return (
    <div
      role="group"
      aria-label="Open tabs"
      data-open-tabs=""
      className={cn('flex min-w-0 items-center', wrap && 'flex-wrap')}
    >
      {!wrap && (
        <span
          aria-hidden="true"
          data-open-tabs-line=""
          className="mx-1 h-5 w-px shrink-0 bg-border"
        />
      )}
      <div
        className={cn(
          'flex min-w-0 items-center',
          'relative',
          wrap ? 'flex-wrap' : 'overflow-x-auto [scrollbar-width:none]',
        )}
      >
        {/* Popping out of the flow as it leaves, so the rest close up while
            it shrinks. */}
        <AnimatePresence mode="popLayout">
          {tabs.map(({ tab, pane, index, showing }) => {
            const key = tabKey(tab)
            const current = showing && pane === workspace.active
            const name = tabName(tab, sources)
            return (
              <motion.div
                key={key}
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
                      <span className="max-w-56 truncate text-xs">{tabTooltip(tab, sources)}</span>
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
                    aria-label={name}
                    data-open-tab={key}
                    className={cn(
                      'size-8 shrink-0 rounded-full p-0',
                      current ? 'bg-accent' : showing && 'bg-accent/50',
                    )}
                    onClick={() => focusTab(tab)}
                    // A middle press closes, as it does on a tab anywhere; the
                    // keyboard closes the focused tab with ⌘W.
                    onAuxClick={(event) => {
                      if (event.button === 1) closeTab(pane, index)
                    }}
                  >
                    {/* A note has no mark of its own, so it wears the file's. */}
                    {tabIcon(tab, marks, sources) ?? <Icon icon={FileText} size="sm" />}
                  </Button>
                </HoverCard>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
