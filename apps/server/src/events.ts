/**
 * The SSE stream — **one per signed-in user, carrying every vault they are in** (D50).
 *
 * It used to be one per *vault*, mounted at `/events/<vaultId>`, and that shape was the
 * cause of three separate bugs rather than a detail of them: a note a teammate created
 * could reach you, but a vault you were *invited to* had no channel to arrive on (the
 * switcher stayed stale until restart), and a reminder for a vault you did not have open
 * could not be delivered at all (D48). The connection's identity was a vaultId, so
 * anything that was about *you* rather than about one vault had nowhere to go.
 *
 * Two things follow from the inversion:
 *
 * 1. **Auth drops `resolveVaultRole`.** There is no vault in the URL to check a role
 *    against. Membership becomes a *subscription set* (`listVaultIdsForUser`) rather than
 *    an admission check — so 401 is the only rejection left; 403 has nothing to mean.
 *    Authorization itself is not broadened: `vaultProcedure`, `requireDocAccess` and the
 *    relay's `onAuthenticate` all still gate per vault.
 *
 * 2. **Every frame is an envelope, `{ vaultId, event }`.** None of the bus payloads
 *    carries a vaultId — the key `docs:<vaultId>` always supplied it — and widening them
 *    would mean touching each of the three hand-written client mirrors of each shape
 *    (the D36 trap). Multiplexing is a transport concern, so the transport labels the
 *    frame: the vault is a closure variable at subscribe time, which is also why the
 *    reminders watermark (D47) still keys on `(vaultId, userId)` unchanged.
 *
 * Plain SSE, not tRPC subscriptions, so the client authenticates with a normal
 * Authorization header over fetch.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listVaultIdsForUser } from './auth/membership'
import { resolveSession } from './auth/sessions'
import type {
  Bus,
  DocsEvent,
  MembershipEvent,
  PresenceEvent,
  RemindersEvent,
  TasksEvent,
} from './bus'
import type { Db } from './db/client'
import { markDelivered } from './reminders/delivery'
import { bearerToken } from './trpc'

const HEARTBEAT_MS = 25_000

export function makeEventsHandler(deps: { db: Db; bus: Bus }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = bearerToken(req)
    const user = token ? await resolveSession(deps.db, token) : null
    if (!user) {
      res.statusCode = 401
      return void res.end()
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const send = (channel: string, event: unknown) =>
      res.write(`event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`)

    /** vaultId -> teardown. The set is live: it grows and shrinks with membership. */
    const subs = new Map<string, () => void>()

    const subscribeVault = (vaultId: string): void => {
      if (subs.has(vaultId)) return // re-invite of an existing member, or a racing seed
      const onDocs = (e: DocsEvent) => void send('docs', { vaultId, event: e })
      const onTasks = (e: TasksEvent) => void send('tasks', { vaultId, event: e })
      // Sending *is* delivering, so the watermark advances here too (D47) — otherwise the
      // next catch-up would replay every fire this connection already showed the user.
      // `vaultId` is the closure variable, which is why multiplexing costs the ledger
      // nothing: it never has to demux the vault back out of a frame.
      const onReminders = (e: RemindersEvent) => {
        send('reminders', { vaultId, event: e })
        void markDelivered(deps.db, vaultId, user.id, e.firedAt).catch((err) =>
          console.error('[reminders] watermark advance failed:', err),
        )
      }
      const onPresence = (e: PresenceEvent) => void send('presence', { vaultId, event: e })
      deps.bus.on(`docs:${vaultId}`, onDocs)
      deps.bus.on(`tasks:${vaultId}`, onTasks)
      deps.bus.on(`reminders:${vaultId}`, onReminders)
      deps.bus.on(`presence:${vaultId}`, onPresence)
      subs.set(vaultId, () => {
        deps.bus.off(`docs:${vaultId}`, onDocs)
        deps.bus.off(`tasks:${vaultId}`, onTasks)
        deps.bus.off(`reminders:${vaultId}`, onReminders)
        deps.bus.off(`presence:${vaultId}`, onPresence)
      })
    }

    const unsubscribeVault = (vaultId: string): void => {
      subs.get(vaultId)?.()
      subs.delete(vaultId)
    }

    for (const vaultId of await listVaultIdsForUser(deps.db, user.id)) subscribeVault(vaultId)

    // The whole reason a user-scoped stream works (D51). Resolving the vault set once at
    // connect would be wrong the moment you were invited somewhere: the new vault's frames
    // would go to a key nobody is listening on, and the switcher would be exactly as stale
    // as it was before. So the set is re-keyed live.
    //
    // The vaultId is lifted out of the payload and into the envelope, so the wire stays
    // uniform across all five channels — this is the one channel whose key names a user,
    // so it is the one whose payload has to carry the vault (see MembershipEvent).
    const onMembership = (e: MembershipEvent) => {
      if (e.type === 'joined') subscribeVault(e.vaultId)
      else unsubscribeVault(e.vaultId)
      send('membership', { vaultId: e.vaultId, event: { type: e.type } })
    }
    deps.bus.on(`user:${user.id}`, onMembership)

    const heartbeat = setInterval(() => res.write(':hb\n\n'), HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      // easy to add the `on` and forget the `off` — and `setMaxListeners(0)` means the
      // leak raises no warning. It is a loop now, over a set that changed while the
      // connection was open, so "the vaults it opened with" is not the right list.
      deps.bus.off(`user:${user.id}`, onMembership)
      for (const teardown of subs.values()) teardown()
      subs.clear()
    })
  }
}
