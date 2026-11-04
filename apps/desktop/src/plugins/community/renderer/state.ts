/**
 * What the renderer knows of community plugins in the open vault: the rows
 * main lists (`community.list`), each file's server as main reports it, and
 * each setup's output while it runs.
 *
 * The rows are read when the vault opens and again whenever a pin or the
 * plugins settings change on disk (a teammate's pull, a hand edit, the
 * settings tab's own write), so the claim follows what the vault says, and
 * once more when main has linked the agent's commands after such a change.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { communityPluginsSignature, servedFile } from '@holi/shared'
import { activeRemoteAtom, snapshotAtom, type PluginStore } from '@/plugin-api'
import { communityCap } from './community-cap'
import type { PluginRow } from '../main/capabilities'
import type { ServerState } from '../main/supervisor'

export type { PluginRow, ServerState }

/** The open vault's rows, with the vault they were read for. */
export const rowsAtom = atom<{ remote: string; rows: readonly PluginRow[] } | null>(null)

/**
 * The plugins whose vault notice this machine dismissed, as ids by vault.
 * By id, not by pin, so a newer version the vault pins stays dismissed while
 * the plugin has not run here; once it is ready here the vault notice drops
 * its dismissal, so a later pin it cannot run yet shows again. Kept
 * in `localStorage` as the tree's other per-vault view choices are: it hides a
 * line on this machine, and the vault's files, which its members share, are
 * left alone. Settings still lists the plugin and installs it.
 */
export const dismissedNoticesAtom = atomWithStorage<Readonly<Record<string, readonly string[]>>>(
  'holi:community:dismissedNotices',
  {},
)

/** Each file's server, by vault path, as the last `server` event said. */
export const serversAtom = atom<Readonly<Record<string, ServerState>>>({})

/** A newer release of each plugin installed here from one, by id. */
export const updatesAtom = atom<Readonly<Record<string, string>>>({})

/** A monotonically fenced request lifetime for one Jotai store. */
const requestFences = new WeakMap<
  PluginStore,
  { lifetime: number; rows: number; updates: number }
>()

function fenceFor(store: PluginStore) {
  let fence = requestFences.get(store)
  if (!fence) {
    fence = { lifetime: 0, rows: 0, updates: 0 }
    requestFences.set(store, fence)
  }
  return fence
}

function current(store: PluginStore, remote: string, lifetime: number): boolean {
  return store.get(activeRemoteAtom) === remote && fenceFor(store).lifetime === lifetime
}

/** Ask whether newer releases exist (`fresh` skips main's hourly cache). */
export async function refreshUpdates(
  remote: string,
  store: PluginStore,
  fresh = false,
): Promise<void> {
  const fence = fenceFor(store)
  const lifetime = fence.lifetime
  const request = ++fence.updates
  try {
    const updates = await communityCap.updates(remote, { fresh })
    if (current(store, remote, lifetime) && fenceFor(store).updates === request) {
      store.set(updatesAtom, updates)
    }
  } catch (err) {
    if (current(store, remote, lifetime) && fenceFor(store).updates === request) {
      console.error('[community] updates:', err)
    }
  }
}

/** Each plugin's setup output, by id, since its setup last began. */
export const setupLogsAtom = atom<Readonly<Record<string, readonly string[]>>>({})

/** The plugin that opens `path` (a file, or a folder document) in the open
 *  vault now, if any. */
export function servingRow(rows: readonly PluginRow[], path: string): PluginRow | null {
  return rows.find((r) => r.running && servedFile(r, path) !== null) ?? null
}

/** Read the rows for `remote` again. */
export async function refreshRows(remote: string, store: PluginStore): Promise<void> {
  const fence = fenceFor(store)
  const lifetime = fence.lifetime
  const request = ++fence.rows
  try {
    const rows = await communityCap.list(remote)
    if (current(store, remote, lifetime) && fenceFor(store).rows === request) {
      store.set(rowsAtom, { remote, rows })
    }
  } catch (err) {
    if (current(store, remote, lifetime) && fenceFor(store).rows === request) {
      console.error('[community] list:', err)
    }
  }
}

/** What on disk decides the rows: the pins and the two plugins files. */
const signatureAtom = atom((get) => communityPluginsSignature(get(snapshotAtom).files))

/** Keep the rows of `remote` current while it is open. */
export function followRows(remote: string, store: PluginStore): () => void {
  const fence = fenceFor(store)
  const lifetime = ++fence.lifetime
  void refreshRows(remote, store)
  void refreshUpdates(remote, store)
  // A vault left open all day still hears of a release.
  const hourly = setInterval(() => void refreshUpdates(remote, store), 60 * 60 * 1000)
  let last = store.get(signatureAtom)
  const undo = store.sub(signatureAtom, () => {
    const next = store.get(signatureAtom)
    if (next === last) return
    last = next
    void refreshRows(remote, store)
  })
  return () => {
    const ownsLifetime = fenceFor(store).lifetime === lifetime
    if (ownsLifetime) fenceFor(store).lifetime++
    clearInterval(hourly)
    undo()
    if (ownsLifetime) {
      store.set(rowsAtom, null)
      store.set(serversAtom, {})
      store.set(updatesAtom, {})
    }
  }
}
