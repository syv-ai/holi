import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useAtomValue, useSetAtom } from "jotai"
import {
  CloudOffIcon,
  GitBranchIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { syncLabel, type SyncState } from "@holi/shared"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import { trpc } from "@/lib/trpc"
import {
  activityEntriesAtom,
  activityUnseenErrorAtom,
  type ActivityEntry,
} from "@/state/activity"
import {
  bottomPanelAtom,
  showPanelAtom,
  togglePanelAtom,
} from "@/state/bottom-panel"
import { runningPluginsAtom } from "@/state/plugins"
import { isMac } from "@/state/shortcuts"
import { BranchPicker } from "./branch-picker"
import {
  activeRemoteAtom,
  historyEpochsAtom,
  syncStateAtom,
} from "@/state/vaults"

/**
 * The status bar (docs/features/status-bar.md), VS Code's: one thin row at
 * the foot of the main column, under every view, split and the bottom panel,
 * and the same whichever tab is in front. Left, the vault's branch and its
 * sync; right, what plugins add (the agent's sessions), then the Terminal and
 * Output toggles. Only what is true: an item with nothing to say is not drawn.
 */

/** One item: a compact ghost button with its tooltip. Plugins draw theirs
 *  with it too (`@/plugin-api`). Other button props pass through, so an item
 *  can be a popover's trigger (the branch picker). */
export function StatusBarItem({
  tooltip,
  onClick,
  label,
  pressed,
  children,
  ...rest
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
  tooltip: string
  onClick?: ComponentProps<typeof Button>["onClick"]
  /** Its accessible name, when the visible text is not enough. */
  label?: string
  /** A toggle's state, for the panel's two. */
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...rest}
          type="button"
          variant="ghost"
          size="xs"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className="text-muted-foreground aria-pressed:text-foreground font-normal"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** What `sync.info` answers: the branch, the tree, ahead and behind. */
interface SyncInfoView {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  lastSyncAt: string | null
  lastError: string | null
}

/** "Synced just now", "Synced 4m ago", for the last time the remote answered. */
export function syncedAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (Number.isNaN(seconds)) return ""
  if (seconds < 60) return "Synced just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `Synced ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Synced ${hours}h ago`
  return `Synced ${Math.round(hours / 24)}d ago`
}

/** The sync item's look for a state: whether it turns, whether it warns,
 *  and what clicking it does. */
export function syncItemView(state: SyncState): {
  busy: boolean
  problem: "offline" | "warn" | null
  /** `sync`: run a sync now. `output`: the state needs reading, not a retry
   *  (a conflict, a pause, no access): open the log. */
  click: "sync" | "output"
} {
  switch (state.kind) {
    case "up-to-date":
      return { busy: false, problem: null, click: "sync" }
    case "pulling":
      return { busy: true, problem: null, click: "output" }
    case "offline":
      return { busy: false, problem: "offline", click: "sync" }
    case "reconciling":
      return { busy: true, problem: "warn", click: "output" }
    case "paused":
      return {
        busy: false,
        problem: state.manual ? null : "warn",
        click: "output",
      }
    case "no-access":
    case "conflict":
      return { busy: false, problem: "warn", click: "output" }
  }
}

/** The newest git or sync line's id, or 0. */
function lastGitLine(entries: readonly ActivityEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.channel === "git" || e.channel === "sync") return e.id
  }
  return 0
}

/** How often the bar rereads the branch and counts when nothing pushed. */
const INFO_INTERVAL_MS = 30_000

/** The branch and counts, reread whenever sync or history moves. */
function useSyncInfo(): SyncInfoView | null {
  const remote = useAtomValue(activeRemoteAtom)
  const state = useAtomValue(syncStateAtom)
  const epochs = useAtomValue(historyEpochsAtom)
  const entries = useAtomValue(activityEntriesAtom)
  /** The newest git or sync line: a commit or a push moves the counts. */
  const lastGit = lastGitLine(entries)
  const [info, setInfo] = useState<SyncInfoView | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), INFO_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (remote === null) {
      setInfo(null)
      return
    }
    let live = true
    trpc.sync.info
      .query()
      .then((next) => {
        if (live) setInfo(next !== null && next.remote === remote ? next : null)
      })
      .catch(() => {
        if (live) setInfo(null)
      })
    return () => {
      live = false
    }
  }, [remote, state, epochs, lastGit, tick])

  return info
}

/** Now, every half minute: enough for "Synced 2m ago". `Date.now()` is the
 *  real wall clock here, which that sentence is measured against. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), INFO_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

function SyncItems() {
  const state = useAtomValue(syncStateAtom)
  const info = useSyncInfo()
  const now = useNow()
  const showPanel = useSetAtom(showPanelAtom)
  const [running, setRunning] = useState(false)
  const view = syncItemView(state)

  const syncNow = useCallback(() => {
    if (view.click === "output") {
      showPanel("output")
      return
    }
    setRunning(true)
    void trpc.sync.now
      .mutate()
      .catch(() => showPanel("output"))
      .finally(() => setRunning(false))
  }, [view.click, showPanel])

  if (info === null) return null
  const label = syncLabel(state)
  const busy = view.busy || running
  const counts = `${info.behind}↓ ${info.ahead}↑`
  const tooltip = [
    `Sync: ${label.text}`,
    info.lastError === null ? null : info.lastError.split("\n")[0],
    view.click === "sync" ? "Click to sync now" : "Click to open the output",
  ]
    .filter((line) => line !== null)
    .join(". ")

  return (
    <>
      <BranchPicker
        trigger={
          <StatusBarItem
            tooltip={
              info.dirty
                ? `Branch ${info.branch}, with changes not yet committed. Click to switch branch`
                : `Branch ${info.branch}. Click to switch branch`
            }
            label={`Branch ${info.branch}${info.dirty ? ", uncommitted changes" : ""}`}
          >
            <GitBranchIcon aria-hidden />
            <span className="max-w-40 truncate">
              {info.branch}
              {info.dirty ? "*" : ""}
            </span>
          </StatusBarItem>
        }
      />
      <StatusBarItem
        tooltip={tooltip}
        label={`Sync: ${label.text}, ${info.behind} behind, ${info.ahead} ahead`}
        onClick={syncNow}
      >
        {view.problem === "offline" ? (
          <CloudOffIcon aria-hidden className="text-warning size-3.5" />
        ) : view.problem === "warn" && !busy ? (
          <TriangleAlertIcon aria-hidden className="text-warning size-3.5" />
        ) : (
          <RefreshCwIcon
            aria-hidden
            className={cn(
              "size-3.5",
              busy && "animate-spin motion-reduce:animate-none"
            )}
          />
        )}
        <span className="tabular-nums">{counts}</span>
        {view.problem === null ? null : (
          <span className="max-w-48 truncate">{label.text}</span>
        )}
      </StatusBarItem>
      {info.lastSyncAt === null ? null : (
        <span className="text-muted-foreground hidden px-1 text-xs @2xl/status:inline">
          {syncedAgo(info.lastSyncAt, now)}
        </span>
      )}
    </>
  )
}

function PanelToggles() {
  const panel = useAtomValue(bottomPanelAtom)
  const toggle = useSetAtom(togglePanelAtom)
  const unseenError = useAtomValue(activityUnseenErrorAtom)
  const onTerminal = panel.open && panel.tab === "terminal"
  const mac = isMac()
  const terminalKey = mac ? "⌃`" : "Ctrl+`"
  const outputKey = mac ? "⇧⌘U" : "Ctrl+Shift+U"
  const onOutput = panel.open && panel.tab === "output"
  return (
    <>
      <StatusBarItem
        tooltip={`${onTerminal ? "Hide" : "Show"} the terminal (${terminalKey})`}
        pressed={onTerminal}
        onClick={() => toggle("terminal")}
      >
        <SquareTerminalIcon aria-hidden />
        Terminal
      </StatusBarItem>
      <StatusBarItem
        tooltip={
          unseenError
            ? `Something failed in the background: show the output (${outputKey})`
            : `${onOutput ? "Hide" : "Show"} the output (${outputKey})`
        }
        label={unseenError ? "Output, with a new error" : undefined}
        pressed={onOutput}
        onClick={() => toggle("output")}
      >
        <span className="relative inline-flex">
          <ScrollTextIcon aria-hidden className="size-3.5" />
          {unseenError ? (
            <span
              aria-hidden
              className="bg-destructive absolute -end-0.5 -top-0.5 size-1.5 rounded-full"
            />
          ) : null}
        </span>
        Output
      </StatusBarItem>
    </>
  )
}

export function StatusBar() {
  const running = useAtomValue(runningPluginsAtom)
  const items = running
    .flatMap(({ info, statusItems = [] }) =>
      statusItems.map((item) => ({ ...item, key: `${info.id}:${item.id}` }))
    )
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  const left = items.filter((item) => item.side === "left")
  const right = items.filter((item) => item.side === "right")
  return (
    <footer
      data-slot="app-chrome"
      aria-label="Status bar"
      className="@container/status text-muted-foreground flex h-6 shrink-0 items-center gap-1 overflow-hidden border-t px-1 text-xs"
    >
      <SyncItems />
      {left.map(({ key, Component }) => (
        <Component key={key} />
      ))}
      <div className="min-w-0 flex-1" />
      {right.map(({ key, Component }) => (
        <Component key={key} />
      ))}
      <PanelToggles />
    </footer>
  )
}
