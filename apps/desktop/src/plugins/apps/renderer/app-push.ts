/**
 * What a running vault app is told has changed, as signatures.
 *
 * `AppFrame` posts a topic to its frame whenever that topic's signature
 * changes, so a rescan that changed nothing says nothing. Kept here, derived
 * once for the vault, rather than in each frame: every open app would
 * otherwise recompute the same thing on every snapshot.
 *
 * A push carries no data (the app reads again through main, where every
 * refusal lives), but its timing still says something happened, so the
 * signatures leave the agent surface out: an app is not told a memory was
 * written.
 */
import { atom } from 'jotai'
import { isAgentSurfacePath, type VaultSnapshot } from '@holi/shared'
import { storeTopic } from '../shared/bridge'
import {
  agentSessionRowsAtom,
  historyEpochsAtom,
  recentsAtom,
  snapshotAtom,
  syncStateAtom,
} from '@/plugin-api'

/** The vault-wide topics: docs, tasks, sync, agent, recents, history. */
export const appPushSignaturesAtom = atom((get): Record<string, string> => {
  const snapshot = get(snapshotAtom)
  const epochs = get(historyEpochsAtom)
  const visible = Object.entries(epochs.byPath).filter(([p]) => !isAgentSurfacePath(p))
  return {
    docs: snapshot.docs
      .filter((d) => !isAgentSurfacePath(d.path))
      .map((d) => `${d.path}@${d.updatedAt}`)
      .join('\n'),
    tasks: JSON.stringify(snapshot.tasks),
    sync: JSON.stringify(get(syncStateAtom)),
    agent: JSON.stringify(get(agentSessionRowsAtom)),
    recents: JSON.stringify(get(recentsAtom)),
    history: `${epochs.all}:${visible.map(([p, n]) => `${p}=${n}`).join(',')}`,
  }
})

/** One `store:<collection>` signature per collection in `bundle`'s `data/`. */
export function storeSignatures(snapshot: VaultSnapshot, bundle: string): Record<string, string> {
  const prefix = `${bundle}/data/`
  const byCollection: Record<string, string[]> = {}
  for (const f of snapshot.files) {
    if (!f.path.startsWith(prefix)) continue
    const [collection] = f.path.slice(prefix.length).split('/')
    if (collection === undefined) continue
    ;(byCollection[collection] ??= []).push(`${f.path}@${f.updatedAt}`)
  }
  return Object.fromEntries(
    Object.entries(byCollection).map(([c, files]) => [storeTopic(c), files.join('\n')]),
  )
}
