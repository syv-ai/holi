// App shell (ReUI app-shell-21, wired to Holi): a resizable sidebar that
// collapses to an icon rail, a header across the top and the view under it.
//
// Holi's one change to the block's layout: the header is a row the full width
// of the window. With the sidebar open its first part is the sidebar's top (the
// window's lights, the toggle, Search) and the divider runs up through it, so
// the sidebar reads as full height; collapsed, the header runs on over the
// rail. The toggle sits right after the lights in both, so it never moves.
// Desktop only: the block's mobile sheet and bar are dropped.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useAtomValue } from "jotai"
import { PanelLeftIcon, SearchIcon } from "lucide-react"
import { cn } from "@/lib/cn"
import { type PanelImperativeHandle } from "react-resizable-panels"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarProvider } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { activeRemoteAtom, vaultsAtom } from "@/state/vaults"

import { ChatSearchDialog } from "./chat-search-dialog"
import { ThreadSidebar } from "./thread-sidebar"

/** Expanded width in pixels, and the drag point below which the rail takes over. */
const SIDEBAR_WIDTH = 248
const RAIL_THRESHOLD = 190
/** Matches the panel transition, so state lands after the motion finishes. */
const SETTLE_MS = 280

export function AppShell({
  children,
  onAddVault,
}: {
  /** The view under the header. */
  children: ReactNode
  /** Opens the add-vault flow, which the shell's holder owns. */
  onAddVault: () => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Pointer x at press, so a drag does not also register as a click. */
  const pressX = useRef<number | null>(null)
  const sidebarPanel = useRef<PanelImperativeHandle>(null)
  /** Driven imperatively during the gesture: a React render here re-renders the
      whole shell, and a flex transition cannot draw behind that. */
  const rootRef = useRef<HTMLDivElement>(null)
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

  // ⌘K opens Search from anywhere in the shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey))
        return
      event.preventDefault()
      setSearchOpen((open) => !open)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
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

  return (
    // Every tooltip in the shell needs this ancestor to open.
    <TooltipProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={toggleSidebar}
        className="text-foreground h-svh min-h-0 w-full"
      >
        <div
          ref={rootRef}
          style={
            { "--shell-sidebar-w": `${sidebarWidth}px` } as React.CSSProperties
          }
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header
            data-slot="app-chrome"
            className="app-drag bg-sidebar flex h-11 shrink-0 items-center"
          >
            <div
              data-window-band="lights"
              className={cn(
                "flex h-full shrink-0 items-center gap-1 px-2",
                // The divider beside the sidebar runs up through the header.
                sidebarOpen &&
                  "w-[calc(var(--shell-sidebar-w)+1px)] border-e"
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      sidebarOpen ? "Collapse sidebar" : "Expand sidebar"
                    }
                    aria-expanded={sidebarOpen}
                    onClick={toggleSidebar}
                  >
                    <PanelLeftIcon aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}{" "}
                  <Kbd>⌘B</Kbd>
                </TooltipContent>
              </Tooltip>
              {sidebarOpen ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Search"
                      onClick={() => setSearchOpen(true)}
                      className="ms-auto"
                    >
                      <SearchIcon aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Search <Kbd>⌘K</Kbd>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
              <h1 className="min-w-0 truncate text-sm font-medium">
                {vault?.name ?? remote}
              </h1>
            </div>
          </header>

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
                    rootRef.current?.style.setProperty(
                      "--shell-sidebar-w",
                      `${size.inPixels}px`
                    )
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
                  <ThreadSidebar
                    onOpenSearch={() => setSearchOpen(true)}
                    onAddVault={onAddVault}
                  />
                </div>
                <div
                  inert={sidebarOpen}
                  className="pointer-events-none absolute inset-y-0 start-0 w-12 opacity-0 transition-opacity duration-200 group-data-[state=collapsed]/fade:pointer-events-auto group-data-[state=collapsed]/fade:opacity-100"
                >
                  <ThreadSidebar
                    collapsed
                    onOpenSearch={() => setSearchOpen(true)}
                    onAddVault={onAddVault}
                  />
                </div>
              </div>
            </ResizablePanel>

            {/* One hairline divider: drag resizes, a still click toggles. */}
            <ResizableHandle
              withHandle
              aria-label="Drag to resize. Click to collapse."
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
              {/* The landmark stays with the shell, so whatever replaces the
                  placeholder inherits it. */}
              <main className="bg-background flex h-full min-h-0 flex-col border-t">
                {children}
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        <ChatSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          onAddVault={onAddVault}
        />
      </SidebarProvider>
    </TooltipProvider>
  )
}
