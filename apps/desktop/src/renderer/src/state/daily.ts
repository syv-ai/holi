/**
 * Daily notes, client side — resolve *this device's* date, ask the server for today's
 * note, land on it.
 *
 * The correctness boundary is the server's unique `(vault_id, path)` index, not anything
 * here (D45). The in-flight cache below only coalesces redundant call sites into one
 * round-trip; if it were removed entirely the feature would still be correct, just
 * chattier. That is the opposite of the old repo, where a per-process promise cache was
 * the *only* thing standing between you and a duplicate note — and it could not see your
 * other laptop.
 */
import { atom } from 'jotai'
import type { DocMeta } from '@holi/shared'
import { trpc } from '../lib/trpc'
import { activeDocAtom, activeVaultIdAtom, loadDocsAtom, vaultsAtom } from './vaults'

/**
 * This device's local date as `YYYY-MM-DD`.
 *
 * **Not** `toISOString()`: that formats UTC, so for anyone east of it between local
 * midnight and UTC midnight it returns *yesterday* — and you would land on (and mint)
 * the wrong note. The old repo's `toIsoDate` read the local getters for exactly this
 * reason. `shared/dates.ts`'s `formatDate` is UTC-based and is for epoch math, not for
 * asking a device what day it is.
 */
export function localIsoDate(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, '0')
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The date is in the key so a session spanning local midnight asks for tomorrow's note
 * rather than serving yesterday's from cache (ported intent). */
export const dailyCacheKey = (vaultId: string, localDate: string): string =>
  `${vaultId}/${localDate}`

const inflight = new Map<string, Promise<DocMeta>>()

/**
 * Get-or-create today's daily note for the active vault and open it. Resolves to null
 * when there is nothing to do (no vault, a shared vault, or the server is unreachable).
 *
 * Personal-vault only, by design: with a single owner there is exactly one author and
 * one clock, so there is no one to race and no second timezone to disagree with.
 */
export const openTodaysDailyNoteAtom = atom(null, async (get, set): Promise<DocMeta | null> => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return null
  const vault = get(vaultsAtom).find((v) => v.id === vaultId)
  if (vault?.kind !== 'personal') return null

  const localDate = localIsoDate()
  const key = dailyCacheKey(vaultId, localDate)

  let pending = inflight.get(key)
  if (!pending) {
    pending = trpc.notes.getOrCreateDaily
      .mutate({ vaultId, localDate })
      .then(async ({ doc, created }) => {
        // Only a mint changes the tree; an adoption is already in it.
        if (created) await set(loadDocsAtom)
        return doc
      })
      .catch((err: unknown) => {
        // Drop the entry so the next activation retries, rather than handing every
        // future caller the same stale rejection forever (ported fix).
        inflight.delete(key)
        throw err
      })
    inflight.set(key, pending)
  }

  try {
    const doc = await pending
    set(activeDocAtom, doc)
    return doc
  } catch (err) {
    // Offline or server error: land on nothing and carry on (D45). A missing daily note
    // is a non-event — you get it on reconnect, and nothing was lost because there was
    // nothing in it yet.
    console.warn('[daily] could not open today’s note:', err)
    return null
  }
})

/** Archive prior-day notes + GC stubs. Fire-and-forget: it must never block landing on
 * today's note, and it is idempotent, so a failure just retries next activation. */
export const sweepDailyNotesAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const vault = get(vaultsAtom).find((v) => v.id === vaultId)
  if (vault?.kind !== 'personal') return
  try {
    const { archived, deleted } = await trpc.notes.sweepDaily.mutate({
      vaultId,
      localDate: localIsoDate(),
    })
    // Notes moved into journal/ or reaped — the tree on screen is now stale.
    if (archived > 0 || deleted > 0) await set(loadDocsAtom)
  } catch (err) {
    console.warn('[daily] sweep failed (retries next activation):', err)
  }
})
