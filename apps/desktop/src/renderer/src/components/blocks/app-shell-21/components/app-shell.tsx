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
import { ContentSkeleton } from "./content-skeleton"
import {
  MODELS,
  NEW_THREAD_ID,
  THREADS,
  WORKSPACES,
  type ThreadRecord,
} from "./data"
import { MobileHeader } from "./mobile-header"
import { SiteHeader } from "./site-header"
import { ThreadSidebar } from "./thread-sidebar"

/** Expanded width in pixels, and the drag point below which the rail takes over. */
const SIDEBAR_WIDTH = 248
const RAIL_THRESHOLD = 190
/** Matches the panel transition, so state lands after the motion finishes. */
const SETTLE_MS = 280

export function AppShell() {
  const isMobile = useIsMobile()
  const [threads, setThreads] = useState<ThreadRecord[]>(THREADS)
  const [activeThreadId, setActiveThreadId] = useState(THREADS[0]!.id)
  /** Lifted: the rail and the expanded nav both render it, so one owner. */
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(WORKSPACES[0]!.id)
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

  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const title = activeThread?.title ?? "New chat"

  function handleSelectThread(id: string) {
    setActiveThreadId(id)
    setMobileNavOpen(false)
  }

  function handleNewChat() {
    setActiveThreadId(NEW_THREAD_ID)
    setMobileNavOpen(false)
  }

  function handleTogglePin(id: string) {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === id ? { ...thread, pinned: !thread.pinned } : thread
      )
    )
  }

  /** In the sheet the header button closes it; on desktop it collapses the panel. */
  const sidebar = (
    <ThreadSidebar
      collapsed={false}
      onToggle={isMobile ? () => setMobileNavOpen(false) : toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      threads={threads}
      activeId={activeThreadId}
      activeWorkspaceId={activeWorkspaceId}
      onSelect={handleSelectThread}
      onNewChat={handleNewChat}
      onTogglePin={handleTogglePin}
      onSelectWorkspace={setActiveWorkspaceId}
    />
  )

  const rail = (
    <ThreadSidebar
      collapsed
      onToggle={toggleSidebar}
      onOpenSearch={() => setSearchOpen(true)}
      threads={threads}
      activeId={activeThreadId}
      activeWorkspaceId={activeWorkspaceId}
      onSelect={handleSelectThread}
      onNewChat={handleNewChat}
      onTogglePin={handleTogglePin}
      onSelectWorkspace={setActiveWorkspaceId}
    />
  )

  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <SiteHeader
        title={title}
        modelId={modelId}
        memoryOn={memoryOn}
        onModelChange={setModelId}
        onToggleMemory={() => setMemoryOn((current) => !current)}
      />
      {/* The landmark stays with the shell, so whatever replaces the
          placeholder inherits it. */}
      <main className="flex min-h-0 flex-1 flex-col">
        <ContentSkeleton />
      </main>
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
                // Drags update everything live; the animated toggle updates
                // nothing until it settles.
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