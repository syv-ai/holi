/**
 * Daily notes, renderer side (`docs/features/daily-notes.md`).
 *
 * Main does a deterministic if-not-exists-write, so two of your devices mint an
 * identical blob at an identical path and git merges them silently.
 *
 * This layer is the *mechanism* only: mint today's daily and land on it.
 * **Whether** to is `dailyNotes` in the vault's settings, asked by
 * `state/home.ts`, which is what lets ⌘⇧D still mint one on demand in a
 * vault that keeps no daily notes automatically.
 */
import { atom } from 'jotai'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom, loadSnapshotAtom } from './vaults'

/**
 * Mint today's daily if it is not there yet, and say where it is. Lands on
 * nothing: that is the caller's business.
 *
 * **Split from Home on purpose.** Minting is a property of `dailyNotes`, and
 * `home` only decides what you are looking at. Folded together, a vault whose
 * Home is its board would quietly stop journalling.
 */
export const ensureTodaysDailyAtom = atom(null, async (get, set): Promise<string | null> => {
  const remote = get(activeRemoteAtom)
  if (!remote) return null
  const { path, created } = await trpc.notes.getOrCreateDaily.mutate({ remote })
  if (created) await set(loadSnapshotAtom)
  return path
})
