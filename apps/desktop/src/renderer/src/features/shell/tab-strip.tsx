'use client'

import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  CheckIcon,
  CircleAlertIcon,
  Columns2Icon,
  EllipsisVerticalIcon,
  FileTextIcon,
  PencilIcon,
  PanelRightCloseIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareSplitHorizontalIcon,
  UngroupIcon,
  XIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { saveBeforeClosing } from '@/lib/buffer-registry'
import type { IconGlyph } from '@/lib/icon-glyph'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { activeRemoteAtom } from '@/state/vaults'
import {
  activeSplit,
  closeAllTabs,
  closeEntry,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  combineOnStrip,
  dropOnStrip,
  entriesByRecency,
  entryId,
  focusMember,
  isSplit,
  isViewKey,
  MAX_SPLIT,
  moveOut,
  openInSplit,
  reopenClosed,
  replaceWithNew,
  selectEntry,
  separate,
  splitActive,
  type ShellSplit,
  type ShellWorkspace,
} from '@/state/shell-workspace'

import { useTabLook } from './tab-look'
import { TabSwitcher, type SwitcherRow } from './tab-switcher'
import {
  TAB_MIME,
  stripDropZone,
  tabDragAtom,
  tabDragVaultAtom,
  tabDragWasOpenAtom,
  useTabDragSource,
} from './use-tab-drag'

export type HeaderTab = {
  id: string
  title: string
  /** A view's own glyph (Settings' cog); a page when absent. */
  icon?: IconGlyph
  /** Drawn in place of the glyph: a session's Claude mark or Holi face. */
  mark?: ReactNode
  /** A session's state, or a document's Updated: a badge on a tab, a dot
   *  on a split member's mark. */
  status?: 'working' | 'needs-you' | 'done' | 'updated'
}

const STATUS_WORDS: Record<NonNullable<HeaderTab['status']>, string> = {
  working: 'working',
  'needs-you': 'needs you',
  done: 'done, not opened yet',
  updated: 'changed since you last looked',
}

function spoken(tab: HeaderTab): string {
  return tab.status === undefined ? tab.title : `${tab.title}, ${STATUS_WORDS[tab.status]}`
}

/**
 * The one tab strip (docs/features/tabs-panes.md), in the title band always,
 * after Arc's: every entry, a split view among them as one pill holding its
 * members' marks and titles side by side. Clicking the pill selects the
 * split; clicking a member in it selects the split focused on that member.
 * Entries drag along the strip to reorder and onto the content to split
 * (`split-view.tsx`), and a split member's header drags here to leave its
 * split. On the phone's one column nothing drags.
 */
export function TabStrip({
  onNewTab,
  draggable = true,
}: {
  /** +, as the shell opens a New tab (or the Agents home). */
  onNewTab: () => void
  draggable?: boolean
}) {
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const store = useStore()
  const look = useTabLook()
  const dragSource = useTabDragSource()
  const dragged = useAtomValue(tabDragAtom)
  const dragVault = useAtomValue(tabDragVaultAtom)
  const dragWasOpen = useAtomValue(tabDragWasOpenAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const setDrag = useSetAtom(tabDragAtom)
  const clearDragVault = useSetAtom(tabDragVaultAtom)
  const clearDragWasOpen = useSetAtom(tabDragWasOpenAtom)
  /** Where a drag along the strip would land: before entry `n`. */
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [combinePreview, setCombinePreview] = useState<{
    source: string
    target: string
    sourceViews: string[]
    targetViews: string[]
    remote: string | null
  } | null>(null)
  /** The member of a split's pill that was right-clicked, whose own
   *  actions its menu offers: a member has no header of its own. */
  const [menuMember, setMenuMember] = useState<string | null>(null)
  /** A member's part of the pill drags that member alone (out to the
   *  strip, onto another view), not the whole split. */
  const memberDrag = (key: string) => {
    const source = dragSource(key)
    return {
      ...source,
      onDragStart: (event: DragEvent) => {
        event.stopPropagation()
        source.onDragStart(event)
      },
    }
  }
  const act = (change: (w: ShellWorkspace) => ShellWorkspace) => setWs(change)
  const close = (change: (w: ShellWorkspace) => ShellWorkspace) =>
    void saveBeforeClosing(() => setWs(change))
  const split = activeSplit(ws)
  const count = ws.entries.length
  /** Whether the strip holds more tabs than it shows, which is when it says
   *  how many there are. */
  const listRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    if (dragged === null) return
    const sourceExists = ws.entries.some(
      (entry) => entryId(entry) === dragged || (isSplit(entry) && entry.views.includes(dragged)),
    )
    if (dragVault === remote && (!dragWasOpen || sourceExists)) return
    setDrag(null)
    clearDragVault(null)
    clearDragWasOpen(false)
    setDropAt(null)
    setCombinePreview(null)
  }, [
    clearDragVault,
    clearDragWasOpen,
    dragVault,
    dragWasOpen,
    dragged,
    remote,
    setDrag,
    ws.entries,
  ])

  useEffect(() => {
    if (dragged !== null && dragVault === remote) return
    setDropAt(null)
    setCombinePreview(null)
  }, [dragged, dragVault, remote])

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setDropAt(null)
      setCombinePreview(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    // The list and each entry: a window resize, or an entry turning into a
    // wider split. A newly observed element reports at once, so the first
    // measure needs no call of its own.
    const observer = new ResizeObserver(() => setOverflowing(list.scrollWidth > list.clientWidth))
    observer.observe(list)
    for (const child of list.children) observer.observe(child)
    return () => observer.disconnect()
  }, [ws.entries])

  /** The rendered gesture may outlive its workspace or drag ownership until
   *  React commits. Read the store at event time before allowing its operation. */
  function gestureContextCurrent(): boolean {
    return (
      store.get(activeRemoteAtom) === remote &&
      store.get(shellWorkspaceAtom) === ws &&
      store.get(tabDragAtom) === dragged &&
      store.get(tabDragVaultAtom) === dragVault &&
      store.get(tabDragWasOpenAtom) === dragWasOpen
    )
  }

  /** The insertion point under the pointer: before the first entry whose
   *  middle is right of it, else the end. */
  function indexAt(event: DragEvent<HTMLElement>): number {
    const items = event.currentTarget.querySelectorAll<HTMLElement>('[data-entry-id]')
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i]!.getBoundingClientRect()
      if (event.clientX < rect.left + rect.width / 2) return i
    }
    return items.length
  }

  /** Where a drag over the strip would land, or null when it would change
   *  nothing (an entry dropped where it is). */
  function stripDrop(
    event: DragEvent<HTMLElement>,
  ):
    | { kind: 'reorder'; index: number }
    | { kind: 'combine'; target: string; next: ShellWorkspace }
    | null {
    if (!draggable || !event.dataTransfer.types.includes(TAB_MIME)) return null
    if (!gestureContextCurrent() || dragged === null || dragVault !== remote) return null
    const sourceExists = ws.entries.some(
      (entry) => entryId(entry) === dragged || (isSplit(entry) && entry.views.includes(dragged)),
    )
    if (!sourceExists && (dragWasOpen || !isViewKey(dragged))) {
      setDropAt(null)
      setCombinePreview(null)
      return null
    }
    const items = event.currentTarget.querySelectorAll<HTMLElement>('[data-entry-id]')
    for (const item of items) {
      const rect = item.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right) continue
      const position = rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width
      const id = item.dataset.entryId
      if (id === undefined) return null
      if (stripDropZone(position) === 'combine') {
        const next = combineOnStrip(ws, dragged, id)
        if (next === ws) {
          setCombinePreview(null)
          setDropAt(null)
          return null
        }
        const source =
          ws.entries.find((entry) => entryId(entry) === dragged) ??
          ws.entries.find((entry) => isSplit(entry) && entry.views.includes(dragged))
        const target = ws.entries.find((entry) => entryId(entry) === id)
        if (
          target === undefined ||
          (source === undefined && (dragWasOpen || !isViewKey(dragged)))
        ) {
          setCombinePreview(null)
          return null
        }
        const preview = {
          source: dragged,
          target: id,
          sourceViews:
            source !== undefined && isSplit(source) && entryId(source) === dragged
              ? [...source.views]
              : [dragged],
          targetViews: isSplit(target) ? [...target.views] : [target],
          remote,
        }
        setCombinePreview((current) =>
          current !== null &&
          current.source === preview.source &&
          current.target === preview.target &&
          current.remote === preview.remote &&
          current.sourceViews.join('\\0') === preview.sourceViews.join('\\0') &&
          current.targetViews.join('\\0') === preview.targetViews.join('\\0')
            ? current
            : preview,
        )
        return { kind: 'combine', target: id, next }
      }
      setCombinePreview(null)
      setDropAt(indexAt(event))
      const at = indexAt(event)
      return dropOnStrip(ws, dragged, at) === ws ? null : { kind: 'reorder', index: at }
    }
    setCombinePreview(null)
    const at = indexAt(event)
    return dropOnStrip(ws, dragged, at) === ws ? null : { kind: 'reorder', index: at }
  }

  const previewValid =
    combinePreview !== null &&
    combinePreview.remote === remote &&
    dragVault === remote &&
    (() => {
      const source =
        ws.entries.find((entry) => entryId(entry) === combinePreview.source) ??
        ws.entries.find((entry) => isSplit(entry) && entry.views.includes(combinePreview.source))
      const target = ws.entries.find((entry) => entryId(entry) === combinePreview.target)
      if (
        target === undefined ||
        (source === undefined && (dragWasOpen || !isViewKey(combinePreview.source)))
      ) {
        return false
      }
      const sourceViews =
        source !== undefined && isSplit(source) && entryId(source) === combinePreview.source
          ? source.views
          : [combinePreview.source]
      const targetViews = isSplit(target) ? target.views : [target]
      return (
        sourceViews.join('\\0') === combinePreview.sourceViews.join('\\0') &&
        targetViews.join('\\0') === combinePreview.targetViews.join('\\0')
      )
    })()

  /** An entry as the tab switcher lists it: a tab's mark and title, a
   *  split's members side by side, as in the strip. */
  function switcherRow(id: string): SwitcherRow {
    const entry = ws.entries.find((candidate) => entryId(candidate) === id)
    if (isSplit(entry)) {
      const members = entry.views.map(look)
      return {
        name: `Split view: ${members.map(spoken).join(', ')}`,
        content: <SplitMembers members={members} focused={null} />,
      }
    }
    const tab = look(id)
    return {
      name: spoken(tab),
      content: (
        <>
          <TabMark tab={tab} />
          <span className="truncate">{tab.title}</span>
        </>
      ),
    }
  }

  return (
    <TabSwitcher
      order={entriesByRecency(ws)}
      active={ws.active}
      onSelect={(id) => act((w) => selectEntry(w, id))}
      row={switcherRow}
    >
      {/* A row, not a landmark: the title band holds it on desktop, the mobile
        column's header on phones. */}
      <div
        data-slot="site-header"
        className="group/strip flex h-full min-w-0 flex-1 items-center gap-2 px-2"
      >
        <Tabs
          value={ws.active ?? ''}
          onValueChange={(id) => act((w) => selectEntry(w, id))}
          className="min-w-0 flex-1 items-center data-horizontal:flex-row"
        >
          {count > 0 ? (
            <TabsList
              ref={listRef}
              variant="line"
              aria-label="Tabs"
              className="min-w-0 justify-start overflow-x-auto group-data-horizontal/tabs:h-9"
              onDragOver={(event) => {
                const drop = stripDrop(event)
                const at = drop?.kind === 'reorder' ? drop.index : null
                if (at !== dropAt) setDropAt(at)
                if (drop === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDragLeave={(event) => {
                const to = event.relatedTarget
                if (!(to instanceof Node) || !event.currentTarget.contains(to)) {
                  setDropAt(null)
                  setCombinePreview(null)
                }
              }}
              onDrop={(event) => {
                const currentGesture = gestureContextCurrent()
                const drop = currentGesture ? stripDrop(event) : null
                const key = event.dataTransfer.getData(TAB_MIME)
                const ownsKey = key !== '' && key === dragged && key === store.get(tabDragAtom)
                const validPreview =
                  previewValid &&
                  combinePreview?.source === key &&
                  drop?.kind === 'combine' &&
                  combinePreview.target === drop.target
                setDropAt(null)
                setCombinePreview(null)
                setDrag(null)
                clearDragVault(null)
                clearDragWasOpen(false)
                if (!currentGesture || !ownsKey || drop === null) return
                event.preventDefault()
                if (drop.kind === 'combine') {
                  if (validPreview) act((w) => combineOnStrip(w, key, drop.target))
                } else {
                  act((w) => dropOnStrip(w, key, drop.index))
                }
              }}
            >
              {ws.entries.map((entry, index) => {
                const id = entryId(entry)
                const members = isSplit(entry) ? entry.views.map(look) : null
                const tab = members === null ? look(id) : null
                const targetPreview = previewValid && combinePreview?.target === id
                const combined =
                  targetPreview && combinePreview !== null
                    ? combineOnStrip(ws, combinePreview.source, id)
                    : null
                const combinedEntry =
                  combined?.entries.find((candidate) => entryId(candidate) === combined.active) ??
                  undefined
                const previewMembers =
                  targetPreview && isSplit(combinedEntry) ? combinedEntry.views.map(look) : null
                const label = targetPreview
                  ? `Split view: ${previewMembers!.map(spoken).join(', ')}`
                  : tab !== null
                    ? spoken(tab)
                    : `Split view: ${members!.map(spoken).join(', ')}`
                return (
                  <ContextMenu key={id}>
                    <ContextMenuTrigger asChild>
                      {/* The close button is the trigger's sibling: a button
                        cannot hold another button. */}
                      <div
                        data-entry-id={id}
                        data-combine-preview={targetPreview || undefined}
                        aria-description={targetPreview ? 'Split preview' : undefined}
                        data-tab-key={tab === null ? undefined : id}
                        data-drop-before={dropAt === index || undefined}
                        data-drop-after={(dropAt === count && index === count - 1) || undefined}
                        {...(draggable ? dragSource(id) : {})}
                        onContextMenu={(event) =>
                          setMenuMember(
                            (event.target as HTMLElement)
                              .closest<HTMLElement>('[data-member]')
                              ?.getAttribute('data-member') ?? null,
                          )
                        }
                        className={cn(
                          'group/tab relative flex h-full',
                          // Where a dragged entry would land: a hairline in
                          // the gap.
                          'data-drop-before:before:bg-primary data-drop-before:before:absolute data-drop-before:before:inset-y-1.5 data-drop-before:before:-start-0.5 data-drop-before:before:w-0.5 data-drop-before:before:rounded-full',
                          'data-drop-after:after:bg-primary data-drop-after:after:absolute data-drop-after:after:inset-y-1.5 data-drop-after:after:-end-0.5 data-drop-after:after:w-0.5 data-drop-after:after:rounded-full',
                        )}
                      >
                        <TabsTrigger
                          value={id}
                          data-combine-preview={targetPreview || undefined}
                          aria-label={label}
                          onClick={(event) => {
                            // A member's part of the pill focuses that member.
                            const member = (event.target as HTMLElement)
                              .closest<HTMLElement>('[data-member]')
                              ?.getAttribute('data-member')
                            if (member) act((w) => focusMember(w, id, member))
                          }}
                          variant="tab"
                          className={cn(
                            'relative hover:bg-foreground/5',
                            'group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/8',
                            tab !== null ? 'w-56' : members!.length > 2 ? 'w-80' : 'w-64',
                          )}
                        >
                          {/* Transparent, not invisible: Chromium must keep the same native drag target. */}
                          <span
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2',
                              targetPreview && 'opacity-0',
                            )}
                          >
                            {tab !== null ? (
                              <>
                                <TabMark tab={tab} dot={false} />
                                <span className="truncate">{tab.title}</span>
                                {tab.status !== undefined ? (
                                  <TabStatus status={tab.status} />
                                ) : null}
                              </>
                            ) : (
                              <SplitMembers
                                drag={draggable ? memberDrag : undefined}
                                members={members!}
                                focused={split?.id === id ? (entry as ShellSplit).focused : null}
                              />
                            )}
                          </span>
                          {previewMembers !== null ? (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 flex items-center px-3 pe-8"
                            >
                              <SplitMembers members={previewMembers} focused={null} />
                            </span>
                          ) : null}
                        </TabsTrigger>
                        {/* Shown on hover and keyboard focus, and always on the tab
                          in front unless its status badge holds the place. */}
                        <span
                          className={cn(
                            'absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 has-focus-visible:opacity-100',
                            tab?.status === undefined && 'group-has-data-active/tab:opacity-100',
                          )}
                        >
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={tab !== null ? `Close ${tab.title}` : 'Close split view'}
                            onClick={() => close((w) => closeEntry(w, id))}
                          >
                            <XIcon aria-hidden="true" />
                          </Button>
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <EntryMenu
                      split={isSplit(entry) ? entry : null}
                      member={
                        isSplit(entry) && menuMember !== null && entry.views.includes(menuMember)
                          ? (members!.find((m) => m.id === menuMember) ?? null)
                          : null
                      }
                      onMoveOut={(key) => act((w) => moveOut(w, key))}
                      onReplace={(key) => close((w) => replaceWithNew(w, key))}
                      onCloseMember={(key) => close((w) => closeTab(w, key))}
                      last={index === count - 1}
                      only={count < 2}
                      onOpenInSplit={() => act((w) => openInSplit(w, id))}
                      onSeparate={() => act((w) => separate(w, id))}
                      onClose={() => close((w) => closeEntry(w, id))}
                      onCloseOthers={() => close((w) => closeOtherTabs(w, id))}
                      onCloseRight={() => close((w) => closeTabsToRight(w, id))}
                      onReopen={() => act(reopenClosed)}
                    />
                  </ContextMenu>
                )
              })}
            </TabsList>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="New tab" onClick={onNewTab}>
                <PlusIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New tab</TooltipContent>
          </Tooltip>
        </Tabs>

        {count > 0 && overflowing ? (
          <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
            {count === 1 ? '1 tab' : `${count} tabs`}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Tab options">
              <EllipsisVerticalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={ws.active === null || (split !== null && split.views.length >= MAX_SPLIT)}
              onSelect={() => act(splitActive)}
            >
              <Columns2Icon aria-hidden="true" />
              Split view
              <DropdownMenuShortcut>⌘\</DropdownMenuShortcut>
            </DropdownMenuItem>
            {split !== null ? (
              <DropdownMenuItem onSelect={() => act((w) => separate(w, split.id))}>
                <UngroupIcon aria-hidden="true" />
                Separate
                <DropdownMenuShortcut>⇧⌘\</DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act(reopenClosed)}>
              <RotateCcwIcon aria-hidden="true" />
              Reopen closed tab
              <DropdownMenuShortcut>⇧⌘T</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={count === 0} onSelect={() => close(closeAllTabs)}>
              <XIcon aria-hidden="true" />
              Close all tabs
              <DropdownMenuShortcut>⌥⌘W</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TabSwitcher>
  )
}

/** A split's pill inside: each member's mark and title, side by side and
 *  truncating evenly, a hairline between them. With the split active, the
 *  focused member's title has the full weight. */
function SplitMembers({
  members,
  focused,
  drag,
}: {
  members: HeaderTab[]
  focused: string | null
  drag?: (key: string) => object
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {members.map((member, at) => (
        <Fragment key={member.id}>
          {at > 0 ? <span aria-hidden="true" className="bg-border h-4 w-px shrink-0" /> : null}
          <span
            data-member={member.id}
            {...(drag ? drag(member.id) : {})}
            className={cn(
              'flex min-w-0 flex-1 basis-0 items-center gap-1.5 motion-respond',
              focused !== null && focused !== member.id && 'text-muted-foreground',
            )}
          >
            <TabMark tab={member} />
            <span className="truncate">{member.title}</span>
          </span>
        </Fragment>
      ))}
    </span>
  )
}

/** A strip entry's right-click menu. */
function EntryMenu({
  split,
  member,
  onMoveOut,
  onReplace,
  onCloseMember,
  last,
  only,
  onOpenInSplit,
  onSeparate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onReopen,
}: {
  split: ShellSplit | null
  /** The right-clicked member of a split's pill, if any. */
  member: HeaderTab | null
  onMoveOut: (key: string) => void
  onReplace: (key: string) => void
  onCloseMember: (key: string) => void
  last: boolean
  only: boolean
  onOpenInSplit: () => void
  onSeparate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onReopen: () => void
}) {
  return (
    <ContextMenuContent className="w-56">
      {member !== null ? (
        <>
          <ContextMenuLabel className="text-muted-foreground truncate text-xs font-normal">
            {member.title}
          </ContextMenuLabel>
          <ContextMenuItem onSelect={() => onMoveOut(member.id)}>
            <PanelRightCloseIcon aria-hidden="true" />
            Move out of split
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onReplace(member.id)}>
            <PlusIcon aria-hidden="true" />
            Replace with New tab
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseMember(member.id)}>
            <XIcon aria-hidden="true" />
            Close {member.title}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {split === null ? (
        <ContextMenuItem onSelect={onOpenInSplit}>
          <SquareSplitHorizontalIcon aria-hidden="true" />
          Open in split view
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={onSeparate}>
          <UngroupIcon aria-hidden="true" />
          Separate
          <ContextMenuShortcut>⇧⌘\</ContextMenuShortcut>
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onClose}>
        <XIcon aria-hidden="true" />
        Close
      </ContextMenuItem>
      <ContextMenuItem disabled={only} onSelect={onCloseOthers}>
        Close others
      </ContextMenuItem>
      <ContextMenuItem disabled={last} onSelect={onCloseRight}>
        Close tabs to the right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onReopen}>
        <RotateCcwIcon aria-hidden="true" />
        Reopen closed tab
        <ContextMenuShortcut>⇧⌘T</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** A tab's state, at its end: what a session is doing, or that a document
 *  changed while another tab was in front. Said in the tab's own label, so
 *  hidden from the reader here. */
const TAB_STATUS = {
  working: { variant: 'info-light', label: 'Working' },
  'needs-you': { variant: 'warning-light', label: 'Needs you' },
  done: { variant: 'success-light', label: 'Done' },
  updated: { variant: 'primary-light', label: 'Updated' },
} as const

function TabStatus({ status }: { status: NonNullable<HeaderTab['status']> }) {
  const { variant, label } = TAB_STATUS[status]
  return (
    <span className="ms-auto group-hover/tab:opacity-0 group-has-[button:focus-visible]/tab:opacity-0">
      <Badge aria-hidden="true" variant={variant} data-tab-status={status}>
        {status === 'working' ? (
          <Spinner className="size-3" />
        ) : status === 'needs-you' ? (
          <CircleAlertIcon />
        ) : status === 'done' ? (
          <CheckIcon />
        ) : (
          <PencilIcon />
        )}
        {label}
      </Badge>
    </span>
  )
}

/** A tab's mark, with its state as a dot on its corner where there is no
 *  room for its badge (`dot`: a split's members, a dragged view's label). */
export function TabMark({ tab, dot = true }: { tab: HeaderTab; dot?: boolean }) {
  const Glyph = tab.icon ?? FileTextIcon
  return (
    <span className="relative flex shrink-0 items-center">
      {tab.mark ?? <Glyph aria-hidden={true} />}
      {dot && tab.status !== undefined ? (
        <span
          aria-hidden="true"
          data-tab-status={tab.status}
          className={cn(
            'ring-background absolute -end-0.5 -top-0.5 size-1.5 rounded-full ring-2',
            tab.status === 'working' && 'bg-info animate-pulse motion-reduce:animate-none',
            tab.status === 'needs-you' && 'bg-warning',
            tab.status === 'done' && 'bg-success',
            tab.status === 'updated' && 'bg-primary',
          )}
        />
      ) : null}
    </span>
  )
}
