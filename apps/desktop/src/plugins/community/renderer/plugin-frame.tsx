/**
 * A file a community plugin opens, as its tab: the plugin's own server for
 * that file, framed (docs/features/community-plugins.md).
 *
 * The tab holds the server while it is mounted: it acquires on mount and
 * releases on unmount, and main stops the server when the last tab on the
 * file lets go. While the server starts the tab shows its output, and if it
 * fails or stops, the output and a way to start it again.
 */
import { useAtomValue, useStore } from 'jotai'
import { useEffect, useState } from 'react'
import { pluginServerOrigin, servedFile } from '@holi/shared'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { communityCap } from './community-cap'
import {
  refreshRows,
  rowsAtom,
  rowsErrorAtom,
  serversAtom,
  servingRow,
  type PluginRow,
  type ServerState,
} from './state'

type Phase =
  | { kind: 'starting' }
  | { kind: 'running'; port: number }
  | { kind: 'failed'; message: string }
  | { kind: 'unavailable' }

export function PluginFrame({
  path,
  visible = true,
}: {
  path: string
  visible?: boolean
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const rows = useAtomValue(rowsAtom)
  const rowsError = useAtomValue(rowsErrorAtom)
  const store = useStore()
  const server: ServerState | undefined = useAtomValue(serversAtom)[path]
  const currentRows = rows?.remote === remote ? rows.rows : []
  const row = servingRow(currentRows, path)
  // Non-running claims explain unavailability, but never choose the lease's owner.
  const unavailableRow =
    row === null ? (currentRows.find((item) => servedFile(item, path) !== null) ?? null) : null
  const eligible = remote !== null && row !== null
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  /** Bumped by Restart: a fresh acquire, and a fresh document. */
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (remote === null || !eligible) {
      setPhase({ kind: 'unavailable' })
      setLoaded(false)
      return
    }
    let live = true
    setPhase({ kind: 'starting' })
    setLoaded(false)
    const acquired = communityCap.acquire(remote, { path })
    acquired.then(
      ({ port }) => live && setPhase({ kind: 'running', port }),
      (err: unknown) =>
        live &&
        setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
      // Released once its acquire answers, never before: a release that
      // overtook its acquire would leave the server held.
      void acquired
        .then(({ lease }) => communityCap.release(remote, { lease }))
        .catch(() => undefined)
    }
  }, [remote, path, attempt, eligible, row?.id])

  // A server that stops on its own while the tab shows it.
  const exited = server?.state === 'exited' ? server : null
  const name = row?.name ?? unavailableRow?.name ?? 'The plugin'
  const log = server?.log ?? []

  if (eligible && phase.kind === 'running' && exited === null) {
    return (
      <iframe
        key={`${phase.port}:${attempt}`}
        src={`${pluginServerOrigin(phase.port)}/`}
        aria-label={`${name}: ${path}`}
        inert={!visible}
        // `allow-same-origin` is safe here, unlike a vault app's frame: the
        // server's loopback origin is never the renderer's, so the frame
        // cannot reach Holi's document with it. It is needed because a dev
        // server's module scripts fail CORS from an opaque origin.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        allow="fullscreen; clipboard-read; clipboard-write"
        onLoad={() => setLoaded(true)}
        className={cn('size-full border-0', loaded ? 'motion-in-fade' : 'opacity-0')}
      />
    )
  }

  const stopped = eligible
    ? phase.kind === 'failed'
      ? phase.message
      : (exited?.message ?? null)
    : null
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {!eligible ? (
            <>
              {unavailableReason(unavailableRow)} Check Settings → Plugins to restore access, then
              check again.
            </>
          ) : stopped === null ? (
            <>
              Starting <span className="text-foreground">{name}</span> for{' '}
              <span className="font-mono">{path}</span>…
            </>
          ) : (
            <>
              <span className="text-foreground">{name}</span> stopped: {stopped}
            </>
          )}
        </p>
        {!eligible ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => {
              if (remote !== null) void refreshRows(remote, store)
            }}
          >
            Check again
          </Button>
        ) : stopped !== null ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Start again
          </Button>
        ) : null}
      </div>
      {!eligible && rowsError !== null && (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not check plugins: {rowsError}. Try Check again.
        </p>
      )}
      {log.length > 0 && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {log.join('\n')}
        </pre>
      )}
    </div>
  )
}

/** Use a non-running claim only to explain the next step, not to select a server. */
function unavailableReason(row: PluginRow | null): string {
  if (row === null) return 'No installed or pinned plugin claims this file.'
  if (!row.on) return `${row.name} is turned off in this vault.`
  const reasons: Record<PluginRow['status'], string> = {
    'not-installed': 'is not installed on this machine',
    'pin-differs': 'needs the version pinned by this vault',
    'needs-consent': 'needs permission to run this version',
    'needs-setup': 'needs setup',
    'setup-failed': 'could not finish setup',
    ready: 'is not running',
  }
  return `${row.name} ${reasons[row.status]}.`
}
