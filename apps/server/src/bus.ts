/** Typed in-process event bus feeding the (S) SSE subscriptions. Single-node
 * by design — multi-node needs shared pub/sub (PRD: open, post-v1). */
import { EventEmitter } from 'node:events'
import type { DocMeta, Task } from '@holi/shared'

export type DocsEvent = { type: 'created' | 'renamed' | 'deleted'; doc: DocMeta }
export type TasksEvent = { type: 'upserted'; task: Task } | { type: 'deleted'; taskId: string }
/** `fireAt` is the *scheduled local wall-clock* time, for display. It is not an
 * instant — never compute with it (D47: the delivery watermark runs on `firedAt`). */
export type ReminderFire = { taskId: string; title: string; fireAt: string }
export type RemindersEvent = {
  fires: ReminderFire[]
  coalesced: boolean
  /** The instant this batch fired (ISO UTC) — every fire in a tick shares it. What
   * the per-user delivery watermark advances on, live and on catch-up (D47). */
  firedAt: string
}

/**
 * "Nicolai is editing this task" (prd/tasks.md §Concurrency: presence, not locks).
 *
 * Its own channel, deliberately NOT a third `TasksEvent` variant: the desktop's
 * TaskProjector reads that union as `if (upserted) … else remove(event.taskId)`, so a
 * new variant would fall into the `else` and **delete the task's file**. It rides the
 * same per-vault SSE connection, which is what the PRD is actually asking for.
 *
 * Fire-and-forget and server-stateless: we stamp an expiry and emit, storing nothing.
 * That is the whole reason locks were rejected — there is no acquire, no release, no
 * TTL sweep, no stale holder from a crashed client, and no steal path. A heartbeat
 * that stops arriving *is* the release.
 *
 * D37 — **a user and their agent are ONE identity.** There is deliberately no
 * `actor: 'user' | 'agent'` here, and adding one would be a mistake. The agent runs on
 * the user's token, on the user's behalf, because the user set it going: "Nicolai is
 * editing this task" is *true* when Nicolai's Claude is editing it. (The drawer's
 * "Claude is editing…" answers a different question — it tells YOU what YOUR OWN agent
 * is doing to a doc in front of you. Presence tells SOMEONE ELSE that a task is in
 * motion, and for that the distinction is noise.)
 */
export type PresenceEvent = {
  taskId: string
  userId: string
  name: string
  /** ISO. Clients drop the entry when it passes; nobody has to send a "stopped". */
  expiresAt: string
}

/**
 * You joined or left a vault (D51) — the one event that is about a *person*, not a vault.
 *
 * Every other channel is keyed `<channel>:<vaultId>`, which is exactly why the switcher
 * went stale: "you were added to a vault" has no vault you are already listening to, so
 * it had nowhere to arrive. The user-scoped stream resolves your vaults at connect and
 * would be wrong the moment you were invited; this is what lets it re-key a live
 * connection instead.
 *
 * **No `vaultId` here on purpose** — the SSE envelope carries it (D50), and a payload
 * that repeats it is a second copy that can disagree with the first.
 */
export type MembershipEvent = { type: 'joined' | 'left' }

export class Bus extends EventEmitter {
  emitDocs(vaultId: string, event: DocsEvent): void {
    this.emit(`docs:${vaultId}`, event)
  }
  emitTasks(vaultId: string, event: TasksEvent): void {
    this.emit(`tasks:${vaultId}`, event)
  }
  emitPresence(vaultId: string, event: PresenceEvent): void {
    this.emit(`presence:${vaultId}`, event)
  }
  emitReminders(vaultId: string, event: RemindersEvent): void {
    this.emit(`reminders:${vaultId}`, event)
  }
  /** Keyed by *user*, not vault — see MembershipEvent. Must be emitted only after the
   * membership row's transaction commits: the bus has no transactional semantics, so an
   * emit inside a tx announces a membership that can still roll back. */
  emitMembership(userId: string, event: MembershipEvent): void {
    this.emit(`user:${userId}`, event)
  }
  /** Wake the evaluator loop after any reminder-affecting mutation. */
  wakeEvaluator(): void {
    this.emit('evaluator:wake')
  }
}

export function createBus(): Bus {
  const bus = new Bus()
  bus.setMaxListeners(0)
  return bus
}
