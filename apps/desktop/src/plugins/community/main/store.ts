/**
 * The community plugins installed on this machine (docs/features/community-plugins.md).
 *
 * One install per plugin id, in `userData/plugins/`: a release's code in
 * `<id>/<commit>/`, or a developer's own folder used in place. Never in a
 * vault: a plugin's `node_modules` would be scanned by the watcher, and the
 * `.local.` rule cannot keep a folder of code off the vault's history.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { join } from 'node:path'
import { parsePluginManifest, type PluginManifest } from '@holi/shared'
import { jsonFileStore } from '../../../main/plugin-api'

/** Where an install's code came from. */
export type InstallSource =
  | { kind: 'release'; repo: string; tag: string; commit: string }
  /** A folder the person works on: used in place, never fetched or pinned. */
  | { kind: 'dev'; folder: string }

/** How the manifest's `setup` went for this install. */
export type SetupState = 'none' | 'ok' | 'failed'

export interface Install {
  id: string
  source: InstallSource
  manifest: PluginManifest
  setup: SetupState
}

export interface InstallStore {
  list(): Promise<Install[]>
  get(id: string): Promise<Install | null>
  /** Record `install`, replacing any install of the same id. */
  put(install: Install): Promise<void>
  setSetup(id: string, setup: SetupState): Promise<void>
  remove(id: string): Promise<Install | null>
  /** Where an install's code is. */
  codeDir(install: Pick<Install, 'id' | 'source'>): string
  /** The folder a release of `id` at `commit` is unpacked into. */
  releaseDir(id: string, commit: string): string
  /** Where setup's output for the install of `id` is kept. */
  setupLog(id: string): string
}

/** `userData/plugins`, given `userData`. */
export const pluginsDir = (userData: string): string => join(userData, 'plugins')

function parseInstalls(raw: unknown): Install[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): Install[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const { id, source, manifest, setup } = entry as Record<string, unknown>
    const parsed = parsePluginManifest(manifest)
    if (typeof id !== 'string' || !parsed.ok || parsed.value.id !== id) return []
    const s = source as Record<string, unknown> | null
    let src: InstallSource
    if (s?.kind === 'dev' && typeof s.folder === 'string') src = { kind: 'dev', folder: s.folder }
    else if (
      s?.kind === 'release' &&
      typeof s.repo === 'string' &&
      typeof s.tag === 'string' &&
      typeof s.commit === 'string'
    )
      src = { kind: 'release', repo: s.repo, tag: s.tag, commit: s.commit }
    else return []
    const state: SetupState = setup === 'ok' || setup === 'failed' ? setup : 'none'
    return [{ id, source: src, manifest: parsed.value, setup: state }]
  })
}

export function createInstallStore(userData: string): InstallStore {
  const dir = pluginsDir(userData)
  const file = jsonFileStore(join(dir, 'installed.json'), parseInstalls, { cache: true })
  const releaseDir = (id: string, commit: string) => join(dir, id, commit)
  return {
    list: () => file.read(),
    get: async (id) => (await file.read()).find((i) => i.id === id) ?? null,
    put: async (install) => {
      await file.update((all) => [...all.filter((i) => i.id !== install.id), install])
    },
    setSetup: async (id, setup) => {
      await file.update((all) => all.map((i) => (i.id === id ? { ...i, setup } : i)))
    },
    remove: async (id) => {
      let removed: Install | null = null
      await file.update((all) => {
        removed = all.find((i) => i.id === id) ?? null
        return all.filter((i) => i.id !== id)
      })
      return removed
    },
    codeDir: ({ id, source }) =>
      source.kind === 'dev' ? source.folder : releaseDir(id, source.commit),
    releaseDir,
    setupLog: (id) => join(dir, id, 'setup.log'),
  }
}
