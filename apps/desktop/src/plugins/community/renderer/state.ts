/**
 * What the renderer knows of community plugins in the open vault: the rows
 * main lists (`community.list`), each file's server as main reports it, and
 * each setup's output while it runs.
 *
 * The rows are read when the vault opens and again whenever a pin or the
 * plugins settings change on disk (a teammate's pull, a hand edit, the
 * settings tab's own write), so the claim follows what the vault says. So do
 * the agent's commands: main links them again then.
 */
import { atom } from 'jotai'
import { PLUGIN_PINS_DIR, PLUGINS_FILE, PLUGINS_LOCAL_FILE, servedFile } from '@holi/shared'
import { capClient, snapshotAtom, type PluginStore } from '@/plugin-api'
import type { communityCapabilities, PluginRow } from '../main/capabilities'
import type { ServerState } from '../main/supervisor'

export type { PluginRow, ServerState }

export const communityCap = capClient<ReturnType<typeof communityCapabilities>>('community')

/** The open vault's rows, with the vault they were read for. */
export const rowsAtom = atom<{ remote: string; rows: readonly PluginRow[] } | null>(null)

/** Each file's server, by vault path, as the last `server` event said. */
export const serversAtom = atom<Readonly<Record<string, ServerState>>>({})

/** A newer release of each plugin installed here from one, by id. */
export const updatesAtom = atom<Readonly<Record<string, string>>>({})

/** Ask whether newer releases exist (`fresh` skips main's hourly cache). */
export async function refreshUpdates(
  remote: string,
  store: PluginStore,
  fresh = false,
): Promise<void> {
  try {
    store.set(updatesAtom, await communityCap.updates(remote, { fresh }))
  } catch (err) {
    console.error('[community] updates:', err)
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
  try {
    const rows = await communityCap.list(remote)
    store.set(rowsAtom, { remote, rows })
  } catch (err) {
    console.error('[community] list:', err)
  }
}

/**
 * Link the agent's commands for what runs in `remote` now, and say what of
 * plugin `id`'s it could not add, or null when nothing.
 */
export async function linkCommandsFor(remote: string, id: string): Promise<string | null> {
  const { refused, error } = await communityCap.commands(remote)
  if (error !== undefined) return `The agent's commands could not be updated: ${error}`
  const mine = refused.filter((r) => r.id === id)
  if (mine.length === 0) return null
  return mine.map((r) => `${r.name} is not on the agent's PATH: ${r.reason}.`).join(' ')
}

/** What on disk decides the rows: the pins and the two plugins files. */
const signatureAtom = atom((get) =>
  get(snapshotAtom)
    .files.filter(
      (f) =>
        f.path.startsWith(`${PLUGIN_PINS_DIR}/`) ||
        f.path === PLUGINS_FILE ||
        f.path === PLUGINS_LOCAL_FILE,
    )
    .map((f) => `${f.path}@${f.updatedAt}`)
    .join('|'),
)

/** Keep the rows of `remote` current while it is open. */
export function followRows(remote: string, store: PluginStore): () => void {
  void refreshRows(remote, store)
  void refreshUpdates(remote, store)
  // A vault left open all day still hears of a release.
  const hourly = setInterval(() => void refreshUpdates(remote, store), 60 * 60 * 1000)
  let last = store.get(signatureAtom)
  const undo = store.sub(signatureAtom, () => {
    const next = store.get(signatureAtom)
    if (next === last) return
    last = next
    void communityCap
      .commands(remote)
      .catch((err: unknown) => console.error('[community] commands:', err))
    void refreshRows(remote, store)
  })
  return () => {
    clearInterval(hourly)
    undo()
    store.set(rowsAtom, null)
    store.set(serversAtom, {})
    store.set(updatesAtom, {})
  }
}
