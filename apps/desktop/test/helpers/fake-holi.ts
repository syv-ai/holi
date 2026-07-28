/**
 * A `window.holi` that a node-environment test can drive.
 *
 * The renderer's state layer is worth testing and its components are not — the
 * suite has no DOM, and every renderer test in this repo is logic extracted out
 * of a component into a module. What those modules all touch is the one seam,
 * so faking the seam is what makes them reachable.
 *
 * Deliberately NOT a mock of tRPC. The real `lib/trpc.ts` client and the real
 * `ipcLink` run on top of this: the envelope contract between them
 * (`{ok:true,data}` / `{ok:false,message}`) is exactly the kind of thing that a
 * mocked client would paper over, and it crosses a process boundary in
 * production where nobody can see it fail.
 */
import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../src/main/vault/active-vault'
import type { TrpcEnvelope, TrpcOpWire } from '../../src/renderer/src/lib/ipc-link'

export interface FakeHoli {
  /** Every op that reached the seam, in order. */
  calls: { path: string; input: unknown }[]
  pushSnapshot(snapshot: VaultSnapshot): void
  pushSyncState(state: SyncState): void
  /** Fire `onFlushRequest` and resolve once the renderer calls `flushDone()`. */
  requestFlush(): Promise<void>
  restore(): void
}

/**
 * `handle` returns the `data` half of a successful envelope, or throws to
 * produce a failed one — which is how a procedure refuses in production, so a
 * test that wants a NOT_FOUND writes a throw rather than assembling a wire
 * shape by hand.
 */
export function installFakeHoli(handle: (op: TrpcOpWire) => unknown = () => undefined): FakeHoli {
  const calls: { path: string; input: unknown }[] = []
  const snapshotSubs = new Set<(s: VaultSnapshot) => void>()
  const syncSubs = new Set<(s: SyncState) => void>()
  const flushSubs = new Set<() => void>()
  const reminderSubs = new Set<(p: { remote: string; path: string }) => void>()
  let onFlushed: (() => void) | null = null

  const subscribe = <T>(subs: Set<(v: T) => void>) => (cb: (v: T) => void) => {
    subs.add(cb)
    return () => void subs.delete(cb)
  }

  const holi = {
    async trpc(op: TrpcOpWire): Promise<TrpcEnvelope> {
      calls.push({ path: op.path, input: op.input })
      try {
        return { ok: true, data: await handle(op) }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    vault: {
      onSnapshot: subscribe(snapshotSubs),
      onSyncState: subscribe(syncSubs),
      onFlushRequest: subscribe(flushSubs),
      flushDone: () => onFlushed?.(),
    },
    reminders: {
      onOpen: subscribe(reminderSubs),
    },
    openExternal: async () => {},
  }

  // There is no `window` in `environment: 'node'` — this creates one rather
  // than decorating one.
  const priorWindow = (globalThis as Record<string, unknown>).window
  const existing = (priorWindow ?? {}) as Record<string, unknown>
  ;(globalThis as Record<string, unknown>).window = { ...existing, holi }

  return {
    calls,
    pushSnapshot: (snapshot) => {
      for (const cb of snapshotSubs) cb(snapshot)
    },
    pushSyncState: (state) => {
      for (const cb of syncSubs) cb(state)
    },
    requestFlush: () =>
      new Promise<void>((resolve) => {
        onFlushed = resolve
        for (const cb of flushSubs) cb()
      }),
    restore() {
      // Actually removed, not left behind. A leaked fake makes the NEXT test
      // file talk to a seam that is not there, and the failure surfaces
      // somewhere unrelated — the same shape as plan 4's leaked ActiveVault.
      if (priorWindow === undefined) delete (globalThis as Record<string, unknown>).window
      else (globalThis as Record<string, unknown>).window = priorWindow
    },
  }
}
