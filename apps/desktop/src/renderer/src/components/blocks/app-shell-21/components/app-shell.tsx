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
import {
  closeOtherTabs,
  closePane,
  closePaneTabs,
  closeTab as closeTabIn,
  focusPane,
  focusedPane,
  MAX_PANES,
  moveTab,
  openNewTab as openNewTabIn,
  openTab as openTabIn,
  paneBeside,
  reopenClosed,
  retargetTabs as retargetTabsIn,
  selectTab as selectTabIn,
  setShares,
  splitRight as splitRightIn,
  type ShellPane,
  type ShellWorkspace,
} from "@/state/shell-workspace"
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
import { PanesView } from "./panes-view"
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

/** Where a vault's last pane widths for a pane count are kept, on this
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
  /** The panes and their tabs, this vault's (`state/shell-tabs.ts`). */
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const focused = focusedPane(ws)
  /** The focused pane's tab: what the sidebar marks and the keys act on. */
  const activeThreadId = focused.active
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

  // A pane count this vault has had before opens at the widths it had.
  const paneCount = ws.panes.length
  useEffect(() => {
    if (paneCount < 2) return
    const stored = readShares(remote, paneCount)
    if (stored !== null) setWs((w) => setShares(w, stored))
  }, [paneCount, remote, setWs])

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
      const pane = focusedPane(w)
      if (back !== null && pane.tabs.includes(back)) {
        return selectTabIn(w, pane.id, back)
      }
      const other = pane.tabs.find((tab) => tab !== SETTINGS_KEY)
      return other === undefined ? w : selectTabIn(w, pane.id, other)
    })
  }

  /** +: in `paneId` (the focused pane by default), a New tab, or on the
   *  Agents side the Agents home, the new-session page. */
  function openNewTab(paneId?: string) {
    update((w) => {
      const there = paneId === undefined ? w : focusPane(w, paneId)
      return section === "agents" && hasAgents
        ? openTabIn(there, AGENTS_HOME_KEY)
        : openNewTabIn(there)
    })
  }

  function closeTab(key: string) {
    update((w) => closeTabIn(w, key))
  }

  function closeAllTabs() {
    update((w) => closePaneTabs(w, w.focused))
  }

  /** Open a vault path, the board, or any tab key, in the focused pane. */
  function handleSelectThread(id: string) {
    const key = keyFor(id)
    if (parseTabKey(key)?.kind === "doc" || key.endsWith(".app")) {
      setSection("documents")
    }
    update((w) => openTabIn(w, key))
    setMobileNavOpen(false)
  }

  /** A moved file's tab follows it to its new path, in every pane. */
  function retargetTabs(moves: Move[]) {
    update((w) => retargetTabsIn(w, moves))
  }

  function splitRight(paneId?: string, key?: string) {
    update((w) => splitRightIn(w, paneId ?? w.focused, key))
  }

  /** A sized pane was resized: it takes `share`, and the pane that fills
   *  takes the rest. */
  function resizePane(paneId: string, share: number) {
    update((w) => {
      const fill = w.panes.length === 3 ? 1 : 0
      const shares = w.panes.map((p) => (p.id === paneId ? share : p.share))
      const others = shares.reduce(
        (sum, s, i) => (i === fill ? sum : sum + s),
        0
      )
      shares[fill] = Math.max(0.05, 1 - others)
      const next = setShares(w, shares)
      if (next !== w)
        writeShares(
          remote,
          next.panes.map((p) => p.share)
        )
      return next
    })
  }

  const newDocument = useNewDocument(handleSelectThread)
  function handleNewChat() {
    void newDocument()
  }

  useShortcutDispatcher()
  useShellShortcuts({
    tabIds: focused.tabs,
    activeTabId: activeThreadId,
    apps,
    open: handleSelectThread,
    selectTab: (key) => update((w) => selectTabIn(w, w.focused, key)),
    closeTab,
    closeAllTabs,
    reopenTab: () => update(reopenClosed),
    splitRight: () => splitRight(),
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

  const multi = !isMobile && ws.panes.length > 1

  /** A pane's strip: in the title band with one pane, its own header with
   *  several. */
  function strip(pane: ShellPane, index: number) {
    return (
      <SiteHeader
        tabs={pane.tabs.map(look)}
        activeTabId={pane.active}
        focused={!multi || pane.id === ws.focused}
        onSelectTab={(key) => update((w) => selectTabIn(w, pane.id, key))}
        onCloseTab={closeTab}
        onCloseOtherTabs={(key) => update((w) => closeOtherTabs(w, key))}
        onNewTab={() => openNewTab(pane.id)}
        onCloseAllTabs={() => update((w) => closePaneTabs(w, pane.id))}
        onReopenTab={() => update(reopenClosed)}
        pane={
          isMobile
            ? undefined
            : {
                count: ws.panes.length,
                canSplit: ws.panes.length < MAX_PANES,
                first: index === 0,
                last: index === ws.panes.length - 1,
                onSplitRight: (key) => splitRight(pane.id, key),
                onMoveTab: (key, side) =>
                  update((w) => {
                    const to = paneBeside(w, pane.id, side)
                    return to === null ? w : moveTab(w, key, to.id)
                  }),
                onClosePane: () => update((w) => closePane(w, pane.id)),
              }
        }
      />
    )
  }

  /** One pane: its header when there are several, then its tab's view.
   *  Focus follows a press or keyboard focus into it. */
  function paneBody(pane: ShellPane) {
    const index = ws.panes.findIndex((p) => p.id === pane.id)
    const isFocused = pane.id === ws.focused
    return (
      <section
        aria-label={multi ? `Pane ${index + 1}` : undefined}
        data-pane={pane.id}
        data-pane-focused={isFocused || undefined}
        onPointerDownCapture={() => update((w) => focusPane(w, pane.id))}
        onFocusCapture={() => update((w) => focusPane(w, pane.id))}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {multi ? (
          <div className="flex h-11 shrink-0 border-b">
            {strip(pane, index)}
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabView
            tab={pane.active}
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

  const header = multi ? (
    // Several panes: each carries its strip, and the band is left to drag.
    <div className="min-w-0 flex-1" />
  ) : (
    strip(focused, ws.panes.indexOf(focused))
  )

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
            paneBody(focused)
          ) : (
            <PanesView
              panes={ws.panes}
              renderPane={paneBody}
              onShareChange={resizePane}
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
