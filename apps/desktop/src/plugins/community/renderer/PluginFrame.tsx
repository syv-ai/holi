/**
 * A file a community plugin opens, as its tab: the plugin's own server for
 * that file, framed (docs/features/community-plugins.md).
 *
 * The tab holds the server while it is mounted: it acquires on mount and
 * releases on unmount, and main stops the server when the last tab on the
 * file lets go. While the server starts the tab shows its output, and if it
 * fails or stops, the output and a way to start it again.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { pluginServerOrigin } from '@holi/shared'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { Button } from '@/primitives'
import { communityCap, rowsAtom, servingRow, serversAtom, type ServerState } from './state'

type Phase =
  { kind: 'starting' } | { kind: 'running'; port: number } | { kind: 'failed'; message: string }

export function PluginFrame({ path }: { path: string }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const rows = useAtomValue(rowsAtom)
  const server: ServerState | undefined = useAtomValue(serversAtom)[path]
  const row = rows === null ? null : servingRow(rows.rows, path)
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  /** Bumped by Restart: a fresh acquire, and a fresh document. */
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (remote === null) return
    let live = true
    setPhase({ kind: 'starting' })
    setLoaded(false)
    communityCap.acquire(remote, { path }).then(
      ({ port }) => live && setPhase({ kind: 'running', port }),
      (err: unknown) =>
        live &&
        setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
      void communityCap.release(remote, { path }).catch(() => undefined)
    }
  }, [remote, path, attempt])

  // A server that stops on its own while the tab shows it.
  const exited = server?.state === 'exited' ? server : null
  const name = row?.name ?? 'The plugin'
  const log = server?.log ?? []

  if (phase.kind === 'running' && exited === null) {
    return (
      <iframe
        key={`${phase.port}:${attempt}`}
        src={`${pluginServerOrigin(phase.port)}/`}
        aria-label={`${name}: ${path}`}
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

  const stopped = phase.kind === 'failed' ? phase.message : (exited?.message ?? null)
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {stopped === null ? (
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
        {stopped !== null && (
          <Button size="xs" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Start again
          </Button>
        )}
      </div>
      {log.length > 0 && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {log.join('\n')}
        </pre>
      )}
    </div>
  )
}
