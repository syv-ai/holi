import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  CopyIcon,
  EraserIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconButton } from '@/composites/icon-button'
import { PanelHeader } from '@/composites/panel-header'
import { cn } from '@/lib/cn'
import {
  activityEntriesAtom,
  activityQueryAtom,
  activitySearchAtom,
  clearActivityAtom,
  entryText,
  shownEntries,
} from '@/state/activity'
import {
  bottomPanelAtom,
  clampPanelHeight,
  PANEL_DEFAULT_HEIGHT,
  PANEL_MIN_HEIGHT,
  readPanelHeight,
  togglePanelAtom,
  writePanelHeight,
  type PanelTab,
} from '@/state/bottom-panel'
import {
  activePanelTerminalAtom,
  createPanelTerminalAtom,
  killPanelTerminalAtom,
  panelTerminalErrorAtom,
  panelTerminalsAtom,
  terminalLabel,
} from '@/state/panel-terminals'
import {
  appLogEntriesAtom,
  appLogQueryAtom,
  appLogSearchAtom,
  appLogText,
  clearAppLogAtom,
  shownAppLog,
  useAppLog,
} from '@/state/app-logs'
import { useShortcutHandlers } from '@/hooks/use-shortcuts'
import { activeRemoteAtom } from '@/state/vaults'

import { PanelLogs, LogsSearch } from './panel-logs'
import { PanelOutput } from './panel-output'
import { OutputSearch } from './output-search'
import { PanelTerminal } from './panel-terminal'
import { EmptyState, ErrorState } from '@/composites/empty-state'

/**
 * The bottom panel (docs/features/status-bar.md), VS Code's Panel: under every
 * view and split, above the status bar, with a Terminal and an Output tab.
 *
 * Its top edge is the resize handle, drawn like the split view's (a hairline,
 * a wider hit area, the ring on hover and drag), with the arrow keys and a
 * double-click back to the default height. The height is this machine's.
 *
 * Mounted from the shell's first render, so ⌃` and ⇧⌘U are live, but drawn
 * only once it has been opened; after that a closed panel is hidden, never
 * unmounted, so the shells' scrollback and the Output's place survive.
 */

/** One arrow press, and with Shift. */
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

export function BottomPanel({ onRetryOutput }: { onRetryOutput: () => void }) {
  const [panel, setPanel] = useAtom(bottomPanelAtom)
  // Main keeps its log from launch, so the panel's copy can start here.
  const retryLogs = useAppLog()
  const toggle = useSetAtom(togglePanelAtom)
  const [height, setHeight] = useState(readPanelHeight)
  const [resizing, setResizing] = useState(false)
  const [everOpen, setEverOpen] = useState(panel.open)
  /** The column's height, which bounds the panel's. */
  const [available, setAvailable] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ y: number; height: number } | null>(null)

  useShortcutHandlers({
    'panel.terminal': () => toggle('terminal'),
    'panel.output': () => toggle('output'),
  })

  useEffect(() => {
    if (panel.open) setEverOpen(true)
  }, [panel.open])

  // The column it sits in: its height bounds the panel's.
  useLayoutEffect(() => {
    const column = rootRef.current?.parentElement
    if (!column) return
    const measure = () => setAvailable(column.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [everOpen])

  const shown = available > 0 ? clampPanelHeight(height, available) : height

  function commit(next: number) {
    const clamped =
      available > 0 ? clampPanelHeight(next, available) : Math.max(PANEL_MIN_HEIGHT, next)
    setHeight(clamped)
    writePanelHeight(clamped)
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, height: shown }
    setResizing(true)
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current
    if (start === null) return
    // Dragging up makes it taller.
    const next = start.height + (start.y - e.clientY)
    setHeight(available > 0 ? clampPanelHeight(next, available) : next)
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (drag.current === null) return
    drag.current = null
    setResizing(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    commit(height)
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const keys: Record<string, number> = {
      ArrowUp: shown + step,
      ArrowDown: shown - step,
      Home: Number.MAX_SAFE_INTEGER,
      End: PANEL_MIN_HEIGHT,
    }
    const next = keys[e.key]
    if (next === undefined) return
    e.preventDefault()
    commit(next)
  }

  if (!everOpen) return <div ref={rootRef} hidden />

  const max = available > 0 ? clampPanelHeight(Number.MAX_SAFE_INTEGER, available) : undefined

  return (
    <div
      ref={rootRef}
      data-bottom-panel
      data-glass-ground
      hidden={!panel.open}
      style={panel.maximized ? undefined : ({ '--panel-height': `${shown}px` } as CSSProperties)}
      className={cn(
        'bg-background relative flex min-h-0 shrink-0 flex-col',
        panel.maximized ? 'flex-1' : 'h-(--panel-height)',
      )}
    >
      {/* The top edge: a hairline that is the resize handle. */}
      {panel.maximized ? (
        <div className="bg-border h-px shrink-0" />
      ) : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
          aria-valuenow={shown}
          aria-valuemin={PANEL_MIN_HEIGHT}
          aria-valuemax={max}
          tabIndex={0}
          data-resizing={resizing || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={() => commit(PANEL_DEFAULT_HEIGHT)}
          onKeyDown={onKeyDown}
          className="bg-border hover:bg-ring focus-visible:bg-ring data-resizing:bg-ring relative z-10 h-px shrink-0 cursor-row-resize outline-hidden motion-respond after:absolute after:inset-x-0 after:-inset-y-1"
        />
      )}
      <BottomPanelHeader
        tab={panel.tab}
        onTab={(tab) => setPanel((p) => ({ ...p, tab }))}
        maximized={panel.maximized}
        onMaximize={() => setPanel((p) => ({ ...p, maximized: !p.maximized }))}
        onClose={() => setPanel((p) => ({ ...p, open: false, maximized: false }))}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalTab visible={panel.open && panel.tab === 'terminal'} />
        <div className={cn('flex min-h-0 flex-1 flex-col', panel.tab !== 'output' && 'hidden')}>
          <PanelOutput visible={panel.open && panel.tab === 'output'} onRetry={onRetryOutput} />
        </div>
        <div className={cn('flex min-h-0 flex-1 flex-col', panel.tab !== 'logs' && 'hidden')}>
          <PanelLogs onRetry={retryLogs} />
        </div>
      </div>
    </div>
  )
}

function BottomPanelHeader({
  tab,
  onTab,
  maximized,
  onMaximize,
  onClose,
}: {
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  maximized: boolean
  onMaximize: () => void
  onClose: () => void
}) {
  return (
    <PanelHeader
      extra={
        <>
          {tab === 'terminal' ? (
            <TerminalControls />
          ) : tab === 'output' ? (
            <OutputControls />
          ) : (
            <LogsControls />
          )}
          <div className="bg-border mx-1 h-4 w-px" aria-hidden />
        </>
      }
      actions={[
        {
          icon: maximized ? Minimize2Icon : Maximize2Icon,
          label: maximized ? 'Restore panel size' : 'Maximize panel',
          onSelect: onMaximize,
        },
      ]}
      close={{ icon: XIcon, label: 'Close panel', onSelect: onClose }}
    >
      <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)}>
        <TabsList variant="line">
          <TabsTrigger value="terminal" className="text-xs">
            Terminal
          </TabsTrigger>
          <TabsTrigger value="output" className="text-xs">
            Output
          </TabsTrigger>
          <TabsTrigger value="logs" className="text-xs">
            Logs
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </PanelHeader>
  )
}

function TerminalControls() {
  const terminals = useAtomValue(panelTerminalsAtom)
  const [active, setActive] = useAtom(activePanelTerminalAtom)
  const create = useSetAtom(createPanelTerminalAtom)
  const kill = useSetAtom(killPanelTerminalAtom)
  const remote = useAtomValue(activeRemoteAtom)
  return (
    <>
      {terminals.length > 0 ? (
        <Select value={active ?? undefined} onValueChange={setActive}>
          <SelectTrigger size="sm" aria-label="Terminal" className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {terminals.map((t) => (
              <SelectItem key={t.id} value={t.id} className="text-xs">
                {terminalLabel(t, terminals)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <IconButton
        size="icon-xs"
        label="New terminal"
        disabled={remote === null}
        onClick={() => void create()}
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </IconButton>
      <IconButton
        size="icon-xs"
        label="Kill terminal"
        disabled={active === null}
        onClick={() => {
          if (active !== null) void kill(active)
        }}
      >
        <Trash2Icon aria-hidden className="size-3.5" />
      </IconButton>
    </>
  )
}

function OutputControls() {
  const entries = useAtomValue(activityEntriesAtom)
  const query = useAtomValue(activityQueryAtom)
  const search = useAtomValue(activitySearchAtom)
  const clear = useSetAtom(clearActivityAtom)
  const shown = shownEntries(entries, query, search)
  return (
    <>
      <OutputSearch />
      <IconButton
        size="icon-xs"
        label="Copy output"
        disabled={shown.length === 0}
        onClick={() => {
          void navigator.clipboard
            .writeText(shown.map(entryText).join('\n'))
            .then(() => toast.success('Output copied'))
            .catch(() => toast.error('Could not copy the output'))
        }}
      >
        <CopyIcon aria-hidden className="size-3.5" />
      </IconButton>
      <IconButton
        size="icon-xs"
        label="Clear output"
        disabled={entries.length === 0}
        onClick={() => void clear()}
      >
        <EraserIcon aria-hidden className="size-3.5" />
      </IconButton>
    </>
  )
}

function LogsControls() {
  const entries = useAtomValue(appLogEntriesAtom)
  const query = useAtomValue(appLogQueryAtom)
  const search = useAtomValue(appLogSearchAtom)
  const clear = useSetAtom(clearAppLogAtom)
  const shown = shownAppLog(entries, query, search)
  return (
    <>
      <LogsSearch />
      <IconButton
        size="icon-xs"
        label="Copy logs"
        disabled={shown.length === 0}
        onClick={() => {
          void navigator.clipboard
            .writeText(shown.map(appLogText).join('\n'))
            .then(() => toast.success('Logs copied'))
            .catch(() => toast.error('Could not copy the logs'))
        }}
      >
        <CopyIcon aria-hidden className="size-3.5" />
      </IconButton>
      <IconButton
        size="icon-xs"
        label="Clear logs"
        disabled={entries.length === 0}
        onClick={() => void clear()}
      >
        <EraserIcon aria-hidden className="size-3.5" />
      </IconButton>
    </>
  )
}

/** The Terminal tab: every shell, the one in front shown. The first show
 *  with none opens one, as VS Code does. */
function TerminalTab({ visible }: { visible: boolean }) {
  const terminals = useAtomValue(panelTerminalsAtom)
  const active = useAtomValue(activePanelTerminalAtom)
  const error = useAtomValue(panelTerminalErrorAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const create = useSetAtom(createPanelTerminalAtom)
  /** One automatic start per empty list: a ref, not state, because React
   *  runs a mount effect twice in development and two shells would start. */
  const autoStarted = useRef(false)

  useEffect(() => {
    if (terminals.length > 0) {
      autoStarted.current = false
      return
    }
    if (!visible || remote === null || error !== null) return
    if (autoStarted.current) return
    autoStarted.current = true
    void create()
  }, [visible, remote, terminals.length, error, create])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
      {terminals.map((t) => (
        <PanelTerminal
          key={t.id}
          id={t.id}
          visible={visible && t.id === active}
          context={t.context}
        />
      ))}
      {terminals.length > 0 ? null : remote === null ? (
        <EmptyState
          title="No vault is open"
          description="A terminal starts in the open vault's folder."
        />
      ) : error !== null ? (
        <ErrorState
          title="The terminal did not start"
          message={error}
          onRetry={() => void create()}
        />
      ) : (
        <div role="status" className="text-muted-foreground px-4 py-3 text-xs">
          Starting a shell…
        </div>
      )}
    </div>
  )
}
