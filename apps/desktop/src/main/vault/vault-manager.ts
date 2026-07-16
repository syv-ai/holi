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
import { ProjectionStore } from './projection-store'
import { SseClient } from './sse-client'
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
  /** The active working dir — slice 2 points the PTY here. */
  workRootFor(vaultId: string): string
  setObserver(observer: VaultObserver): void
  activeVaultId(): string | null
  activeMirror(): VaultMirror | null
}

export function createVaultManager(deps: {
  store: SessionStore
  dataDir?: string
  /** Push to the renderer. The SSE connection lives HERE, in main — one per vault —
   * and the board is fed from it. The renderer must never open a second stream. */
  send?: (channel: string, payload: unknown) => void
  /** Raise fired reminders. Injected so this module stays free of `Notification`
   * (the `getWindow` pattern — it has to load under vitest). */
  onReminders?: (event: RemindersEvent) => void
}): VaultManager {
  let current: {
    vaultId: string
    mirror: VaultMirror
    events: SseClient
    projector: TaskProjector
  } | null = null
  let observer: VaultObserver | null = null

  const dataDir = () => deps.dataDir ?? app.getPath('userData')
  const workRootFor = (vaultId: string) => join(dataDir(), 'working-copies', vaultId)

  async function deactivate(): Promise<void> {
    if (!current) return
    const { vaultId, mirror, events, projector } = current
    // the agent dies first: its open turns merge through a mirror that's still up
    await observer?.onDeactivating(vaultId)
    current = null
    events.stop()
    projector.stop() // halt its periodic reconcile before the mirror goes down
    await mirror.stop()
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
    const events = new SseClient({
      url: `${API_URL}/events/${vaultId}`,
      getToken: () => deps.store.load()?.token ?? null,
      onEvent: (channel, data) => {
        if (channel === 'docs') mirror.handleDocsEvent(data as DocsEvent)
        else if (channel === 'tasks') {
          const event = data as TasksEvent
          void projector
            .applyTasksEvent(event)
            .catch((err) => console.error('[tasks] projection failed:', err))
          observer?.onTasksEvent(event)
          deps.send?.('tasks:event', event) // the board
        } else if (channel === 'reminders') {
          // Until now this frame arrived and was dropped on the floor — the same bug
          // the comment below records for presence, and the reason a reminder you set
          // never reached you. The server owns scheduling; main only raises it.
          deps.onReminders?.(data as RemindersEvent)
        } else if (channel === 'presence') {
          // Until the board existed this frame arrived and was dropped on the floor.
          // Nothing in main wants it: presence is a UI concern end to end. It is
          // forwarded verbatim — main does not reshape it, and does not track it
          // (the server is stateless about presence and so are we; the entry expires).
          deps.send?.('tasks:presence', data as PresenceEvent)
        }
      },
      // A gap in the stream means we missed events, and tasks are not self-healing:
      // nothing else re-reads them, so without this a reconnected app shows stale task
      // files (missed upserts, deletes, recurrence rolls) until it is restarted — and a
      // task file edited while we were disconnected never reaches the record. Both
      // halves reconcile independently; a failure in one must not take out the other.
      onReconnect: () => {
        void mirror.refresh().catch((err) => console.error('[mirror] refresh failed:', err))
        void projector.reconcile().catch((err) => console.error('[tasks] reconcile failed:', err))
        void catchUpReminders()
      },
    })

    /** Raise fires that landed while we weren't listening. Joins the self-healing the
     * mirror and projector already do on a stream gap — a reminder missed during the
     * gap is exactly as lost as a missed task upsert, and the server has kept it. */
    const catchUpReminders = async () => {
      try {
        const missed = await client.reminders.catchUp.mutate({ vaultId })
        if (missed) deps.onReminders?.(missed)
      } catch (err) {
        console.error('[reminders] catch-up failed:', err)
      }
    }
    await mirror.start()
    // after the mirror, so note paths resolve for related[] / area rendering
    await projector.start().catch((err) => console.error('[tasks] projection failed:', err))
    events.start()
    // After the stream is up, never before: a fire landing in the gap would be missed by
    // a catch-up that already ran and by a stream not yet listening. This order can at
    // worst show one twice — and the server advances the watermark on live sends, so in
    // practice it won't. Duplicates beat silence.
    void catchUpReminders()
    current = { vaultId, mirror, events, projector }

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
