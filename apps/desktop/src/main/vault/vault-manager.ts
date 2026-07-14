/** One active vault at a time (spec §Session lifecycle): activate tears down
 * the previous vault's mirror + event stream and starts the next. Working
 * copies live under userData/working-copies/<vaultId>; frozen bases under
 * userData/vault-bases/<vaultId>. */
import { join } from 'node:path'
import type { Task } from '@holi/shared'
import { app } from 'electron'
import { ensureSeeded } from '../agent/seed-content'
import { API_URL, RELAY_URL, createServerClient } from '../server-client'
import type { SessionStore } from '../session'
import { makeMirrorApi } from './mirror-api'
import { SseClient } from './sse-client'
import { VaultMirror, type DocsEvent } from './vault-mirror'

/** Mirrors the server bus's TasksEvent shape (apps/server/src/bus.ts). */
export type TasksEvent =
  | { type: 'upserted'; task: Task }
  | { type: 'deleted'; taskId: string }

/**
 * The agent's window into the vault lifecycle (slice 2). Implemented by
 * AgentManager; the VaultManager stays ignorant of what the agent does with it.
 */
export interface VaultObserver {
  /** After the mirror is live and managed files are seeded. */
  onActivated(vaultId: string, mirror: VaultMirror): void | Promise<void>
  /** BEFORE the mirror and event stream stop — open turns must still merge. */
  onDeactivating(vaultId: string): void | Promise<void>
  onTurnActivity(activeTurns: number): void
  onMaterialize(rel: string): void
  /** Carries the payload: the task file projection materializes from it, so it
   * is no longer just an invalidation ping. */
  onTasksEvent(event: TasksEvent): void
}

export interface VaultManager {
  activate(vaultId: string): Promise<{ ok: true }>
  deactivate(): Promise<void>
  /** The active working dir — slice 2 points the PTY here. */
  workRootFor(vaultId: string): string
  setObserver(observer: VaultObserver): void
  activeVaultId(): string | null
  activeMirror(): VaultMirror | null
}

export function createVaultManager(deps: { store: SessionStore; dataDir?: string }): VaultManager {
  let current: { vaultId: string; mirror: VaultMirror; events: SseClient } | null = null
  let observer: VaultObserver | null = null

  const dataDir = () => deps.dataDir ?? app.getPath('userData')
  const workRootFor = (vaultId: string) => join(dataDir(), 'working-copies', vaultId)

  async function deactivate(): Promise<void> {
    if (!current) return
    const { vaultId, mirror, events } = current
    // the agent dies first: its open turns merge through a mirror that's still up
    await observer?.onDeactivating(vaultId)
    current = null
    events.stop()
    await mirror.stop()
  }

  async function activate(vaultId: string): Promise<{ ok: true }> {
    if (current?.vaultId === vaultId) return { ok: true }
    await deactivate()
    const session = deps.store.load()
    if (!session) throw new Error('not signed in')
    const client = createServerClient(() => deps.store.load()?.token ?? null)
    const workRoot = workRootFor(vaultId)
    const mirror = new VaultMirror({
      vaultId,
      workRoot,
      baseDir: join(dataDir(), 'vault-bases', vaultId),
      relayUrl: RELAY_URL,
      token: session.token,
      api: makeMirrorApi(client, vaultId),
      onTurnActivity: (n) => observer?.onTurnActivity(n),
      onMaterialize: (rel) => observer?.onMaterialize(rel),
    })
    const events = new SseClient({
      url: `${API_URL}/events/${vaultId}`,
      getToken: () => deps.store.load()?.token ?? null,
      onEvent: (channel, data) => {
        if (channel === 'docs') mirror.handleDocsEvent(data as DocsEvent)
        else if (channel === 'tasks') observer?.onTasksEvent(data as TasksEvent)
      },
      onReconnect: () => void mirror.refresh().catch((err) => console.error('[mirror] refresh failed:', err)),
    })
    await mirror.start()
    events.start()
    current = { vaultId, mirror, events }

    // managed files ride the adoption path: write what's missing, let the
    // watcher turn it into vault docs. Never fatal — the vault opens regardless.
    await ensureSeeded(workRoot, new Set(mirror.knownPaths())).catch((err) =>
      console.error('[vault] seeding failed:', err),
    )
    await observer?.onActivated(vaultId, mirror)
    return { ok: true }
  }

  return {
    activate,
    deactivate,
    workRootFor,
    setObserver: (next) => void (observer = next),
    activeVaultId: () => current?.vaultId ?? null,
    activeMirror: () => current?.mirror ?? null,
  }
}
