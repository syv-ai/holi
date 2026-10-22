import { useEffect, useRef, useState } from "react"
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

import { ChatSearchDialog } from "./chat-search-dialog"
import { MODELS, THREADS } from "./data"
import type { Move } from "@/lib/tree-actions"
import { BOARD_TAB, useNewDocument } from "./documents-section"
import { MobileHeader } from "./mobile-header"
import { SiteHeader } from "./site-header"
import { ThreadSidebar } from "./thread-sidebar"
import { leadWidth, TitleBar } from "./title-bar"

/** Expanded width in pixels, and the drag point below which the rail takes over. */
const SIDEBAR_WIDTH = 248
const RAIL_THRESHOLD = 190
/** Matches the panel transition, so state lands after the motion finishes. */
const SETTLE_MS = 280

export function AppShell({ onAddVault }: { onAddVault: () => void }) {
  const isMobile = useIsMobile()
  /** The block's demo threads, still behind ⌘K until search covers the vault. */
  const threads = THREADS
  /** The open tab: a vault path, the board, or a ⌘K thread. */
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  /** The header's tabs, in the order they were opened. */
  const [openTabIds, setOpenTabIds] = useState<string[]>([])
  const [modelId, setModelId] = useState(MODELS[0]!.id)
  const [memoryOn, setMemoryOn] = useState(true)
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

  useEffect(() => {
    return () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
    }
  }, [])

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

  const tabs = openTabIds.map((id) => ({
    id,
    title: tabTitle(id),
  }))

  function tabTitle(id: string): string {
    if (id === BOARD_TAB) return "Board"
    const thread = threads.find((candidate) => candidate.id === id)
    if (thread) return thread.title
    return id.slice(id.lastIndexOf("/") + 1).replace(/\.md$/, "")
  }

  /** Opening a document brings its tab forward, adding one if it has none. */
  function openTab(id: string) {
    setOpenTabIds((current) =>
      current.includes(id) ? current : [...current, id]
    )
    setActiveThreadId(id)
  }

  /** Closing the active tab hands focus to its neighbour, the next one first. */
  function closeTab(id: string) {
    const index = openTabIds.indexOf(id)
    const rest = openTabIds.filter((tabId) => tabId !== id)
    setOpenTabIds(rest)
    if (id === activeThreadId) {
      setActiveThreadId(rest[Math.min(index, rest.length - 1)] ?? null)
    }
  }

  function handleSelectThread(id: string) {
    openTab(id)
    setMobileNavOpen(false)
  }

  /** A moved file's tab follows it to its new path. */
  function retargetTabs(moves: Move[]) {
    const to = new Map(moves.map((move) => [move.from, move.to]))
    setOpenTabIds((current) => current.map((id) => to.get(id) ?? id))
    setActiveThreadId((current) =>
      current === null ? null : (to.get(current) ?? current)
    )
  }

  const newDocument = useNewDocument(handleSelectThread)
  function handleNewChat() {
    void newDocument()
  }

  /** In the sheet the header button closes it; on desktop it collapses the panel. */
  const sidebar = (
    <ThreadSidebar
      collapsed={false}
      onToggle={isMobile ? () => setMobileNavOpen(false) : toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={activeThreadId}
      onOpen={handleSelectThread}
      onMoved={retargetTabs}
      onNewDocument={handleNewChat}
      onAddVault={onAddVault}
    />
  )

  const rail = (
    <ThreadSidebar
      collapsed
      onToggle={toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      activeId={activeThreadId}
      onOpen={handleSelectThread}
      onMoved={retargetTabs}
      onNewDocument={handleNewChat}
      onAddVault={onAddVault}
    />
  )

  const header = (
    <SiteHeader
      tabs={tabs}
      activeTabId={activeThreadId}
      onSelectTab={setActiveThreadId}
      onCloseTab={closeTab}
      onNewTab={handleNewChat}
      modelId={modelId}
      memoryOn={memoryOn}
      onModelChange={setModelId}
      onToggleMemory={() => setMemoryOn((current) => !current)}
    />
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
      <main className="flex min-h-0 flex-1 flex-col" />
    </div>
  )

  return (
    // Every tooltip in the shell needs this ancestor to open.
    <TooltipProvider>
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
              onToggleSidebar={toggleSidebar}
              onOpenSearch={() => setSearchOpen(true)}
              onNew={handleNewChat}
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
                  toggleSidebar()
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
      </SidebarProvider>
    </TooltipProvider>
  )
}
