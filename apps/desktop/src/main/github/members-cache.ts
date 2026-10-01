/**
 * A vault's collaborators, reused for a few minutes.
 *
 * One cache for every reader: an app's `holi.members()`, `holi vault members`, and
 * Settings' member list. An app polling it must not spend the GitHub rate
 * limit, and Settings opening twice should not ask twice. What the person may
 * *do* (visibility, `canAdmin`, whether the vault is gone) is never read from
 * here: those decide a destructive dialog and are always asked fresh.
 *
 * No `electron` import: the tests hand in a fake fetch and clock.
 */
import type { Collaborator } from '@holi/shared'

/** Long enough that an app polling it does not spend the GitHub rate limit,
 *  short enough that an invite shows. */
export const MEMBERS_TTL_MS = 10 * 60 * 1000

export interface MembersCache {
  /** The collaborators, cached per remote. Rejects on a GitHub error, which is not cached. */
  get(remote: string): Promise<Collaborator[]>
  /** Drop one vault's list, or every list (a sign-out: another account sees another list). */
  forget(remote?: string): void
}

export function createMembersCache(
  fetch: (remote: string) => Promise<Collaborator[]>,
  now: () => number = Date.now,
): MembersCache {
  const lists = new Map<string, { at: number; list: Promise<Collaborator[]> }>()
  return {
    get: (remote) => {
      const cached = lists.get(remote)
      if (cached !== undefined && now() - cached.at < MEMBERS_TTL_MS) return cached.list
      const list = fetch(remote)
      const entry = { at: now(), list }
      lists.set(remote, entry)
      // A failure is not cached: the next call asks GitHub again. Only this
      // entry goes, not a newer one a `forget` let in meanwhile.
      list.catch(() => {
        if (lists.get(remote) === entry) lists.delete(remote)
      })
      return list
    },
    forget: (remote) => {
      if (remote === undefined) lists.clear()
      else lists.delete(remote)
    },
  }
}
