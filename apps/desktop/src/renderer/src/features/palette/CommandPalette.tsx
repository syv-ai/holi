/**
 * The command palette (D102): ⌘P quick-opens every openable thing, `>`
 * switches the same box to commands, ⌘⇧P opens there. VS Code's shape.
 *
 * Thin on purpose. What is listed and in what order is `lib/palette-rows.ts`,
 * pure and node-tested; cmdk runs with `shouldFilter={false}` and renders
 * what it is given. What a command does is its row in `state/commands.ts`.
 * The component owns only the choosing: **it closes first, then acts**, so
 * cmdk's close-on-select under a controlled `open` is never relied on, and a
 * chosen action that opens a tab never fights the palette for focus.
 *
 * ⌘↵ opens beside rather than in the focused pane. cmdk's `onSelect` carries
 * no event, so the root's keydown notes the modifier a moment before the
 * select fires — cmdk calls the root's own handler first.
 *
 * The last row, once anything is typed outside `>` mode, asks the assistant:
 * the text goes to the session ⌘J goes to and lands unsent in its input
 * (D100), starting a session when there is none.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  AppWindow,
  Calendar,
  CalendarDays,
  File,
  FileText,
  History,
  Kanban,
  Mail,
  Settings,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { cn } from '@/lib/cn'
import {
  buildRows,
  commandQuery,
  rankCommands,
  rankRows,
  type PaletteRow,
  type RankedRow,
  type RowIcon,
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
import { activeSessionIdAtom, agentSessionsAtom, defaultAgentTargetAtom } from '@/state/agent'
import { sendToAgentAtom } from '@/state/agent-send'
import { appIdsAtom } from '@/state/apps'
import { commandsAtom, runCommandAtom, type Command } from '@/state/commands'
import { closePaletteAtom, paletteAtom, setPaletteQueryAtom } from '@/state/palette'
import {
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

const GLYPHS = {
  note: FileText,
  daily: CalendarDays,
  file: File,
  app: AppWindow,
  session: Terminal,
  board: Kanban,
  agenda: Calendar,
  mail: Mail,
  settings: Settings,
  history: History,
} as const

function RowIconView({ icon }: { icon: RowIcon }): React.JSX.Element {
  if ('emoji' in icon) return <span className="w-4 text-center leading-none">{icon.emoji}</span>
  const Glyph = GLYPHS[icon.glyph]
  return <Glyph />
}

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
  const close = useSetAtom(closePaletteAtom)
  const store = useStore()
  const snapshot = useAtomValue(snapshotAtom)
  const appIds = useAtomValue(appIdsAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const recents = useAtomValue(recentsAtom)
  const commands = useAtomValue(commandsAtom)
  const run = useSetAtom(runCommandAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const setActiveSession = useSetAtom(activeSessionIdAtom)
  const askTarget = useAtomValue(defaultAgentTargetAtom)
  const sendToAgent = useSetAtom(sendToAgentAtom)

  const rows = useMemo(
    () => buildRows({ snapshot, appIds, sessions }),
    [snapshot, appIds, sessions],
  )
  const query = state.query
  const cmdQuery = commandQuery(query)
  const ranked = useMemo(
    () => (cmdQuery === null ? rankRows(rows, query, recents) : []),
    [cmdQuery, rows, query, recents],
  )
  const rankedCommands = useMemo(
    () =>
      cmdQuery === null
        ? []
        : rankCommands(
            commands.filter((c) => c.when === undefined || c.when(store.get)),
            cmdQuery,
            recents,
          ),
    [cmdQuery, commands, recents, store],
  )

  // ⌘P while open: the selection moves down, as VS Code's does. cmdk moves it
  // on an ArrowDown keydown reaching its root, so one is dispatched from the
  // input, which is inside it.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!state.open || state.step === 0) return
    inputRef.current?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
  }, [state.open, state.step])

  const beside = useRef(false)

  const chooseRow = (row: PaletteRow): void => {
    const openBesideIt = beside.current
    beside.current = false
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
    close()
    void run(command.id)
  }

  const ask = (): void => {
    const text = query.trim()
    close()
    void sendToAgent({ text, target: askTarget })
  }

  const showAsk = cmdQuery === null && query.trim() !== ''
  const untyped = query.trim() === ''

  return (
    <CommandDialog
      open={state.open}
      shouldFilter={false}
      onOpenChange={(open) => {
        if (!open) close()
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
          placeholder={cmdQuery === null ? 'Open anything, > for commands' : 'Run a command'}
        />
        <CommandList>
          <CommandEmpty>Nothing matches</CommandEmpty>
          {cmdQuery === null ? (
            <>
              <RowGroup
                heading={untyped ? 'Recently opened' : undefined}
                rows={ranked.filter((r) => untyped && r.recent)}
                onChoose={chooseRow}
              />
              <RowGroup
                heading={untyped ? 'Recently modified' : undefined}
                rows={ranked.filter((r) => !(untyped && r.recent))}
                onChoose={chooseRow}
              />
              {showAsk && (
                <CommandGroup forceMount>
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

function RowGroup({
  heading,
  rows,
  onChoose,
}: {
  heading: string | undefined
  rows: RankedRow[]
  onChoose: (row: PaletteRow) => void
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
          <RowIconView icon={row.icon} />
          <span className="truncate">{row.name}</span>
          {row.detail !== undefined && (
            <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
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
