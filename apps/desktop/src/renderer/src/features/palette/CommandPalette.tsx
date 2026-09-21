/**
 * The command palette (D102): ⌘P quick-opens every openable thing, `>`
 * switches the same box to commands, ⌘⇧P opens there, and ⌃⇥ is the tab
 * switcher. VS Code's shape.
 *
 * Thin on purpose. What is listed and in what order is `lib/palette-rows.ts`,
 * pure and node-tested; cmdk runs with `shouldFilter={false}` and renders
 * what it is given. What a command does is its row in `state/commands.ts`.
 * The component owns only the choosing: **it closes first, then acts**, so
 * cmdk's close-on-select under a controlled `open` is never relied on, and a
 * chosen action that opens a tab never fights the palette for focus.
 *
 * ⌘↵ opens beside rather than in the focused pane. cmdk's `onSelect` carries
 * no event, so a capture-phase keydown on a wrapper inside cmdk's root notes
 * the modifier; React runs it before the root's own handler selects.
 *
 * Focus returns to where it was, by Radix, except when the chosen row moved
 * it on purpose: a session tab or the Ask row focuses a terminal, and Radix
 * pulling it back to the old editor a tick later would undo that.
 *
 * **⌃⇥ is a chord, not a command.** It opens the palette over the open tabs,
 * most recently used first with the current one left out, so the first row is
 * the previous tab; each further ⇥ moves down (⇧⇥ up); releasing ⌃ takes the
 * selected one. It lives here rather than in the command table because the
 * table binds keydowns, and this one is finished by a keyup. It is also the
 * one binding that means the literal Control key on every platform.
 *
 * The last row, once anything is typed outside `>` mode, asks the assistant:
 * the text goes to the session ⌘J goes to and lands unsent in its input
 * (D100), starting a session when there is none.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { AppWindow, Calendar, History, Kanban, Mail, Settings, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { fileIconFor } from '@/composites/file-icons'
import { agentIndicator, agentThemeNote } from '@/lib/agent-notices'
import { cn } from '@/lib/cn'
import {
  buildRows,
  commandQuery,
  openTabRows,
  rankCommands,
  rankRows,
  type PaletteRow,
  type RankedRow,
} from '@/lib/palette-rows'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Kbd,
} from '@/primitives'
import {
  activeSessionIdAtom,
  agentModeAtSpawnAtom,
  agentSessionsAtom,
  defaultAgentTargetAtom,
} from '@/state/agent'
import { sendToAgentAtom } from '@/state/agent-send'
import { appIdsAtom } from '@/state/apps'
import { activeModeAtom } from '@/state/color-scheme'
import { commandsAtom, runCommandAtom, type Command } from '@/state/commands'
import {
  closePaletteAtom,
  openPaletteAtom,
  paletteAtom,
  setPaletteQueryAtom,
  stepPaletteBackAtom,
} from '@/state/palette'
import {
  activeTab,
  openApp,
  openBeside,
  openInNewPane,
  openPinned,
  openSession,
  openSingleton,
  workspaceAtom,
  type SingletonTab,
  type Tab,
} from '@/state/panes'
import { recentsAtom } from '@/state/recents'
import { snapshotAtom } from '@/state/vaults'

const SURFACE_GLYPHS = {
  board: Kanban,
  agenda: Calendar,
  mail: Mail,
  settings: Settings,
  history: History,
} as const

/** The tab a row opens as, for the "beside" gesture. */
function tabOf(row: PaletteRow): Tab {
  switch (row.kind) {
    case 'path':
      return { kind: 'note', path: row.key }
    case 'app':
      return { kind: 'app', appId: row.key }
    case 'session':
      return { kind: 'session', id: row.key }
    case 'surface':
      return { kind: row.key as SingletonTab }
  }
}

const rowValue = (row: PaletteRow): string => `${row.kind}:${row.key}`

export function CommandPalette(): React.JSX.Element {
  const state = useAtomValue(paletteAtom)
  const setQuery = useSetAtom(setPaletteQueryAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const stepBack = useSetAtom(stepPaletteBackAtom)
  const close = useSetAtom(closePaletteAtom)
  const store = useStore()
  const snapshot = useAtomValue(snapshotAtom)
  const appIds = useAtomValue(appIdsAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const modeAtSpawn = useAtomValue(agentModeAtSpawnAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const recents = useAtomValue(recentsAtom)
  const commands = useAtomValue(commandsAtom)
  const workspace = useAtomValue(workspaceAtom)
  const run = useSetAtom(runCommandAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const setActiveSession = useSetAtom(activeSessionIdAtom)
  const askTarget = useAtomValue(defaultAgentTargetAtom)
  const sendToAgent = useSetAtom(sendToAgentAtom)

  const rows = useMemo(
    () => buildRows({ snapshot, appIds, sessions }),
    [snapshot, appIds, sessions],
  )
  const tabsMode = state.mode === 'tabs'
  const query = state.query
  const cmdQuery = tabsMode ? null : commandQuery(query)
  const ranked = useMemo((): RankedRow[] => {
    if (tabsMode) {
      const open = openTabRows(
        rows,
        workspace.panes.flatMap((p) => p.tabs),
        activeTab(workspace),
        recents,
      )
      return query.trim() === '' ? open : rankRows(open, query, [])
    }
    return cmdQuery === null ? rankRows(rows, query, recents) : []
  }, [tabsMode, cmdQuery, rows, query, recents, workspace])
  const rankedCommands = useMemo(
    () =>
      cmdQuery === null
        ? []
        : rankCommands(
            commands.filter(
              (c) => c.hidden === undefined && (c.when === undefined || c.when(store.get)),
            ),
            cmdQuery,
            recents,
          ),
    [cmdQuery, commands, recents, store],
  )

  // ⌘P or ⌃⇥ while open: the selection moves, as VS Code's does. cmdk moves
  // it on an arrow keydown reaching its root, so one is dispatched from the
  // input, which is inside it.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!state.open || state.step === 0) return
    inputRef.current?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: state.stepDirection === 1 ? 'ArrowDown' : 'ArrowUp',
        bubbles: true,
      }),
    )
  }, [state.open, state.step, state.stepDirection])

  // ⌃⇥ / ⇧⌃⇥ open the switcher or step it; releasing ⌃ takes the selection.
  // Capture phase, so the focus trap never sees the ⇥.
  const tabsModeRef = useRef(false)
  tabsModeRef.current = state.open && tabsMode
  /** Nothing to switch to: one tab, or none. The chord then does nothing
   *  rather than opening an empty list. */
  const lonelyRef = useRef(true)
  lonelyRef.current = workspace.panes.reduce((n, p) => n + p.tabs.length, 0) < 2
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.metaKey || e.altKey) return
      if (!tabsModeRef.current && lonelyRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (!tabsModeRef.current) {
        openPalette('tabs')
        return
      }
      if (e.shiftKey) stepBack()
      else openPalette('tabs')
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Control' || !tabsModeRef.current) return
      // The selected row, or the first one when ⌃ was released before cmdk
      // had selected anything (one ⌃⇥ and straight off it is the common case).
      // A click rather than an Enter: cmdk's Enter needs a selection to exist.
      const root = inputRef.current?.closest('[cmdk-root]')
      const item =
        root?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]') ??
        root?.querySelector<HTMLElement>('[cmdk-item]')
      if (item) item.click()
      else close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [openPalette, stepBack, close])

  const beside = useRef(false)
  /** The chosen row focused something itself; Radix must not refocus. */
  const keepFocus = useRef(false)

  const chooseRow = (row: PaletteRow): void => {
    const openBesideIt = beside.current
    beside.current = false
    keepFocus.current = row.kind === 'session'
    close()
    if (row.kind === 'session') setActiveSession(row.key)
    setWorkspace((w) => {
      if (openBesideIt) {
        return row.kind === 'path' ? openBeside(w, w.active, row.key) : openInNewPane(w, tabOf(row))
      }
      switch (row.kind) {
        case 'path':
          return openPinned(w, row.key)
        case 'app':
          return openApp(w, row.key)
        case 'session':
          return openSession(w, row.key)
        case 'surface':
          return openSingleton(w, row.key as SingletonTab)
      }
    })
  }

  const chooseCommand = (command: Command): void => {
    beside.current = false
    close()
    void run(command.id)
  }

  const ask = (): void => {
    const text = query.trim()
    beside.current = false
    keepFocus.current = true
    close()
    void sendToAgent({ text, target: askTarget })
  }

  /** The sidebar's orb for a session row, from the same rule the cards use. */
  const orbFor = (id: string): string => {
    const session = sessions.find((s) => s.id === id)
    if (session === undefined) return 'bg-muted-foreground'
    return agentIndicator({
      ...session,
      themeNote: agentThemeNote({
        running: !session.exited,
        modeAtSpawn: modeAtSpawn[session.id] ?? null,
        mode: colorMode,
      }),
    }).dot
  }

  const showAsk = cmdQuery === null && !tabsMode && query.trim() !== ''
  const grouped = query.trim() === '' && !tabsMode
  const placeholder = tabsMode
    ? 'Switch to an open tab'
    : cmdQuery === null
      ? 'Open anything, > for commands'
      : 'Run a command'

  return (
    <CommandDialog
      open={state.open}
      shouldFilter={false}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      onCloseAutoFocus={(e) => {
        if (!keepFocus.current) return
        keepFocus.current = false
        e.preventDefault()
      }}
    >
      <div
        onKeyDownCapture={(e) => {
          beside.current = e.key === 'Enter' && (e.metaKey || e.ctrlKey)
        }}
      >
        <CommandInput
          ref={inputRef}
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={placeholder}
        />
        <CommandList>
          <CommandEmpty>Nothing matches</CommandEmpty>
          {cmdQuery === null ? (
            <>
              <RowGroup
                heading={grouped ? 'Recently opened' : undefined}
                rows={ranked.filter((r) => grouped && r.recent)}
                onChoose={chooseRow}
                orbFor={orbFor}
              />
              <RowGroup
                heading={grouped ? 'Recently modified' : undefined}
                rows={ranked.filter((r) => !(grouped && r.recent))}
                onChoose={chooseRow}
                orbFor={orbFor}
              />
              {showAsk && (
                <CommandGroup>
                  <CommandItem value={`ask:${query}`} onSelect={ask}>
                    <Sparkles />
                    <span className="truncate">Ask the assistant: {query.trim()}</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </>
          ) : (
            <>
              <CommandGroup heading={untypedCommand(cmdQuery) ? 'Recently used' : undefined}>
                {rankedCommands
                  .filter((r) => untypedCommand(cmdQuery) && r.recent)
                  .map((r) => (
                    <CommandRow key={r.command.id} command={r.command} onChoose={chooseCommand} />
                  ))}
              </CommandGroup>
              <CommandGroup heading={untypedCommand(cmdQuery) ? 'Other commands' : undefined}>
                {rankedCommands
                  .filter((r) => !(untypedCommand(cmdQuery) && r.recent))
                  .map((r) => (
                    <CommandRow key={r.command.id} command={r.command} onChoose={chooseCommand} />
                  ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </div>
    </CommandDialog>
  )
}

const untypedCommand = (cmdQuery: string): boolean => cmdQuery.trim() === ''

/**
 * A row's icon, in the colours the tree uses: a path gets its type glyph (or
 * the vault's emoji for it), a session its status orb, an app the app glyph,
 * a surface its own. The tree's tint is the muted foreground, which the item
 * already gives an untinted svg.
 */
function RowIconView({ row, orb }: { row: PaletteRow; orb?: string }): React.JSX.Element {
  switch (row.kind) {
    case 'path':
      return (
        <span className="flex w-4 shrink-0 justify-center">
          {fileIconFor(row.key, 'emoji' in row.icon ? row.icon.emoji : undefined)}
        </span>
      )
    case 'session':
      return (
        <span className="flex w-4 shrink-0 justify-center">
          <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', orb)} />
        </span>
      )
    case 'app':
      return <AppWindow />
    case 'surface': {
      const Glyph = SURFACE_GLYPHS[row.key as keyof typeof SURFACE_GLYPHS]
      return <Glyph />
    }
  }
}

function RowGroup({
  heading,
  rows,
  onChoose,
  orbFor,
}: {
  heading: string | undefined
  rows: RankedRow[]
  onChoose: (row: PaletteRow) => void
  orbFor: (sessionId: string) => string
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <CommandGroup heading={heading}>
      {rows.map((row) => (
        <CommandItem
          key={rowValue(row)}
          value={rowValue(row)}
          onSelect={() => onChoose(row)}
          className={cn(row.dim && 'opacity-60')}
        >
          <RowIconView row={row} orb={row.kind === 'session' ? orbFor(row.key) : undefined} />
          <span className="truncate">{row.name}</span>
          {row.detail !== undefined && (
            <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
              {row.detail}
            </span>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

function CommandRow({
  command,
  onChoose,
}: {
  command: Command
  onChoose: (command: Command) => void
}): React.JSX.Element {
  return (
    <CommandItem value={`command:${command.id}`} onSelect={() => onChoose(command)}>
      <span className="truncate">{command.label}</span>
      {command.hotkey !== undefined && (
        <CommandShortcut>
          <Kbd>{command.hotkey}</Kbd>
        </CommandShortcut>
      )}
    </CommandItem>
  )
}
