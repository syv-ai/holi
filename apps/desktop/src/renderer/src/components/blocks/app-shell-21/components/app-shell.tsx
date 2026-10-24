import { useEffect, useRef, useState } from "react"
import { useAtom, useAtomValue } from "jotai"
import { cn } from "@/lib/cn"
import { type PanelImperativeHandle } from "react-resizable-panels"

import { useIsMobile } from "@/hooks/use-mobile"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SettingsNav } from "@/components/blocks/profile-9/components/settings-nav"
import { useSettingsHotkey } from "@/components/blocks/profile-9/components/use-settings-hotkey"
import { settingsRequestAtom } from "@/state/settings-section"
import { openDocumentRequestAtom } from "@/state/open-document"
import { runningPluginsAtom } from "@/state/plugins"
import { sidebarSectionAtom } from "@/state/sidebar-section"
import { shellWorkspaceAtom } from "@/state/shell-tabs"
// Split tabs (docs/features/tabs-panes.md): one strip, a split being one
// entry of it.
import {
  activeSplit,
  closeAllTabs as closeAllTabsIn,
  closeTab as closeTabIn,
  entryIds,
  entryOf,
  focusedTab,
  focusMember,
  openInSplit,
  openNewTab as openNewTabIn,
  openTab as openTabIn,
  reopenClosed,
  retargetTabs as retargetTabsIn,
  selectEntry,
  separate,
  setShares,
  splitActive,
  stepMember,
  type ShellWorkspace,
} from "@/state/shell-workspace"
import { openingBeside } from "@/state/alt-open"
import {
  AGENTS_HOME_KEY,
  parseTabKey,
  SETTINGS_KEY,
  tabForPath,
  tabKey,
} from "@/state/tab-descriptor"
import { activeRemoteAtom } from "@/state/vaults"

import { ChatSearchDialog } from "./chat-search-dialog"
import { THREADS } from "./data"
import type { Move } from "@/lib/tree-actions"
import { useNewDocument } from "./documents-section"
import { MobileHeader } from "./mobile-header"
import { PanesView, type MemberSlot } from "./panes-view"
import { SiteHeader } from "./site-header"
import { useSidebarApps } from "./sidebar-apps"
import { ShortcutsDialog } from "./shortcuts-dialog"
import { TabView } from "./tab-view"
import { useTabLook } from "./tab-look"
import { useSessionTabs } from "./use-session-tabs"
import { useShellShortcuts } from "./use-shell-shortcuts"
import { useShortcutDispatcher } from "@/state/shortcuts"
import { ThreadSidebar } from "./thread-sidebar"
import { leadWidth, TitleBar } from "./title-bar"

/** Expanded width in pixels, and the drag point below which the rail takes over. */
const SIDEBAR_WIDTH = 248
const RAIL_THRESHOLD = 190
/** Matches the panel transition, so state lands after the motion finishes. */
const SETTLE_MS = 280

/** Where a vault's last split widths for a member count are kept, on this
 *  machine (docs/features/tabs-panes.md, Persistence). */
function sharesStorageKey(remote: string | null, count: number): string {
  return `holi.panes.${remote ?? ""}.${count}`
}

function readShares(remote: string | null, count: number): number[] | null {
  try {
    const raw = localStorage.getItem(sharesStorageKey(remote, count))
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return Array.isArray(parsed) &&
      parsed.length === count &&
      parsed.every((n) => typeof n === "number" && n > 0)
      ? (parsed as number[])
      : null
  } catch {
    return null
  }
}

function writeShares(remote: string | null, shares: number[]): void {
  try {
    localStorage.setItem(
      sharesStorageKey(remote, shares.length),
      JSON.stringify(shares)
    )
  } catch {
    // Storage off (a private window): the widths last the session only.
  }
}

/** Split tabs: the view slot of an empty strip, which shows the New tab's
 *  view. No tab key reads this way (`holi:` keys name a known kind). */
const NO_TAB = "holi:none"

/** The key a sidebar row, a search hit or a plugin's request opens: a view's
 *  own key (the board), or a vault path's tab. */
function keyFor(id: string): string {
  return parseTabKey(id)?.kind === "doc" || id.endsWith(".app")
    ? tabKey(tabForPath(id))
    : id
}
export function AppShell({ onAddVault }: { onAddVault: () => void }) {
  const isMobile = useIsMobile()
  /** The block's demo threads, still behind ⌘K until search covers the vault. */
  const threads = THREADS
  /** The tab strip and its splits, this vault's (`state/shell-tabs.ts`). */
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const remote = useAtomValue(activeRemoteAtom)
  /** Split tabs: the active split, when the active entry is one. */
  const split = activeSplit(ws)
  /** The view in front (the active tab, or the split's focused member):
   *  what the sidebar marks and the keys act on. */
  const activeThreadId = focusedTab(ws)
  const activeTab = activeThreadId === null ? null : parseTabKey(activeThreadId)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Pointer x at press, so a drag does not also register as a click. */
  const pressX = useRef<number | null>(null)
  const sidebarPanel = useRef<PanelImperativeHandle>(null)
  /** Driven imperatively during the gesture: a React render here re-renders the
      whole shell, and a flex transition cannot draw behind that. */
  const fadeRef = useRef<HTMLDivElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)
  /** The title band's sidebar half, kept to the sidebar's width the same way. */
  const leadRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(SIDEBAR_WIDTH)
  const settling = useRef(false)
  const settleTimer = useRef<number | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH)
  /** Armed on the first resize: any earlier and the first layout animates in. */
  const [animate, setAnimate] = useState(false)
  const apps = useSidebarApps()
  /** The app in front (Mail, Calendar): the focused pane's tab, when it is
   *  one. An app folds the files sidebar to its rail while it is in front. */
  const app = activeTab?.kind === "app" ? activeTab.id : null
  /** Whether the files sidebar was open when an app came forward, so leaving
   *  the app gives it back as it was. */
  const openBeforeApp = useRef(false)
  /** The tab in front when Settings came forward, for its Back. */
  const beforeSettings = useRef<string | null>(null)
  const settingsRequest = useAtomValue(settingsRequestAtom)
  const openRequest = useAtomValue(openDocumentRequestAtom)
  /** The sidebar's tab. It no longer swaps the main area: a session opens
   *  as a tab, and + on the Agents side opens the Agents home. */
  const [section, setSection] = useAtom(sidebarSectionAtom)
  const running = useAtomValue(runningPluginsAtom)
  const hasAgents = running.some((plugin) => plugin.agentsMode !== undefined)
  const look = useTabLook()
  useSettingsHotkey()
  useSessionTabs(activeThreadId)

  useEffect(() => {
    return () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
    }
  }, [])

  // ⌘, the profile menu, or a plugin's "Open Connections" asked for
  // Settings: bring its tab forward, with the sidebar open to carry its nav.
  const seenRequest = useRef(settingsRequest)
  useEffect(() => {
    if (settingsRequest === seenRequest.current) return
    seenRequest.current = settingsRequest
    openSettings()
    // Only a new request opens it; the handler reads the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRequest])

  // A plugin asked to open a document (a chat's changed file, a saved
  // reply): it opens as a tab, on the Documents side.
  const seenOpen = useRef(openRequest)
  useEffect(() => {
    if (openRequest === seenOpen.current) return
    seenOpen.current = openRequest
    if (openRequest !== null) handleSelectThread(openRequest.path)
    // Only a new request opens; the handler reads the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest])

  // An app coming forward folds the files to the rail; leaving it for any
  // other tab gives them back as they were.
  const appBefore = useRef<string | null>(null)
  useEffect(() => {
    const was = appBefore.current
    appBefore.current = app
    const panel = sidebarPanel.current
    if (was === null && app !== null) {
      openBeforeApp.current = !!panel && !panel.isCollapsed()
      if (openBeforeApp.current) toggleSidebar()
    } else if (was !== null && app === null) {
      if (openBeforeApp.current && panel?.isCollapsed()) toggleSidebar()
    }
    // Only the app changing folds; the toggle reads the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app])

  // Split tabs: a split, or a member count, this vault has not laid out in
  // this session opens at the widths it last had for that count.
  const splitId = split?.id ?? null
  const memberCount = split?.views.length ?? 1
  const seeded = useRef(new Set<string>())
  useEffect(() => {
    if (splitId === null) return
    const seen = `${splitId}:${memberCount}`
    if (seeded.current.has(seen)) return
    seeded.current.add(seen)
    const stored = readShares(remote, memberCount)
    if (stored !== null) setWs((w) => setShares(w, splitId, stored))
  }, [splitId, memberCount, remote, setWs])

  /** React state catches up only after the motion has finished. */
  function settleOpen(next: boolean) {
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
    settling.current = true
    settleTimer.current = window.setTimeout(() => {
      settling.current = false
      setSidebarWidth(widthRef.current)
      setSidebarOpen(next)
    }, SETTLE_MS)
  }

  function toggleSidebar() {
    const panel = sidebarPanel.current
    if (!panel) return
    const next = panel.isCollapsed()
    fadeRef.current?.setAttribute("data-state", next ? "open" : "collapsed")
    // Guard first: collapse()/expand() fire onResize synchronously, and that
    // callback must not re-render the shell while the motion runs.
    settleOpen(next)
    if (next) panel.expand()
    else panel.collapse()
  }

  function update(change: (w: ShellWorkspace) => ShellWorkspace) {
    setWs(change)
  }

  /** An app opens as a tab, or comes forward where it is. */
  function openApp(id: string) {
    setMobileNavOpen(false)
    update((w) => openTabIn(w, tabKey({ kind: "app", id })))
  }

  /** The band's toggle and the divider. */
  function toggleFiles() {
    toggleSidebar()
  }

  /** Settings comes forward as a tab, its nav in place of the files. A
   *  folded sidebar opens for it, since the nav is how its pages are reached. */
  function openSettings() {
    setMobileNavOpen(false)
    if (activeThreadId !== SETTINGS_KEY) beforeSettings.current = activeThreadId
    update((w) => openTabIn(w, SETTINGS_KEY))
    if (!isMobile && sidebarPanel.current?.isCollapsed()) toggleSidebar()
  }

  /** Settings' Back: to the tab it came from, Settings staying open. */
  function leaveSettings() {
    const back = beforeSettings.current
    update((w) => {
      // Split tabs: back to that tab wherever it is now, else any other.
      if (back !== null && entryOf(w, back) !== null) {
        return selectEntry(w, back)
      }
      const other = entryIds(w).find((id) => id !== SETTINGS_KEY)
      return other === undefined ? w : selectEntry(w, other)
    })
  }

  /** + and ⌘T: a New tab, or on the Agents side the Agents home, the
   *  new-session page. */
  function openNewTab() {
    update((w) =>
      section === "agents" && hasAgents
        ? openTabIn(w, AGENTS_HOME_KEY)
        : openNewTabIn(w)
    )
  }

  function closeTab(key: string) {
    update((w) => closeTabIn(w, key))
  }

  function closeAllTabs() {
    update(closeAllTabsIn)
  }

  /** Open a vault path, the board, or any tab key: as a tab, or in the
   *  active split's focused member (`openTab`). */
  function handleSelectThread(id: string) {
    const key = keyFor(id)
    if (parseTabKey(key)?.kind === "doc" || key.endsWith(".app")) {
      setSection("documents")
    }
    // ⌥-click (or ⌥↩) opens it beside what is in front.
    const beside = openingBeside()
    update((w) => (beside ? openInSplit(w, key) : openTabIn(w, key)))
    setMobileNavOpen(false)
  }

  /** A moved file's tab follows it to its new path, splits included. */
  function retargetTabs(moves: Move[]) {
    update((w) => retargetTabsIn(w, moves))
  }

  /** Split tabs: a sized member of the active split was resized; it takes
   *  `share`, and the member that fills takes the rest. */
  function resizeMember(key: string, share: number) {
    update((w) => {
      const s = activeSplit(w)
      if (s === null) return w
      const fill = s.views.length >= 3 ? 1 : 0
      const shares = s.views.map((v, i) => (v === key ? share : s.shares[i]!))
      const others = shares.reduce(
        (sum, x, i) => (i === fill ? sum : sum + x),
        0
      )
      shares[fill] = Math.max(0.05, 1 - others)
      const next = setShares(w, s.id, shares)
      const after = activeSplit(next)
      if (next !== w && after !== null) writeShares(remote, after.shares)
      return next
    })
  }

  const newDocument = useNewDocument(handleSelectThread)
  function handleNewChat() {
    void newDocument()
  }

  useShortcutDispatcher()
  useShellShortcuts({
    // Split tabs: the keys step over strip entries, and ⌘W closes the view
    // in front (a split's focused member).
    tabIds: entryIds(ws),
    activeTabId: activeThreadId,
    activeEntryId: ws.active,
    newTab: openNewTab,
    separate:
      split === null ? undefined : () => update((w) => separate(w, split.id)),
    stepMember:
      split === null ? undefined : (step) => update((w) => stepMember(w, step)),
    apps,
    open: handleSelectThread,
    selectTab: (id) => update((w) => selectEntry(w, id)),
    closeTab,
    closeAllTabs,
    reopenTab: () => update(reopenClosed),
    splitRight: () => update(splitActive),
    newDocument: handleNewChat,
    toggleFiles,
    showFiles: () => {
      if (isMobile) return setMobileNavOpen(true)
      if (sidebarPanel.current?.isCollapsed()) toggleSidebar()
    },
    openApp,
    setSearchOpen,
  })
  /** Settings in front: its nav takes the sidebar's place. */
  const settingsActive = activeTab?.kind === "settings"

  /** In the sheet the header button closes it; on desktop it collapses the panel. */
  const sidebar = settingsActive ? (
    <SettingsNav onBack={leaveSettings} />
  ) : (
    <ThreadSidebar
      collapsed={false}
      onToggle={isMobile ? () => setMobileNavOpen(false) : toggleFiles}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={activeThreadId}
      onOpen={handleSelectThread}
      onMoved={retargetTabs}
      onNewDocument={handleNewChat}
      onAddVault={onAddVault}
      activeApp={app}
      onOpenApp={openApp}
    />
  )

  const rail = (
    <ThreadSidebar
      collapsed
      onToggle={toggleFiles}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={activeThreadId}
      onOpen={handleSelectThread}
      onMoved={retargetTabs}
      onNewDocument={handleNewChat}
      onAddVault={onAddVault}
      activeApp={app}
      onOpenApp={openApp}
    />
  )

  // Split tabs: the active entry's views side by side, a split's members
  // each under a header of its own; one strip, always in the title band.
  const multi = !isMobile && split !== null
  /** The views in front: the split's members, else the active tab, else
   *  the New tab's view of an empty strip. */
  const members: MemberSlot[] =
    split !== null
      ? split.views.map((key, i) => ({ key, share: split.shares[i]! }))
      : [{ key: activeThreadId ?? NO_TAB, share: 1 }]

  /** One view: its header in a split, then what it shows. Focus follows a
   *  press or keyboard focus into a split's member. */
  function memberBody(key: string) {
    const tab = key === NO_TAB ? null : key
    const isFocused = tab === activeThreadId
    const focus = () => {
      if (split !== null && tab !== null) {
        update((w) => focusMember(w, split.id, tab))
      }
    }
    return (
      <section
        aria-label={
          multi
            ? `View ${members.findIndex((m) => m.key === key) + 1}`
            : undefined
        }
        data-pane={key}
        data-pane-focused={(multi && isFocused) || undefined}
        onPointerDownCapture={focus}
        onFocusCapture={focus}
        // No header of its own: the view's own top row is its header, and
        // the split's pill in the strip names, closes and moves its members.
        // A hairline over the focused member says where an open lands.
        className="data-pane-focused:before:bg-ring relative flex min-h-0 min-w-0 flex-1 flex-col data-pane-focused:before:absolute data-pane-focused:before:inset-x-0 data-pane-focused:before:top-0 data-pane-focused:before:z-10 data-pane-focused:before:h-px"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabView
            tab={tab}
            settingsNavInSidebar={
              isFocused && settingsActive && !isMobile && sidebarOpen
            }
            onOpen={handleSelectThread}
            onNewDocument={handleNewChat}
            onOpenSearch={() => setSearchOpen(true)}
          />
        </div>
      </section>
    )
  }

  const header = <SiteHeader onNewTab={openNewTab} draggable={!isMobile} />

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* On desktop the header rides in the title band above both columns. */}
      {isMobile ? (
        <div className="bg-background flex h-12 shrink-0 border-b">
          {header}
        </div>
      ) : null}
      {/* The landmark stays with the shell, so whatever fills the view
          inherits it. */}
      {/* The main area, then the running plugins' right-hand drawers (the
          agent's turn review, the Holis' dialogs), each deciding whether it
          is open, as the old shell mounted them. */}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isMobile ? (
            memberBody(activeThreadId ?? NO_TAB)
          ) : (
            <PanesView
              entryId={ws.active}
              members={members}
              renderMember={memberBody}
              onShareChange={resizeMember}
            />
          )}
        </main>
        {running.flatMap(({ info, drawers = [] }) =>
          drawers.map((Drawer, i) => <Drawer key={`${info.id}:${i}`} />)
        )}
      </div>
    </div>
  )

  return (
    // Every tooltip in the shell needs this ancestor to open.
    <TooltipProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={toggleFiles}
        className="bg-background text-foreground h-svh min-h-0 w-full"
      >
        {isMobile ? (
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            {/* The brand bar is global chrome and the header below is this
                chat's toolbar, so both stay pinned while the column scrolls. */}
            <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
              <MobileHeader
                onOpenSearch={() => setSearchOpen(true)}
                onNewChat={handleNewChat}
              />
              {main}
            </div>
            {/* No stock close button: it would sit on the sidebar's Search
                  button, and the sidebar header carries Close chats instead. */}
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-72 p-0"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Chats</SheetTitle>
                <SheetDescription>
                  Switch between your conversations.
                </SheetDescription>
              </SheetHeader>
              {sidebar}
            </SheetContent>
          </Sheet>
        ) : (
          <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
            <TitleBar
              sidebarOpen={sidebarOpen}
              sidebarWidth={sidebarWidth}
              leadRef={leadRef}
              onToggleSidebar={toggleFiles}
            >
              {header}
            </TitleBar>
            <ResizablePanelGroup
              orientation="horizontal"
              className={cn(
                "group/panels min-h-0 flex-1",
                animate &&
                  "[&>[data-panel]:first-child]:transition-[flex] [&>[data-panel]:first-child]:duration-200 [&>[data-panel]:first-child]:ease-linear has-[[data-separator=active]]:[&>[data-panel]:first-child]:transition-none"
              )}
            >
              {/* One mounted panel that animates between rail and full width, the
                way the shadcn sidebar transitions. */}
              <ResizablePanel
                panelRef={sidebarPanel}
                defaultSize={SIDEBAR_WIDTH}
                minSize={208}
                maxSize={360}
                collapsible
                collapsedSize={48}
                groupResizeBehavior="preserve-pixel-size"
                onResize={(size) => {
                  // The band's divider follows the panel every frame, the
                  // animated toggle included, so the two never part.
                  const lead = leadRef.current
                  if (lead) {
                    const wide = size.inPixels > RAIL_THRESHOLD
                    lead.style.width = wide
                      ? `${leadWidth(size.inPixels)}px`
                      : ""
                    lead.toggleAttribute("data-open", wide)
                  }
                  // Drags update everything else live too; the animated
                  // toggle updates nothing else until it settles.
                  if (!settling.current) {
                    const open = size.inPixels > RAIL_THRESHOLD
                    fadeRef.current?.setAttribute(
                      "data-state",
                      open ? "open" : "collapsed"
                    )
                    if (open && pinRef.current) {
                      widthRef.current = size.inPixels
                      pinRef.current.style.width = `${size.inPixels}px`
                    }
                    setSidebarOpen(open)
                  }
                  setAnimate(true)
                }}
                className="min-h-0"
              >
                <div
                  ref={fadeRef}
                  data-state={sidebarOpen ? "open" : "collapsed"}
                  className="group/fade relative h-full overflow-hidden"
                >
                  <div
                    ref={pinRef}
                    inert={!sidebarOpen}
                    style={{ width: sidebarWidth }}
                    className="h-full transition-opacity duration-200 group-data-[state=collapsed]/fade:pointer-events-none group-data-[state=collapsed]/fade:opacity-0"
                  >
                    {sidebar}
                  </div>
                  <div
                    inert={sidebarOpen}
                    className="pointer-events-none absolute inset-y-0 start-0 w-12 opacity-0 transition-opacity duration-200 group-data-[state=collapsed]/fade:pointer-events-auto group-data-[state=collapsed]/fade:opacity-100"
                  >
                    {rail}
                  </div>
                </div>
              </ResizablePanel>

              {/* One hairline divider: drag resizes, a still click toggles. */}
              <ResizableHandle
                withHandle
                title="Drag to resize. Click to collapse."
                onPointerDown={(event) => {
                  pressX.current = event.clientX
                }}
                onClick={(event) => {
                  const moved = Math.abs(event.clientX - (pressX.current ?? 0))
                  if (moved > 4) return
                  toggleFiles()
                }}
                className="hover:bg-primary data-[separator=hover]:bg-primary data-[separator=active]:bg-primary hover:[&>div]:bg-primary [&[data-separator=hover]>div]:bg-primary [&[data-separator=active]>div]:bg-primary relative z-10 cursor-col-resize transition-colors after:w-3 [&>div]:transition-colors"
              />

              <ResizablePanel minSize={360} className="min-h-0">
                {main}
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        )}

        <ChatSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          threads={threads}
          onSelect={handleSelectThread}
        />
        <ShortcutsDialog />
      </SidebarProvider>
    </TooltipProvider>
  )
}
