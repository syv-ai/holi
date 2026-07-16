/** One active vault at a time (spec §Session lifecycle): activate tears down
 * the previous vault's mirror and starts the next. Working copies live under
 * userData/working-copies/<vaultId>; frozen bases under userData/vault-bases/<vaultId>.
 *
 * The event stream is NOT part of that lifecycle any more. It is one connection per
 * signed-in *user* (D50), owned by `main/events/user-stream.ts` and started at sign-in —
 * it must survive a vault switch, so nothing here may construct or tear it down. What
 * remains here is `handleEnvelope`: the dispatcher that decides which frames are about
 * the vault on screen. */
import { join } from 'node:path'
import type { Task } from '@holi/shared'
import { app } from 'electron'
import { ensureSeeded } from '../agent/seed-content'
import { RELAY_URL, createServerClient } from '../server-client'
import type { SessionStore } from '../session'
import { makeMirrorApi } from './mirror-api'
import { ProjectionStore } from './projection-store'
import { makeTaskApi } from './task-api'
import { TaskProjector } from './task-projector'
import { VaultMirror, type DocsEvent } from './vault-mirror'
import type { RemindersEvent } from '../reminders/types'

/** Mirrors the server bus's TasksEvent shape (apps/server/src/bus.ts).
 *
 * Do NOT widen this union — not for presence, not for anything (D36). It is read as
 * `if (upserted) … else remove(taskId)`, so a third variant falls into the `else` and
 * deletes the task's FILE. Presence is a sibling channel for exactly that reason. */
export type TasksEvent =
  | { type: 'upserted'; task: Task }
  | { type: 'deleted'; taskId: string }

/** The `presence` SSE frame (apps/server/src/bus.ts). A short-TTL heartbeat: the entry
 * expires on its own and there is no "stopped editing" event — a heartbeat that stops
 * arriving *is* the release. There is deliberately no `actor` field: a user and their
 * agent are one identity (D37). */
export type PresenceEvent = {
  taskId: string
  userId: string
  name: string
  expiresAt: string
}

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
  /** Route one frame off the user stream. See the implementation for D52's rule. */
  handleEnvelope(channel: string, vaultId: string, event: unknown): void
  /** A stream gap: re-read whatever holds local state (the active vault only). */
  handleReconnect(): void
  /** The active working dir — slice 2 points the PTY here. */
  workRootFor(vaultId: string): string
  setObserver(observer: VaultObserver): void
  activeVaultId(): string | null
  activeMirror(): VaultMirror | null
}

export function createVaultManager(deps: {
  store: SessionStore
  dataDir?: string
  /** Push to the renderer. The one SSE connection lives in main — one per signed-in
   * user (D50) — and the board and tree are fed from it. The renderer must never open
   * a second stream. */
  send?: (channel: string, payload: unknown) => void
  /** Raise fired reminders, for ANY vault — not just the active one (D48/D52). Injected
   * so this module stays free of `Notification` (the `getWindow` pattern — it has to
   * load under vitest). */
  onReminders?: (vaultId: string, event: RemindersEvent) => void
}): VaultManager {
  let current: {
    vaultId: string
    mirror: VaultMirror
    projector: TaskProjector
  } | null = null
  let observer: VaultObserver | null = null

  const dataDir = () => deps.dataDir ?? app.getPath('userData')
  const workRootFor = (vaultId: string) => join(dataDir(), 'working-copies', vaultId)

  async function deactivate(): Promise<void> {
    if (!current) return
    const { vaultId, mirror, projector } = current
    // the agent dies first: its open turns merge through a mirror that's still up
    await observer?.onDeactivating(vaultId)
    current = null
    projector.stop() // halt its periodic reconcile before the mirror goes down
    await mirror.stop()
    // The stream is NOT stopped here — it belongs to the session, not the vault.
  }

  /**
   * One frame off the user stream, routed. This is where D52 lives.
   *
   * `reminders` and `membership` are **not** filtered by vault, and that is the whole
   * point of the stream being user-scoped: a reminder for a vault you do not have open is
   * precisely what D48 could not deliver, and being added to a vault is not about any
   * vault you already have. Transporting them user-scoped only to drop them here would
   * be pointless.
   *
   * `docs` / `tasks` / `presence` are filtered to the active vault, because the renderer
   * holds exactly one tree and one board, and `mirror`/`projector` are constructed inside
   * `activate` and close over one vault. This is not a nicety: `applyTasksEvent` reads its
   * union as `if (upserted) … else remove(taskId)`, so a frame from *another* vault
   * falling through would **delete a task's file** — D36's trap, reached by a new road.
   * Filtering here also keeps `tasks:event`/`tasks:presence` bare-payload and unchanged,
   * so the board carries no regression risk from this slice.
   */
  function handleEnvelope(channel: string, vaultId: string, event: unknown): void {
    if (channel === 'reminders') return void deps.onReminders?.(vaultId, event as RemindersEvent)
    if (channel === 'membership') {
      const { type } = event as { type: 'joined' | 'left' }
      return void deps.send?.('vaults:event', { vaultId, type })
    }
    if (!current || current.vaultId !== vaultId) return
    const { mirror, projector } = current
    if (channel === 'docs') {
      const docsEvent = event as DocsEvent
      mirror.handleDocsEvent(docsEvent) // the on-disk working copy
      deps.send?.('docs:event', docsEvent) // the file tree — until now this never happened
    } else if (channel === 'tasks') {
      const tasksEvent = event as TasksEvent
      void projector
        .applyTasksEvent(tasksEvent)
        .catch((err) => console.error('[tasks] projection failed:', err))
      observer?.onTasksEvent(tasksEvent)
      deps.send?.('tasks:event', tasksEvent) // the board
    } else if (channel === 'presence') {
      // Forwarded verbatim — main does not reshape it, and does not track it (the server
      // is stateless about presence and so are we; the entry expires).
      deps.send?.('tasks:presence', event as PresenceEvent)
    }
  }

  /**
   * A gap in the stream means we missed events, and tasks are not self-healing: nothing
   * else re-reads them, so without this a reconnected app shows stale task files (missed
   * upserts, deletes, recurrence rolls) until it is restarted — and a task file edited
   * while we were disconnected never reaches the record. Both halves reconcile
   * independently; a failure in one must not take out the other.
   *
   * Only the active vault: it is the only one with a mirror or a projector. Another
   * vault's state is fetched fresh when you open it, so there is nothing stale to fix.
   */
  function handleReconnect(): void {
    if (!current) return
    const { mirror, projector } = current
    void mirror.refresh().catch((err) => console.error('[mirror] refresh failed:', err))
    void projector.reconcile().catch((err) => console.error('[tasks] reconcile failed:', err))
  }

  async function activate(vaultId: string): Promise<{ ok: true }> {
    if (current?.vaultId === vaultId) return { ok: true }
    await deactivate()
    const session = deps.store.load()
    if (!session) throw new Error('not signed in')
    const client = createServerClient(() => deps.store.load()?.token ?? null)
    const workRoot = workRootFor(vaultId)

    // Tasks are records, not CRDT docs: the projector owns tasks/**, fed from
    // tasks.list + the SSE tasks channel rather than the relay, and the mirror
    // hands it every task-file disk event instead of adopting them as docs.
    const projector = new TaskProjector({
      workRoot,
      store: new ProjectionStore(join(dataDir(), 'task-projections', vaultId)),
      api: makeTaskApi(client, vaultId),
      notePathFor: (docId) => mirror.pathForDocId(docId) ?? undefined,
      docIdForPath: (path) => mirror.docIdForPath(path) ?? undefined,
    })

    const mirror = new VaultMirror({
      vaultId,
      workRoot,
      baseDir: join(dataDir(), 'vault-bases', vaultId),
      relayUrl: RELAY_URL,
      token: session.token,
      api: makeMirrorApi(client, vaultId),
      onTurnActivity: (n) => observer?.onTurnActivity(n),
      onMaterialize: (rel) => observer?.onMaterialize(rel),
      onTaskFileEvent: (kind, rel) =>
        void projector
          .onTaskFileEvent(kind, rel)
          .catch((err) => console.error('[tasks] inbound failed:', err)),
    })
    await mirror.start()
    // after the mirror, so note paths resolve for related[] / area rendering
    await projector.start().catch((err) => console.error('[tasks] projection failed:', err))
    // No stream to start, and no reminder catch-up to run: the user stream is already up
    // and has been carrying this vault all along, whether or not it was on screen. That
    // per-activation catch-up existed only because the connection did not outlive the
    // vault — the workaround D48 forced, and it dissolves with the cause.
    current = { vaultId, mirror, projector }

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
    handleEnvelope,
    handleReconnect,
    workRootFor,
    setObserver: (next) => void (observer = next),
    activeVaultId: () => current?.vaultId ?? null,
    activeMirror: () => current?.mirror ?? null,
  }
}
