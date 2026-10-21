/**
 * What each vault's repo weighs on GitHub, for its usage reading in the vault
 * picker and the sync panel (docs/features/vaults-sync.md, Repo size).
 *
 * Asked for when a reading mounts, at most once per remote per ten minutes:
 * GitHub recomputes the size on its own schedule, so asking more often learns
 * nothing. A refusal (offline, signed out) leaves the reading blank.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { trpc } from '@/lib/trpc'

const FRESH_MS = 10 * 60_000

const sizesAtom = atom<Record<string, number>>({})
/** When each remote was last asked, so a reopened menu does not ask again. */
const askedAt = new Map<string, number>()

/** The repo's size in KiB, or null until GitHub has answered. */
export function useRepoSize(remote: string | null): number | null {
  const sizes = useAtomValue(sizesAtom)
  const setSizes = useSetAtom(sizesAtom)
  useEffect(() => {
    if (remote === null) return
    const at = askedAt.get(remote)
    if (at !== undefined && Date.now() - at < FRESH_MS) return
    askedAt.set(remote, Date.now())
    trpc.github.repoSize
      .query({ remote })
      .then(({ sizeKb }) => setSizes((prev) => ({ ...prev, [remote]: sizeKb })))
      .catch((err: unknown) => {
        askedAt.delete(remote)
        console.warn('[repo-usage] no size:', err)
      })
  }, [remote, setSizes])
  return remote === null ? null : (sizes[remote] ?? null)
}
