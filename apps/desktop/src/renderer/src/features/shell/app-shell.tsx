// Adapted from ReUI's app-shell-21 block (`npx shadcn@latest view @reui/app-shell-21` shows the published source).
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'

import { useIsMobile } from '@/hooks/use-mobile'
import { useClaudeFirstRun } from '@/hooks/use-claude-first-run'
import { useSessionTabs } from '@/hooks/use-session-tabs'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SidebarProvider } from '@/components/ui/sidebar'
import { SettingsNav } from '@/features/settings/settings-nav'
import { useSettingsHotkey } from '@/features/settings/use-settings-hotkey'
import { newAgentSessionAtom } from '@/state/agents-slots'
import { appModeAtom } from '@/state/app-mode'
import { folderSurfacesAtom, runningPluginsAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
// Split tabs (docs/features/tabs-panes.md): one strip, a split being one
// entry of it.
import {
  activeSplit,
  closeAllTabs as closeAllTabsIn,
  closeTab as closeTabIn,
  entryIds,
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
} from '@/state/shell-workspace'
import { openingBeside } from '@/state/alt-open'
import { AGENTS_HOME_KEY, parseTabKey, tabKey, tabPath } from '@/state/tab-descriptor'
import { shellTabForPathAtom } from '@/state/surfaces'
import { activeRemoteAtom } from '@/state/vaults'
import type { Move } from '@/lib/tree-actions'
import { useShortcutDispatcher } from '@/hooks/use-shortcuts'
import { useActivityLog } from '@/state/activity'
import { useDocChangeMarks } from '@/state/doc-changes'
import { usePanelTerminals } from '@/state/panel-terminals'

import { CommandMenu } from '@/features/command-menu/command-menu'
import { ShortcutsDialog } from '@/features/command-menu/shortcuts-dialog'
// The status bar and the bottom panel (docs/features/status-bar.md).
import { BottomPanel } from '@/features/bottom-panel/bottom-panel'
import { StatusBar } from '@/features/status-bar/status-bar'
import { AppSidebar } from '@/features/sidebar/app-sidebar'
import { useSidebarApps } from '@/features/sidebar/sidebar-apps'
import { useNewDocument } from '@/features/sidebar/use-files'
import { DialogHost } from './dialog-host'
import { ReadyUpdateDialog } from './ready-update-dialog'
import { MobileHeader } from './mobile-header'
import { readShares, writeShares } from './split-shares'
import { SplitView, type MemberSlot } from './split-view'
import { TabStrip } from './tab-strip'
import { TabView } from './tab-view'
import { TitleBar } from './title-bar'
import { placedByDrop } from './use-tab-drag'
import { SIDEBAR_WIDTH, useSidebarFold } from './use-sidebar-fold'
import { useSettingsTab } from './use-settings-tab'
import { useShellRequests } from './use-shell-requests'
import { useShellShortcuts } from './use-shell-shortcuts'

/** Split tabs: the view slot of an empty strip, which shows the New tab's
 *  view. No tab key reads this way (`holi:` keys name a known kind). */
const NO_TAB = 'holi:none'

export function AppShell({ onAddVault }: { onAddVault: () => void }) {
  const isMobile = useIsMobile()
  /** The tab strip and its splits, this vault's (`state/shell-tabs.ts`). */
  const [ws, setWs] = useAtom(shellWorkspaceAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const tabForPath = useAtomValue(shellTabForPathAtom)
  const folders = useAtomValue(folderSurfacesAtom)
  /** The key a sidebar row, a search hit or a plugin's request opens: a view's
   *  own key (the board), or a vault path's tab, which a plugin's folder
   *  document (a deck) opens as its surface. */
  const keyFor = (id: string): string =>
    parseTabKey(id)?.kind === 'doc' || id.endsWith('.app') ? tabKey(tabForPath(id)) : id
  /** Split tabs: the active split, when the active entry is one. */
  const split = activeSplit(ws)
  /** The view in front (the active tab, or the split's focused member):
   *  what the sidebar marks and the keys act on. */
  const focusedKey = focusedTab(ws)
  const activeTab = focusedKey === null ? null : parseTabKey(focusedKey)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Pointer x at press, so a drag does not also register as a click. */
  const pressX = useRef<number | null>(null)
  const apps = useSidebarApps()
  /** The app in front (Mail, Calendar): the focused pane's tab, when it is
   *  one. An app folds the files sidebar to its rail while it is in front. */
  const app = activeTab?.kind === 'app' ? activeTab.id : null
  const {
    sidebarOpen,
    sidebarWidth,
    animate,
    sidebarPanel,
    fadeRef,
    pinRef,
    leadRef,
    toggleSidebar,
    showSidebar,
    onPanelResize,
  } = useSidebarFold(app)
  /** The sidebar's tab. It no longer swaps the main area: a session opens
   *  as a tab, and + on the Agents side opens the Agents home. */
  const [section, setSection] = useAtom(appModeAtom)
  const running = useAtomValue(runningPluginsAtom)
  const hasAgents = running.some((plugin) => plugin.agentsMode !== undefined)
  const newAgentSession = useSetAtom(newAgentSessionAtom)
  useSettingsHotkey()
  useSessionTabs(focusedKey)

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
    // A drop placed its widths already, as its preview showed them.
    if (placedByDrop(splitId, memberCount)) return
    if (stored !== null) setWs((w) => setShares(w, splitId, stored))
  }, [splitId, memberCount, remote, setWs])

  /** An app opens as a tab, or comes forward where it is. */
  function openApp(id: string) {
    setMobileNavOpen(false)
    setWs((w) => openTabIn(w, tabKey({ kind: 'app', id })))
  }

  const { openSettings: showSettings, leaveSettings } = useSettingsTab({
    focusedKey,
    update: setWs,
    showSidebar: () => {
      if (!isMobile) showSidebar()
    },
  })
  function openSettings() {
    setMobileNavOpen(false)
    showSettings()
  }

  /** + and ⌘T: a New tab, or on the Agents side a new session in the
   *  default agent (the mode's `newSession`), else the Agents home. */
  function openNewTab() {
    if (section === 'agents' && hasAgents) {
      if (newAgentSession()) return
      setWs((w) => openTabIn(w, AGENTS_HOME_KEY))
      return
    }
    setWs(openNewTabIn)
  }

  function closeTab(key: string) {
    setWs((w) => closeTabIn(w, key))
  }

  function closeAllTabs() {
    setWs(closeAllTabsIn)
  }

  /** Open a vault path, the board, or any tab key: as a tab, or in the
   *  active split's focused member (`openTab`). */
  function openTabKey(id: string) {
    const key = keyFor(id)
    // A vault path, whatever tab it opens as (a deck is a surface tab).
    if (parseTabKey(id)?.kind === 'doc' || id.endsWith('.app')) {
      setSection('documents')
    }
    // ⌥-click (or ⌥↩) opens it beside what is in front.
    const beside = openingBeside()
    setWs((w) => (beside ? openInSplit(w, key) : openTabIn(w, key)))
    setMobileNavOpen(false)
  }

  /** A moved file's tab follows it to its new path, splits included. */
  function retargetTabs(moves: Move[]) {
    setWs((w) => retargetTabsIn(w, moves, folders))
  }

  /** Split tabs: a sized member of the active split was resized; it takes
   *  `share`, and the member that fills takes the rest. */
  function resizeMember(key: string, share: number) {
    setWs((w) => {
      const s = activeSplit(w)
      if (s === null) return w
      const fill = s.views.length >= 3 ? 1 : 0
      const shares = s.views.map((v, i) => (v === key ? share : s.shares[i]!))
      const others = shares.reduce((sum, x, i) => (i === fill ? sum : sum + x), 0)
      shares[fill] = Math.max(0.05, 1 - others)
      const next = setShares(w, s.id, shares)
      const after = activeSplit(next)
      if (next !== w && after !== null) writeShares(remote, after.shares)
      return next
    })
  }

  const createDocument = useNewDocument(openTabKey)
  function newDocument() {
    void createDocument()
  }

  /** The Documents side forward and open: the sheet on mobile, else the panel. */
  function showFiles() {
    if (isMobile) return setMobileNavOpen(true)
    showSidebar()
  }
  useShellRequests({
    openSettings,
    openTabKey,
    revealFiles: () => {
      setSection('documents')
      showFiles()
    },
  })

  useShortcutDispatcher()
  // The activity log and the panel's shells are followed from here, for the
  // window's life, so the Output collects while the panel is closed.
  const retryActivity = useActivityLog()
  usePanelTerminals()
  // Which hidden document tabs changed, for the strip's Updated.
  useDocChangeMarks()
  useClaudeFirstRun(openTabKey)
  useShellShortcuts({
    // Split tabs: the keys step over strip entries, and ⌘W closes the view
    // in front (a split's focused member).
    tabIds: entryIds(ws),
    activeTabId: focusedKey,
    activeEntryId: ws.active,
    newTab: openNewTab,
    separate: split === null ? undefined : () => setWs((w) => separate(w, split.id)),
    stepMember: split === null ? undefined : (step) => setWs((w) => stepMember(w, step)),
    app,
    apps,
    open: openTabKey,
    selectTab: (id) => setWs((w) => selectEntry(w, id)),
    closeTab,
    closeAllTabs,
    reopenTab: () => setWs(reopenClosed),
    splitRight: () => setWs(splitActive),
    newDocument,
    toggleFiles: toggleSidebar,
    showFiles,
    openApp,
    setSearchOpen,
  })
  /** Settings in front: its nav takes the sidebar's place. */
  const settingsActive = activeTab?.kind === 'settings'

  /** In the sheet the header button closes it; on desktop it collapses the panel. */
  const sidebar = settingsActive ? (
    <SettingsNav onBack={leaveSettings} />
  ) : (
    <AppSidebar
      collapsed={false}
      onToggle={isMobile ? () => setMobileNavOpen(false) : toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={focusedKey}
      onOpen={openTabKey}
      onMoved={retargetTabs}
      onNewDocument={newDocument}
      onAddVault={onAddVault}
      activeApp={app}
      onOpenApp={openApp}
    />
  )

  const rail = (
    <AppSidebar
      collapsed
      onToggle={toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={focusedKey}
      onOpen={openTabKey}
      onMoved={retargetTabs}
      onNewDocument={newDocument}
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
      : [{ key: focusedKey ?? NO_TAB, share: 1 }]

  /** One view: its header in a split, then what it shows. Focus follows a
   *  press or keyboard focus into a split's member. */
  function memberBody(key: string) {
    const tab = key === NO_TAB ? null : key
    const isFocused = tab === focusedKey
    const focus = () => {
      if (split !== null && tab !== null) {
        setWs((w) => focusMember(w, split.id, tab))
      }
    }
    return (
      <section
        aria-label={multi ? `View ${members.findIndex((m) => m.key === key) + 1}` : undefined}
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
            settingsNavInSidebar={isFocused && settingsActive && !isMobile && sidebarOpen}
            onOpen={openTabKey}
            onOpenBeside={(id) => setWs((w) => openInSplit(w, keyFor(id)))}
            reading={
              members
                .map((member) => tabPath(member.key))
                .find((path) => path !== null && path !== tab) ?? null
            }
            onMoved={(from, to) => retargetTabs([{ from, to }])}
            onNewDocument={newDocument}
            onOpenSearch={() => setSearchOpen(true)}
          />
        </div>
      </section>
    )
  }

  const header = <TabStrip onNewTab={openNewTab} draggable={!isMobile} />

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* On desktop the header rides in the title band above both columns. */}
      {isMobile ? <div className="bg-background flex h-12 shrink-0 border-b">{header}</div> : null}
      {/* The landmark stays with the shell, so whatever fills the view
          inherits it. */}
      {/* The main area, then the running plugins' right-hand drawers (the
          agent's turn review, the Holis' dialogs), each deciding whether it
          is open, as the old shell mounted them. */}
      <div className="flex min-h-0 flex-1">
        {/* The views, then the bottom panel under all of them: one column,
            so the panel spans every split and stays put across tabs. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isMobile ? (
              memberBody(focusedKey ?? NO_TAB)
            ) : (
              <SplitView
                entryId={ws.active}
                members={members}
                renderMember={memberBody}
                onShareChange={resizeMember}
              />
            )}
          </main>
          {isMobile ? null : <BottomPanel onRetryOutput={retryActivity} />}
        </div>
        {running.flatMap(({ info, drawers = [] }) =>
          drawers.map((Drawer, i) => <Drawer key={`${info.id}:${i}`} />),
        )}
      </div>
      {/* The status bar: the column's foot, under the drawers too, on
          desktop only. */}
      {isMobile ? null : <StatusBar />}
    </div>
  )

  return (
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={toggleSidebar}
      className="bg-background text-foreground h-svh min-h-0 w-full"
    >
      {isMobile ? (
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          {/* The brand bar is global chrome and the header below is this
                chat's toolbar, so both stay pinned while the column scrolls. */}
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
            <MobileHeader onOpenSearch={() => setSearchOpen(true)} onNewDocument={newDocument} />
            {main}
          </div>
          {/* No stock close button: it would sit on the sidebar's Search
                  button, and the sidebar header carries Close chats instead. */}
          <SheetContent side="left" showCloseButton={false} className="w-72">
            <SheetHeader className="sr-only">
              <SheetTitle>Chats</SheetTitle>
              <SheetDescription>Switch between your conversations.</SheetDescription>
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
            onToggleSidebar={toggleSidebar}
          >
            {header}
          </TitleBar>
          <ResizablePanelGroup
            orientation="horizontal"
            animateFirst={animate}
            className="group/panels min-h-0 flex-1"
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
              onResize={onPanelResize}
              className="min-h-0"
            >
              <div
                ref={fadeRef}
                data-state={sidebarOpen ? 'open' : 'collapsed'}
                className="group/fade relative h-full overflow-hidden"
              >
                <div
                  ref={pinRef}
                  inert={!sidebarOpen}
                  style={{ '--sidebar-pin': `${sidebarWidth}px` } as CSSProperties}
                  className="motion-respond h-full w-(--sidebar-pin) group-data-[state=collapsed]/fade:pointer-events-none group-data-[state=collapsed]/fade:opacity-0"
                >
                  {sidebar}
                </div>
                <div
                  inert={sidebarOpen}
                  className="pointer-events-none absolute inset-y-0 start-0 w-12 opacity-0 motion-respond group-data-[state=collapsed]/fade:pointer-events-auto group-data-[state=collapsed]/fade:opacity-100"
                >
                  {rail}
                </div>
              </div>
            </ResizablePanel>

            {/* One hairline divider: drag resizes, a still click toggles. */}
            <ResizableHandle
              withHandle
              data-shell-divider=""
              title="Drag to resize. Click to collapse."
              onPointerDown={(event) => {
                pressX.current = event.clientX
              }}
              onClick={(event) => {
                const moved = Math.abs(event.clientX - (pressX.current ?? 0))
                if (moved > 4) return
                toggleSidebar()
              }}
              variant="primary"
            />

            <ResizablePanel minSize={360} className="min-h-0">
              {main}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <CommandMenu
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onOpen={(id, beside) =>
          beside ? setWs((w) => openInSplit(w, keyFor(id))) : openTabKey(id)
        }
        onAddVault={onAddVault}
      />
      <ShortcutsDialog />
      <DialogHost />
      <ReadyUpdateDialog />
    </SidebarProvider>
  )
}
