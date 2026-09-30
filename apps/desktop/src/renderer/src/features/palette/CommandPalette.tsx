/**
 * The command palette: ⌘P quick-opens every openable thing, `>`
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
 * Once two characters are typed, the notes whose text holds them follow the
 * name matches, after a short pause and only for the query still in the box.
 *
 * The last row, once anything is typed outside `>` mode, asks the assistant:
 * the text goes to the session ⌘J goes to and lands unsent in its input,
 * starting a session when there is none.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { AppWindow, Bot, Calendar, History, Kanban, Mail, Settings, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fileIconFor } from '@/composites/file-icons'
import { agentIndicator } from '@/lib/agent-notices'
import { cn } from '@/lib/cn'
import {
  bodyRows,
  buildRows,
  commandQuery,
  openTabRows,
  rankCommands,
  rankRows,
  type PaletteRow,
  type RankedRow,
} from '@/lib/palette-rows'
import { trpc } from '@/lib/trpc'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Icon,
  Kbd,
} from '@/primitives'
import {
  agentSessionsAtom,
  agentTerminalsAtom,
  defaultAgentTargetAtom,
  terminalLabel,
} from '@/state/agent'
import { openSessionAtom, sendToAgentAtom } from '@/state/agent-send'
import { appPathsAtom } from '@/state/apps'
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
  openAgentTab,
  openPinned,
  openSingleton,
  workspaceAtom,
  type SingletonTab,
  type Tab,
} from '@/state/panes'
import { recentsAtom } from '@/state/recents'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

const SURFACE_GLYPHS = {
  board: Kanban,
  agenda: Calendar,
  mail: Mail,
  settings: Settings,
  history: History,
} as const

/** The tab a row opens as, for the "beside" gesture. Null for a session: it
 *  opens through a terminal main has to start (`openSessionAtom`). */
function tabOf(row: PaletteRow): Tab | null {
  switch (row.kind) {
    case 'path':
      return { kind: 'note', path: row.key }
    case 'app':
      return { kind: 'app', path: row.key }
    case 'terminal':
      return { kind: 'agent', id: row.key }
    case 'session':
      return null
    case 'surface':
      return { kind: row.key as SingletonTab }
  }
}

const rowValue = (row: PaletteRow): string => `${row.kind}:${row.key}`

type BodyHit = { path: string; snippet?: string }

/** Below this, a text search matches nearly every note and reads them all. */
const BODY_MIN = 2
const BODY_DEBOUNCE_MS = 150

/**
 * Main's text matches for `query`, once typing pauses. An answer for a query
 * that is no longer in the box is dropped, both on its way in and on its way
 * out, so a slow search never paints over a newer one.
 */
function useBodyHits(remote: string | null, query: string, enabled: boolean): BodyHit[] {
  const [found, setFound] = useState<{ remote: string; q: string; hits: BodyHit[] }>({
    remote: '',
    q: '',
    hits: [],
  })
  const q = query.trim()
  const on = enabled && remote !== null && q.length >= BODY_MIN
  useEffect(() => {
    if (!on || remote === null) return
    let live = true
    const timer = setTimeout(() => {
      trpc.notes.search.query({ remote, q }).then(
        (hits) => {
          if (live) setFound({ remote, q, hits })
        },
        () => {},
      )
    }, BODY_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [on, remote, q])
  // Keyed by vault too: after a switch, the old vault's hits are not this one's.
  return on && found.remote === remote && found.q === q ? found.hits : []
}

export function CommandPalette(): React.JSX.Element {
  const state = useAtomValue(paletteAtom)
  const setQuery = useSetAtom(setPaletteQueryAtom)
  const openPalette = useSetAtom(openPaletteAtom)
  const stepBack = useSetAtom(stepPaletteBackAtom)
  const close = useSetAtom(closePaletteAtom)
  const store = useStore()
  const snapshot = useAtomValue(snapshotAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const appPaths = useAtomValue(appPathsAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const terminals = useAtomValue(agentTerminalsAtom)
  const recents = useAtomValue(recentsAtom)
  const commands = useAtomValue(commandsAtom)
  const workspace = useAtomValue(workspaceAtom)
  const run = useSetAtom(runCommandAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const openSession = useSetAtom(openSessionAtom)
  const askTarget = useAtomValue(defaultAgentTargetAtom)
  const sendToAgent = useSetAtom(sendToAgentAtom)

  const rows = useMemo(
    () =>
      buildRows({
        snapshot,
        appPaths,
        sessions,
        terminals: terminals.map((t) => ({ id: t.id, label: terminalLabel(t, sessions) })),
      }),
    [snapshot, appPaths, sessions, terminals],
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
  const hits = useBodyHits(remote, query, state.open && !tabsMode && cmdQuery === null)
  const textRows = useMemo(() => bodyRows(rows, ranked, hits), [rows, ranked, hits])
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
    keepFocus.current = row.kind === 'session' || row.kind === 'terminal'
    close()
    if (row.kind === 'session') {
      void openSession(row.key)
      return
    }
    setWorkspace((w) => {
      if (openBesideIt) {
        if (row.kind === 'path') return openBeside(w, w.active, row.key)
        const tab = tabOf(row)
        return tab === null ? w : openInNewPane(w, tab)
      }
      switch (row.kind) {
        case 'path':
          return openPinned(w, row.key)
        case 'app':
          return openApp(w, row.key)
        case 'terminal':
          return openAgentTab(w, row.key)
        case 'session':
          return w // opened above, through main
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

  /** The sidebar's orb for a session row, from the same rule the rows use. */
  const orbFor = (id: string): string => {
    const session = sessions.find((s) => s.id === id)
    return session === undefined ? 'bg-muted-foreground' : agentIndicator(session).dot
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
              <RowGroup heading="In text" rows={textRows} onChoose={chooseRow} orbFor={orbFor} />
              {showAsk && (
                <CommandGroup>
                  <CommandItem value={`ask:${query}`} onSelect={ask}>
                    <Icon icon={Sparkles} />
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
    case 'terminal':
      return <Icon icon={Bot} />
    case 'app':
      return <Icon icon={AppWindow} />
    case 'surface':
      return <Icon icon={SURFACE_GLYPHS[row.key as keyof typeof SURFACE_GLYPHS]} />
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
          {row.snippet !== undefined ? (
            <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
              {row.snippet}
            </span>
          ) : (
            row.detail !== undefined && (
              <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                {row.detail}
              </span>
            )
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
