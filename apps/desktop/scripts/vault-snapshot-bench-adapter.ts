import type { VaultSnapshot } from '@holi/shared'

interface SnapshotPluginHost {
  invalidate(remote?: string): void
  reconcile(vault: { remote: string; root: string }, why: 'snapshot'): Promise<void>
  snapshot(remote: string, snapshot: VaultSnapshot): void
  scanClaimsFor(root: string): Promise<readonly { plugin: string }[]>
}

export interface SnapshotAdapterOptions {
  mode: 'baseline' | 'candidate'
  remote: string
  getVault: () => { remote: string; root: string } | null
  host: SnapshotPluginHost
  send: (payload: { remote: string; snapshot: VaultSnapshot }) => void
  onSend?: (serialized: string) => void
  refresh: () => void
  pluginReady?: () => boolean
  fingerprint?: () => Promise<string>
  onPluginCallback?: (kind: 'invalidate' | 'reconcile' | 'snapshot', elapsedMs: number) => void
}

/** Mirrors main/index.ts snapshot callback order; candidate mode gates only the renderer payload. */
export function createSnapshotBenchAdapter(options: SnapshotAdapterOptions) {
  let lastSerialized: string | null = null
  let lastFingerprint: string | null = null
  let runtimeEpoch = 0
  let presentationEpoch = 0
  let disposed = false
  let scans = 0
  let sent = 0
  let suppressed = 0
  let payloadBytes = 0
  const pluginCallbacks: Array<{ kind: string; elapsedMs: number }> = []

  function epochChanged(): void {
    runtimeEpoch++
    presentationEpoch++
    lastSerialized = null
    lastFingerprint = null
  }

  async function onSnapshot(snapshot: VaultSnapshot, force = false): Promise<void> {
    if (disposed) return
    scans++
    const runtime = runtimeEpoch
    const presentation = presentationEpoch
    const serialized = JSON.stringify(snapshot)
    // Candidate-only content inspection: the baseline pays no fingerprint cost.
    const initialVault = options.getVault()
    const fingerprint =
      options.mode === 'candidate' && options.fingerprint ? await options.fingerprint() : null
    const stillCurrent = () => {
      const current = options.getVault()
      return (
        !disposed &&
        runtime === runtimeEpoch &&
        presentation === presentationEpoch &&
        current?.remote === initialVault?.remote &&
        current?.root === initialVault?.root
      )
    }
    if (!stillCurrent()) return
    const send =
      options.mode === 'baseline' ||
      force ||
      lastSerialized === null ||
      lastSerialized !== serialized ||
      (fingerprint !== null && fingerprint !== lastFingerprint)
    if (send) {
      lastSerialized = serialized
      lastFingerprint = fingerprint
      sent++
      payloadBytes += Buffer.byteLength(serialized)
      options.send({ remote: options.remote, snapshot })
      options.onSend?.(serialized)
    } else suppressed++
    const vault = options.getVault()
    if (vault === null || vault.remote !== options.remote || options.pluginReady?.() === false)
      return
    const invoke = async (
      kind: 'invalidate' | 'reconcile' | 'snapshot',
      action: () => void | Promise<void>,
    ) => {
      const start = performance.now()
      await action()
      if (!stillCurrent()) return false
      const elapsedMs = performance.now() - start
      pluginCallbacks.push({ kind, elapsedMs })
      options.onPluginCallback?.(kind, elapsedMs)
      return stillCurrent()
    }
    if (!(await invoke('invalidate', () => options.host.invalidate(options.remote)))) return
    if (!(await invoke('reconcile', () => options.host.reconcile(vault, 'snapshot')))) return
    if (!(await invoke('snapshot', () => options.host.snapshot(options.remote, snapshot)))) return
    const claims = await options.host.scanClaimsFor(vault.root)
    if (!stillCurrent()) return
    const now = new Set(claims.map((claim) => claim.plugin))
    const was = Object.keys(snapshot.claimed)
    if (was.length !== now.size || was.some((id) => !now.has(id))) options.refresh()
  }

  return {
    onSnapshot,
    epochChanged,
    dispose() {
      disposed = true
    },
    resetMetrics() {
      scans = 0
      sent = 0
      suppressed = 0
      payloadBytes = 0
      pluginCallbacks.length = 0
    },
    metrics: () => ({
      scans,
      sent,
      suppressed,
      payloadBytes,
      pluginCallbacks: [...pluginCallbacks],
      runtimeEpoch,
      presentationEpoch,
    }),
  }
}
