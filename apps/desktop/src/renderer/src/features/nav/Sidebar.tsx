/**
 * The open sidebar's own parts, top to bottom (docs/features/sidebar.md):
 *
 * - `ModeToggle` (its own file): Documents or Agents.
 * - `SidebarSearch`: a field that opens the command menu.
 * - `SidebarLinks`: Home and Board (with a new-task +).
 * - `SidebarPinned`: what you pinned from the tree, under its own label;
 *   absent while nothing is pinned.
 * - `SidebarProfile` (after ReUI's app-shell nav-user): who is signed in, with
 *   Settings, the theme, sync and the version, and Sign out.
 *
 * Home's state is the nav items' (`useNavItems`). Sync, the version and an
 * update live in the profile's menu; every other place is in the palette.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  CalendarDays,
  ChevronsUpDown,
  CircleArrowUp,
  CircleCheck,
  Palette,
  ExternalLink,
  File,
  Folder,
  House,
  Plus,
  Search,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  X,
} from 'lucide-react'
import { forwardRef, type ComponentProps, type ReactNode } from 'react'
import type { ColorScheme } from '@holi/shared'
import { SectionLabel } from '@/composites'
import { pathLabel } from '@/composites/file-icons'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  ICON_MOTION,
  Kbd,
  ICON_TONE,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
} from '@/primitives'
import { cn } from '@/lib/cn'
import { colorSchemeAtom, writeColorSchemeAtom } from '@/state/color-scheme'
import { openTodaysDailyAtom, todayDailyPathAtom } from '@/state/daily'
import { activeTab, openSurface, workspaceAtom } from '@/state/panes'
import { pinsAtom, togglePinAtom } from '@/state/pins'
import { sessionAtom } from '@/state/session'
import { vaultSettingsAtom } from '@/state/settings'
import { openSettingsSectionAtom } from '@/state/settings-section'
import { openPathAtom } from '@/state/surfaces'
import { openPaletteAtom } from '@/state/palette'
import { openQuickAddInColumnAtom } from '@/state/tasks'
import { syncLabel } from '@/lib/sync-label'
import { updateStatusAtom } from '@/state/updates'
import { snapshotAtom, syncStateAtom } from '@/state/vaults'
import { useNavItems } from './NavMenu'
import { useSyncItem } from './SyncItem'
import { useUpdateItem } from './UpdateItem'
import type { NavItem } from './nav-item'

/** One row (after Linear's and Notion's): a 14px icon and a 13px medium
 *  label (`text-nav`), muted until hovered or current. The press shows on
 *  pointer-down (`active:`), not on release. */
const ROW =
  'h-7 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-nav font-medium text-muted-foreground motion-respond hover:bg-foreground/[0.04] hover:text-foreground active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06] aria-[current=page]:text-foreground'

function NavRow({
  item,
  active,
  onClick,
  end,
}: {
  item: Pick<NavItem, 'icon' | 'tone' | 'motion'> & { label: string }
  active?: boolean
  onClick?: () => void
  end?: ReactNode
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      className={ROW}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon
        icon={item.icon}
        size="sm"
        className={cn(
          item.tone !== undefined && ICON_TONE[item.tone],
          item.motion !== undefined && ICON_MOTION[item.motion],
        )}
      />
      <span className="min-w-0 flex-1 truncate text-start">{item.label}</span>
      {end}
    </Button>
  )
}

/**
 * The sidebar's destinations, under the search field and above the files
 * (docs/features/sidebar.md):
 *
 * - **Home** always opens Home, the vault's library. The vault's "Home is"
 *   setting decides what a vault opens on, not where this row goes: a row
 *   named Home that opened the board read as a broken link.
 * - **Board**, with its open-task count; under the pointer the count gives way
 *   to a + that opens the board and starts a task in Todo.
 */
export function SidebarLinks(): React.JSX.Element {
  const { items, activeId } = useNavItems()
  const setWorkspace = useSetAtom(workspaceAtom)
  const newTaskIn = useSetAtom(openQuickAddInColumnAtom)
  const board = items.find((i) => i.id === 'board')
  const openBoard = () => setWorkspace((w) => openSurface(w, 'board'))
  return (
    <nav aria-label="Go to" className="flex flex-col gap-0.5">
      <NavRow
        item={{ icon: House, label: 'Home' }}
        active={activeId === 'home'}
        onClick={() => setWorkspace((w) => openSurface(w, 'home'))}
      />
      {board !== undefined && (
        // Two controls side by side, not one inside the other: a button in a
        // button is invalid, and the + must be its own tab stop.
        <div className="group/board relative">
          <NavRow
            item={{ icon: board.icon, label: 'Board' }}
            active={activeId === 'board'}
            onClick={openBoard}
            end={
              board.badge !== undefined && board.badge > 0 ? (
                <span
                  className={cn(
                    'text-xs tabular-nums group-focus-within/board:opacity-0 group-hover/board:opacity-0',
                    board.badgeTone === 'alert' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {board.badge}
                </span>
              ) : undefined
            }
          />
          <IconButton
            icon={Plus}
            label="New task"
            size="sm"
            className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 group-focus-within/board:opacity-100 group-hover/board:opacity-100"
            onClick={() => {
              openBoard()
              newTaskIn('todo')
            }}
          />
        </div>
      )}
    </nav>
  )
}

/**
 * Search, as a field at the top of the Documents side (after the knowledge
 * bases that lead with one): a press opens the command menu (⌘P), where the
 * typing happens, so there is one search and not two. A grey fill, as every
 * text field is (docs/ui-system.md, Rules).
 */
export function SidebarSearch(): React.JSX.Element {
  const openPalette = useSetAtom(openPaletteAtom)
  return (
    <Button
      variant="ghost"
      className={cn(ROW, 'h-8 bg-foreground/[0.04] font-normal hover:bg-foreground/[0.07]')}
      onClick={() => openPalette('open')}
    >
      <Icon icon={Search} size="sm" />
      <span className="min-w-0 flex-1 truncate text-start">Search</span>
      <Kbd>⌘P</Kbd>
    </Button>
  )
}

export function SidebarPinned(): React.JSX.Element | null {
  const pins = useAtomValue(pinsAtom)
  const dirs = useAtomValue(snapshotAtom).dirs
  const tab = activeTab(useAtomValue(workspaceAtom))
  const openPath = useSetAtom(openPathAtom)
  const unpin = useSetAtom(togglePinAtom)
  if (pins.length === 0) return null
  return (
    <section aria-label="Pinned" className="flex flex-col">
      <SectionLabel>Pinned</SectionLabel>
      <div className="flex flex-col gap-px">
        {pins.map((path) => {
          const folder = dirs.includes(path)
          return (
            <div key={path} className="group/pin relative">
              <NavRow
                item={{ icon: folder ? Folder : File, label: pathLabel(path) }}
                active={tab?.kind === 'note' && tab.path === path}
                onClick={() => openPath(path, 'pinned')}
              />
              <IconButton
                icon={X}
                label={`Unpin ${pathLabel(path)}`}
                className="absolute end-1 top-0.5 opacity-0 group-hover/pin:opacity-100 focus-visible:opacity-100"
                onClick={() => unpin(path)}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

const THEMES: { value: ColorScheme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
]

const profileUrl = (login: string) => `https://github.com/${login}`

/** The signed-in person's picture, or their initial while it loads or is
 *  missing. */
function Avatar({ url, name }: { url?: string; name: string }) {
  return url ? (
    <img src={url} alt="" className="size-6 shrink-0 rounded-full" />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

/** Light, dark or system as three icons. Out of the Tab order: arrow keys
 *  move it while its menu row has focus. */
function ThemeToggle({
  scheme,
  onPick,
}: {
  scheme: ColorScheme
  onPick: (scheme: ColorScheme) => void
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0.5}
      aria-label="Theme"
      value={scheme}
      rovingFocus={false}
      onValueChange={(next) => next !== '' && onPick(next as ColorScheme)}
    >
      {THEMES.map((t) => (
        <Tooltip key={t.value} content={t.label}>
          <ToggleGroupItem value={t.value} aria-label={t.label} tabIndex={-1}>
            <Icon icon={t.icon} size="sm" />
          </ToggleGroupItem>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}

/** The profile menu's rows: the sidebar's size, not the app's menus' (ReUI's
 *  nav-user is a compact menu). */
const MENU_ROW = 'min-h-7 rounded-md px-2 py-1 text-nav'

/**
 * Who is signed in, and the machine's state (after ReUI's app-shell nav-user).
 * The trigger is the avatar, the name and the handle, with a mark on the
 * avatar while something wants you (an update, a sync that needs a hand).
 * The menu: Settings, the GitHub profile, the theme, one row for sync and the
 * running version (opening the sync panel, and the update's when there is
 * one), and Sign out, which goes to Settings' Account, where its dialog asks
 * about the clones on disk.
 */
export function SidebarProfile({
  compact = false,
}: {
  /** The rail's: the avatar alone, the menu the same. */
  compact?: boolean
} = {}): React.JSX.Element | null {
  const session = useAtomValue(sessionAtom)
  const scheme = useAtomValue(colorSchemeAtom)
  const writeScheme = useSetAtom(writeColorSchemeAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const openSection = useSetAtom(openSettingsSectionAtom)
  const sync = useSyncItem()
  const update = useUpdateItem()
  const syncState = useAtomValue(syncStateAtom)
  const version = useAtomValue(updateStatusAtom)?.version
  if (!session) return null
  const name = session.name ?? session.login
  // Something wants a hand: an update, or a sync that is not quietly fine.
  const wants = update !== null || (sync.tone !== undefined && sync.tone !== 'busy')
  const cycle = (step: number) => {
    const at = THEMES.findIndex((t) => t.value === scheme)
    void writeScheme(THEMES[(at + step + THEMES.length) % THEMES.length]!.value)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${name}, account and app${wants ? ', needs attention' : ''}`}
        className={cn(
          'flex h-9 min-w-0 items-center gap-2 rounded-lg text-start outline-none motion-respond hover:bg-foreground/[0.04] active:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.06]',
          compact ? 'w-9 justify-center' : 'w-full px-2',
        )}
      >
        <span className="relative shrink-0">
          <Avatar url={session.avatarUrl} name={name} />
          {wants && (
            <span
              aria-hidden="true"
              className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-ground"
            />
          )}
        </span>
        {!compact && (
          <>
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate text-nav font-medium text-foreground">{name}</span>
              <span className="truncate text-xs text-muted-foreground">@{session.login}</span>
            </span>
            <Icon icon={ChevronsUpDown} size="sm" tone="muted" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        // ReUI's size, not the trigger's: the menu still grows out of the
        // trigger, but no longer as wide as the sidebar.
        style={{ minWidth: 0 }}
        className="w-56"
      >
        <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5">
          <Avatar url={session.avatarUrl} name={name} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-nav font-semibold text-foreground">{name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              @{session.login}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            className={MENU_ROW}
            onSelect={() => setWorkspace((w) => openSurface(w, 'settings'))}
          >
            <Icon icon={Settings} size="sm" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ROW}
            onSelect={() => void window.holi.openExternal(profileUrl(session.login))}
          >
            <Icon icon={ExternalLink} size="sm" />
            GitHub profile
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* The pill sets the theme in place, so the menu outlives the click. */}
        <DropdownMenuItem
          className={cn(MENU_ROW, 'cursor-default focus:bg-transparent')}
          onSelect={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              cycle(e.key === 'ArrowRight' ? 1 : -1)
            }
          }}
        >
          <Icon icon={Palette} size="sm" />
          <span className="flex-1">Theme</span>
          <ThemeToggle scheme={scheme} onPick={(v) => void writeScheme(v)} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Sync and the version are one row: the machine's state at a glance.
            It opens the sync panel, and the update's when there is one. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={cn(MENU_ROW, 'gap-2')}>
            <Icon
              icon={sync.icon}
              size="sm"
              className={cn(
                sync.tone !== undefined && ICON_TONE[sync.tone],
                sync.motion !== undefined && ICON_MOTION[sync.motion],
              )}
            />
            <span className="flex-1 truncate">{capital(syncLabel(syncState).text)}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              {version ? `v${version}` : 'Holi'}
              {update !== null ? (
                <Icon
                  icon={CircleArrowUp}
                  size="sm"
                  className={update.tone !== undefined ? ICON_TONE[update.tone] : undefined}
                  aria-label={update.label}
                />
              ) : (
                <Icon icon={CircleCheck} size="sm" aria-label="Holi is up to date" />
              )}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-auto p-0">
            {update?.panel?.(() => undefined, true)}
            {sync.panel?.(() => undefined, true)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem className={MENU_ROW} onSelect={() => openSection('account')}>
          <Icon icon={LogOut} size="sm" />
          Sign out…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
