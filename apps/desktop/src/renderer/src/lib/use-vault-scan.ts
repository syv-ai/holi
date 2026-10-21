import { useEffect, useRef, useState } from 'react'

/** How long the vault stays still before a scan is asked again: a burst of
 *  autosaves is one scan. */
export const VAULT_QUIET_MS = 800

export type Scan<T> = { ok: true; data: T } | { ok: false; message: string }

/**
 * A main-side scan of the vault that follows the vault (the links drawer, the
 * graph): main keeps no link index, so these ask again when the vault changes.
 *
 * Asked at once for each new `key` (null asks nothing), and again `quietMs`
 * after `fingerprint` last changed, only if it changed since the last ask. One
 * scan at a time per key: a change landing mid-scan asks once more when that
 * scan returns. A scan for a key no longer current is dropped, since IPC cannot
 * tell main to stop one. Returns the latest scan for the current key, or null
 * while the first is in flight.
 */
export function useVaultScan<T>(
  key: string | null,
  fingerprint: string,
  ask: () => Promise<T>,
  quietMs = VAULT_QUIET_MS,
): Scan<T> | null {
  const [result, setResult] = useState<{ key: string; scan: Scan<T> } | null>(null)
  const latestAsk = useRef(ask)
  const latestPrint = useRef(fingerprint)
  const kick = useRef<(() => void) | null>(null)
  useEffect(() => {
    latestAsk.current = ask
    latestPrint.current = fingerprint
  })

  useEffect(() => {
    if (key === null) return
    let live = true
    let busy = false
    let pending = false
    let asked: string | null = null
    const go = () => {
      if (!live || asked === latestPrint.current) return
      if (busy) {
        pending = true
        return
      }
      busy = true
      pending = false
      asked = latestPrint.current
      latestAsk
        .current()
        .then(
          (data) => live && setResult({ key, scan: { ok: true, data } }),
          (err: unknown) =>
            live &&
            setResult({
              key,
              scan: { ok: false, message: err instanceof Error ? err.message : String(err) },
            }),
        )
        .finally(() => {
          busy = false
          if (pending) go()
        })
    }
    kick.current = go
    go()
    return () => {
      live = false
      kick.current = null
    }
  }, [key])

  useEffect(() => {
    const timer = setTimeout(() => kick.current?.(), quietMs)
    return () => clearTimeout(timer)
  }, [fingerprint, quietMs])

  return result !== null && result.key === key ? result.scan : null
}
