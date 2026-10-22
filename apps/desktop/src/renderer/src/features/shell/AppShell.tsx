/**
 * The window once a vault is open (ReUI's app-shell-21, on Holi's parts): a
 * resizable sidebar that folds to a 48px rail, a header across the top, and
 * the view under it. Flat panels on the window's ground, split by hairlines.
 *
 * The header is one row the full width of the window, whatever the sidebar
 * does. Open, its first part is the sidebar's own top (the window's lights,
 * the toggle, Search) and the hairline beside the sidebar runs through it, so
 * the sidebar reads as full height. Folded, that part shrinks to the lights
 * and the toggle and the header runs on over the rail. The toggle sits right
 * after the lights in both, so it never moves under the pointer.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PanelLeftIcon, Search } from 'lucide-react'
import {
  IconButton,
  Kbd,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  SidebarProvider,
  type PanelImperativeHandle,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'
import { AppSidebar } from './AppSidebar'
import { SearchDialog } from './SearchDialog'

/** Open width in pixels, and the drag point below which the rail takes over. */
const SIDEBAR_WIDTH = 248
const RAIL_WIDTH = 48
const RAIL_THRESHOLD = 190
/** Matches the panel's motion, so state lands after the motion finishes. */
const SETTLE_MS = 280

export function AppShell({
  children,
  onAddVault,
}: {
  /** The view under the header. */
  children: ReactNode
  /** Opens the add-vault flow, which the shell's holder owns. */
  onAddVault: () => void
}): React.JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const remote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  /** Pointer x at press, so a drag does not also register as a click. */
  const pressX = useRef<number | null>(null)
  const sidebarPanel = useRef<PanelImperativeHandle>(null)
  /** Driven imperatively during the gesture: a React render here re-renders
   *  the whole shell, and a flex transition cannot draw behind that. */
  const rootRef = useRef<HTMLDivElement>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(SIDEBAR_WIDTH)
  const settling = useRef(false)
  const settleTimer = useRef<number | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH)

  useEffect(() => {
    return () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
    }
  }, [])

  // ⌘K opens Search from anywhere in the shell.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setSearchOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** The header's first part follows the sidebar's width as it is dragged. */
  function trackWidth(px: number) {
    widthRef.current = px
    if (pinRef.current) pinRef.current.style.width = `${px}px`
    rootRef.current?.style.setProperty('--shell-sidebar-w', `${px}px`)
  }

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
    fadeRef.current?.setAttribute('data-state', next ? 'open' : 'collapsed')
    // Guard first: collapse()/expand() fire onResize synchronously, and that
    // callback must not re-render the shell while the motion runs.
    settleOpen(next)
    if (next) panel.expand()
    else panel.collapse()
  }

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={toggleSidebar} className="min-h-0 flex-1">
      <div
        ref={rootRef}
        style={{ '--shell-sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header className="app-drag flex h-10 shrink-0 items-center">
          <div
            data-window-band="nav"
            className={cn(
              'flex h-full shrink-0 items-center gap-1 px-2',
              // The hairline beside the sidebar runs up through the header.
              sidebarOpen && 'w-[calc(var(--shell-sidebar-w)+1px)] border-e border-divider',
            )}
          >
            <IconButton
              icon={PanelLeftIcon}
              label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              tooltip={
                <span className="flex items-center gap-2">
                  {sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
                  <Kbd>⌘B</Kbd>
                </span>
              }
              size="md"
              aria-expanded={sidebarOpen}
              onClick={toggleSidebar}
            />
            {sidebarOpen && (
              <IconButton
                icon={Search}
                label="Search"
                tooltip={
                  <span className="flex items-center gap-2">
                    Search
                    <Kbd>⌘K</Kbd>
                  </span>
                }
                size="md"
                className="ms-auto"
                onClick={() => setSearchOpen(true)}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
            <h1 className="min-w-0 truncate text-sm font-medium">{vault?.name ?? remote}</h1>
          </div>
        </header>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {/* One mounted panel that moves between rail and full width. */}
          <ResizablePanel
            panelRef={sidebarPanel}
            defaultSize={SIDEBAR_WIDTH}
            minSize={208}
            maxSize={360}
            collapsible
            collapsedSize={RAIL_WIDTH}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              // Drags update everything live; the animated toggle updates
              // nothing until it settles.
              if (settling.current) return
              const open = size.inPixels > RAIL_THRESHOLD
              fadeRef.current?.setAttribute('data-state', open ? 'open' : 'collapsed')
              if (open) trackWidth(size.inPixels)
              setSidebarOpen(open)
            }}
          >
            <div
              ref={fadeRef}
              data-state={sidebarOpen ? 'open' : 'collapsed'}
              className="group/fade relative h-full overflow-hidden"
            >
              <div
                ref={pinRef}
                inert={!sidebarOpen}
                style={{ width: sidebarWidth }}
                className="h-full motion-respond group-data-[state=collapsed]/fade:pointer-events-none group-data-[state=collapsed]/fade:opacity-0"
              >
                <AppSidebar onAddVault={onAddVault} onOpenSearch={() => setSearchOpen(true)} />
              </div>
              <div
                inert={sidebarOpen}
                className="pointer-events-none absolute inset-y-0 start-0 w-12 opacity-0 motion-respond group-data-[state=collapsed]/fade:pointer-events-auto group-data-[state=collapsed]/fade:opacity-100"
              >
                <AppSidebar
                  collapsed
                  onAddVault={onAddVault}
                  onOpenSearch={() => setSearchOpen(true)}
                />
              </div>
            </div>
          </ResizablePanel>

          {/* One hairline divider: drag resizes, a still click toggles. */}
          <ResizableHandle
            aria-label="Drag to resize the sidebar, click to fold it"
            onPointerDown={(event) => {
              pressX.current = event.clientX
            }}
            onClick={(event) => {
              const moved = Math.abs(event.clientX - (pressX.current ?? 0))
              if (moved > 4) return
              toggleSidebar()
            }}
            className="relative z-10 cursor-col-resize after:w-3"
          />

          <ResizablePanel minSize={360}>
            <main className="flex min-h-0 flex-1 flex-col border-t border-divider bg-background">
              {children}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} onAddVault={onAddVault} />
    </SidebarProvider>
  )
}
