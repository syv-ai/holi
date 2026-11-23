/**
 * A vault file's bytes for a viewer: read over IPC (`files.read`, the PDF
 * viewer's route, since a renderer `fetch` of `holi-vault://` fails on CORS),
 * read again on Retry, and read again when the file changes on disk under the
 * open tab (a pull, another tool). This plugin never writes, so every change
 * the snapshot reports is a foreign one.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, snapshotAtom, trpc } from '@/plugin-api'

export type FileBytes =
  | { state: 'loading' }
  | { state: 'error'; message: string; retry(): void }
  | { state: 'ready'; bytes: Uint8Array<ArrayBuffer>; version: number }

export function useFileBytes(path: string): FileBytes {
  const remote = useAtomValue(activeRemoteAtom)
  const updatedAt = useAtomValue(snapshotAtom).files.find((f) => f.path === path)?.updatedAt ?? null
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<FileBytes>({ state: 'loading' })

  useEffect(() => {
    if (remote === null) return
    let cancelled = false
    setResult((now) => (now.state === 'ready' ? now : { state: 'loading' }))
    trpc.files.read.query({ remote, path }).then(
      (bytes) => {
        // tRPC types a `Uint8Array` output as a JSON stand-in; structured
        // clone delivered the real thing (see `files.read`).
        if (!cancelled)
          setResult((now) => ({
            state: 'ready',
            bytes: bytes as unknown as Uint8Array<ArrayBuffer>,
            version: now.state === 'ready' ? now.version + 1 : 0,
          }))
      },
      (err: unknown) => {
        if (cancelled) return
        setResult({
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
          retry: () => setAttempt((n) => n + 1),
        })
      },
    )
    return () => {
      cancelled = true
    }
    // `updatedAt` is the trigger: a new mtime is a new version of the file.
  }, [remote, path, attempt, updatedAt])

  return result
}
