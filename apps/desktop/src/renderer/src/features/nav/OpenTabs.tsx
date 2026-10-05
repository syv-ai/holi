/**
 * The open tabs one nav item holds, as the card over its dock shortcut
 * (docs/features/nav-menu.md): each a bubble holding a small picture of the
 * tab (`state/tab-thumbs`), no words, that goes to it, with a close button, and
 * a last "+" bubble that opens a new one, which is the item's own page. A surface's item holds
 * its surface's tabs when it is one tab per thing (an app); `FILES` holds
 * every tab no item's surface owns, which is the files. A surface that is one
 * page (Home, the board, mail) has nothing to list: its item is the way to it.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus, X } from 'lucide-react'
import { tabIcon, tabKey, tabName, tabTooltip } from '@/composites/tab-look'
import { cn } from '@/lib/cn'
import { Button, Icon, IconButton } from '@/primitives'
import { closeTabWithExitAtom } from '@/state/pane-exit'
import { focusTabAtom, placedTabs, workspaceAtom, type PlacedTab, type Tab } from '@/state/panes'
import { useTabLook } from '@/state/tab-look'
import { tabThumbsAtom } from '@/state/tab-thumbs'

/** The group of every tab no nav item's surface owns. */
export const FILES = 'files'

/** Which nav item holds a surface's tabs, by surface: an item holds its own
 *  surface's, and whatever surface it says (`RailItem.tabs`). */
export type TabOwners = ReadonlyMap<string, string>

/** The group a tab is listed under: the item that holds its surface, else the
 *  files. */
export function tabGroup(tab: Tab, owners: TabOwners): string {
  return (tab.kind === 'surface' ? owners.get(tab.surface) : undefined) ?? FILES
}

/** A group's open tabs, pane by pane: the files, or the tabs of a surface that
 *  is one per thing. A surface's only page is not listed. */
export function groupTabs(
  placed: readonly PlacedTab[],
  group: string,
  owners: TabOwners,
): PlacedTab[] {
  return placed.filter(
    ({ tab }) =>
      tabGroup(tab, owners) === group &&
      (group === FILES || (tab.kind === 'surface' && tab.id !== undefined)),
  )
}

/** One bubble: wide enough to read what a page is, and round like the agents'. */
const BUBBLE = 'relative h-20 w-32 shrink-0 overflow-hidden rounded-2xl'

export function OpenTabs({
  group,
  title,
  owners,
  onNew,
  newLabel,
}: {
  group: string
  /** What the group is called: the card's label for assistive technology, and
   *  nothing on screen. */
  title: string
  /** Which nav item holds each surface's tabs. */
  owners: TabOwners
  /** Opens a new tab: the group's main page. */
  onNew: () => void
  /** What the "+" bubble is called, as "New tab". */
  newLabel: string
}): React.JSX.Element {
  const workspace = useAtomValue(workspaceAtom)
  const focusTab = useSetAtom(focusTabAtom)
  const closeTab = useSetAtom(closeTabWithExitAtom)
  const thumbs = useAtomValue(tabThumbsAtom)
  const { marks, sources } = useTabLook()
  const tabs = groupTabs(placedTabs(workspace), group, owners)

  return (
    <div
      role="group"
      aria-label={`${title}: open tabs`}
      className="flex max-w-[26rem] flex-wrap items-center gap-2 p-1"
    >
      {tabs.map(({ tab, pane, index, showing }) => {
        const current = showing && pane === workspace.active
        const picture = thumbs.get(tabKey(tab))
        const name = tabName(tab, sources)
        return (
          <div key={tabKey(tab)} className={cn('group/tab', BUBBLE)}>
            <Button
              variant="ghost"
              size="sm"
              aria-current={current ? 'page' : undefined}
              aria-label={tabTooltip(tab, sources)}
              data-open-tab={tabKey(tab)}
              className={cn(
                'size-full rounded-2xl border bg-muted/40 p-0 hover:bg-muted/60',
                showing ? 'border-foreground/40' : 'border-border/60',
                current && 'ring-2 ring-foreground/50',
              )}
              onClick={() => focusTab(tab)}
            >
              {picture !== undefined ? (
                <img
                  src={picture}
                  alt=""
                  draggable={false}
                  className="size-full object-cover object-top"
                />
              ) : (
                // Not seen yet, so nothing to show of it: its mark alone.
                <span
                  data-open-tab-blank=""
                  className="flex size-full items-center justify-center text-muted-foreground [&_svg]:size-5"
                >
                  {tabIcon(tab, marks, sources)}
                </span>
              )}
            </Button>
            {/* The disc is the backdrop over a picture; the button is bare. */}
            <span className="absolute top-1 right-1 rounded-full bg-popover/90 opacity-0 shadow-sm group-focus-within/tab:opacity-100 group-hover/tab:opacity-100">
              <IconButton
                icon={X}
                label={`Close ${name}`}
                tooltip={false}
                size="sm"
                className="size-6"
                onClick={() => closeTab(pane, index)}
              />
            </span>
          </div>
        )
      })}
      <Button
        variant="ghost"
        size="sm"
        aria-label={newLabel}
        data-open-tab-new=""
        className="size-12 shrink-0 rounded-full bg-muted p-0 text-muted-foreground"
        onClick={onNew}
      >
        <Icon icon={Plus} />
      </Button>
    </div>
  )
}
