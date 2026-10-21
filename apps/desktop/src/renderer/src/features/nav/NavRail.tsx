/**
 * The sidebar, collapsed (docs/features/sidebar.md): a rail of the places it
 * holds, one icon each, so hiding the sidebar gives the page room without
 * taking the way around away. Top to bottom: the window's lights and the
 * toggle that opens the sidebar again, the two modes, Home, the board and
 * Search, and at the foot who is signed in.
 *
 * The same destinations as the open sidebar's rows, not new ones: Home and
 * the board open their surfaces, Search the command menu, and a mode button
 * switches the mode without opening the sidebar.
 */
import { useAtom, useSetAtom } from 'jotai'
import { Bot, FileText, House, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { IconButton, Kbd } from '@/primitives'
import { appModeAtom } from '@/state/app-mode'
import { openPaletteAtom } from '@/state/palette'
import { openSurface, workspaceAtom } from '@/state/panes'
import { navOpenAtom } from '@/state/preferences'
import { useAgentsMode, useAgentsStatus } from './ModeToggle'
import { useNavItems } from './NavMenu'
import { SidebarProfile } from './Sidebar'

/** The rail's width: the window's lights (14px in, ending near 73px) and the
 *  panel's own 8px margin after them, so they never sit over the panel. Its
 *  CSS twin is the window band's inset (index.css, Window). */
export const RAIL_WIDTH = 80

/** Opens or hides the sidebar, beside the window's lights (or, on the rail,
 *  under them). ⌘B does the same. */
export function SidebarToggle(): React.JSX.Element {
  const [open, setOpen] = useAtom(navOpenAtom)
  return (
    <IconButton
      icon={open ? PanelLeftClose : PanelLeftOpen}
      label={open ? 'Hide sidebar' : 'Show sidebar'}
      tooltip={
        <span className="flex items-center gap-2">
          {open ? 'Hide sidebar' : 'Show sidebar'}
          <Kbd>⌘B</Kbd>
        </span>
      }
      size="md"
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
    />
  )
}

export function NavRail(): React.JSX.Element {
  const agents = useAgentsMode()
  const status = useAgentsStatus()
  const [mode, setMode] = useAtom(appModeAtom)
  const { items, activeId } = useNavItems()
  const setWorkspace = useSetAtom(workspaceAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const board = items.find((i) => i.id === 'board')
  const documents = agents === undefined || mode === 'documents'
  return (
    <div className="flex h-full w-full flex-col items-center gap-4 pb-2">
      <div data-window-band="rail" className="app-drag h-10 w-full shrink-0" />
      <SidebarToggle />
      {agents !== undefined && (
        <nav aria-label="Mode" className="flex flex-col items-center gap-1">
          <IconButton
            icon={FileText}
            label="Documents"
            size="md"
            tooltipSide="right"
            active={mode === 'documents'}
            aria-current={mode === 'documents' ? 'page' : undefined}
            onClick={() => setMode('documents')}
          />
          <IconButton
            icon={Bot}
            label={
              status.needsYou > 0
                ? `Agents, ${status.needsYou} need${status.needsYou === 1 ? 's' : ''} you`
                : 'Agents'
            }
            size="md"
            tooltipSide="right"
            active={mode === 'agents'}
            aria-current={mode === 'agents' ? 'page' : undefined}
            onClick={() => setMode('agents')}
          >
            {status.needsYou > 0 && (
              <span
                aria-hidden="true"
                className="absolute end-1 top-1 size-2 rounded-full bg-amber-600 ring-2 ring-ground dark:bg-amber-400"
              />
            )}
          </IconButton>
        </nav>
      )}
      <nav aria-label="Go to" className="flex flex-col items-center gap-1">
        <IconButton
          icon={House}
          label="Home"
          size="md"
          tooltipSide="right"
          active={documents && activeId === 'home'}
          onClick={() => {
            setMode('documents')
            setWorkspace((w) => openSurface(w, 'home'))
          }}
        />
        {board !== undefined && (
          <IconButton
            icon={board.icon}
            label={board.badge ? `Board, ${board.badge} open` : 'Board'}
            size="md"
            tooltipSide="right"
            active={documents && activeId === 'board'}
            onClick={() => {
              setMode('documents')
              setWorkspace((w) => openSurface(w, 'board'))
            }}
          />
        )}
        <IconButton
          icon={Search}
          label="Search"
          tooltip={
            <span className="flex items-center gap-2">
              Search
              <Kbd>⌘P</Kbd>
            </span>
          }
          size="md"
          tooltipSide="right"
          onClick={() => openPalette('open')}
        />
      </nav>
      <div className="mt-auto">
        <SidebarProfile compact />
      </div>
    </div>
  )
}
