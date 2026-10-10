/**
 * Community plugins' capabilities, all at the UI door only: installing,
 * consenting to and running code is the person's own act in the settings
 * tab, never something an app or the agent can ask for.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isCommunityPluginId,
  isRepoName,
  opensPath,
  parsePluginPin,
  PLUGIN_PINS_DIR,
  pluginPinPath,
  vaultRelPath,
  type PluginManifest,
  type PluginPin,
} from '@holi/shared'
import { resolveRelative } from '@holi/shared/path-safety-node'
import {
  cap,
  CapabilityError,
  gitignoreWith,
  noParams,
  paramsObject,
  readVaultSettings,
  stringParam,
  writeAtomic,
  type CapabilityTable,
} from '../../../main/plugin-api'
import type { ConsentStore } from './consent'
import { fetchRelease, listVersions, readManifest, type GitAccess } from './fetch'
import { fetchRegistry } from './registry'
import { expandCommand, pluginEnv, runSetup } from './setup'
import type { Install, InstallStore } from './store'
import type { ServerState, Supervisor } from './supervisor'

export const COMMUNITY_NAMESPACES = ['community'] as const

/** Where a plugin stands, for this vault on this machine, in the order the
 *  settings tab walks someone through. */
export type PluginStatus =
  /** The vault pins it and this machine has nothing of it. */
  | 'not-installed'
  /** This machine has another release than the one the vault pins. */
  | 'pin-differs'
  /** Fetched, but nobody here has agreed to run this commit. */
  | 'needs-consent'
  | 'needs-setup'
  | 'setup-failed'
  | 'ready'

export interface PluginRow {
  id: string
  name: string
  description: string
  opens: string[]
  status: PluginStatus
  /** The vault's `plugins.<id>` says on. */
  on: boolean
  /** On, and able to serve here: its files open in its tab. */
  running: boolean
  pin: { repo: string; version: string; commit: string } | null
  install:
    | { kind: 'release'; repo: string; version: string; commit: string }
    | { kind: 'dev'; folder: string; version: string }
    | null
  /** What it will run, for the consent dialog. */
  setup: string[] | null
  serve: string[]
}

export interface CommunityDeps {
  store: InstallStore
  consent: ConsentStore
  supervisor: Supervisor
  git: GitAccess
  token(): string | null
  /** The ids built into Holi, which no community plugin may take. */
  firstPartyIds(): readonly string[]
  /** Tell the renderer something about the vault `remote`. */
  emit(remote: string, name: string, payload: unknown): void
  /** The bridge script a plugin's server may inject, for the app door. */
  bridgeScript(): string | null
  /** Staging for fetches. */
  scratch: string
}

/** The vault's pins, by id; an unreadable one is left out. */
export async function readPins(root: string): Promise<Map<string, PluginPin>> {
  const pins = new Map<string, PluginPin>()
  const dirs = await readdir(join(root, PLUGIN_PINS_DIR)).catch(() => [] as string[])
  for (const id of dirs) {
    const text = await readFile(join(root, pluginPinPath(id)), 'utf8').catch(() => null)
    if (text === null) continue
    try {
      const parsed = parsePluginPin(JSON.parse(text))
      if (parsed.ok && parsed.value.id === id) pins.set(id, parsed.value)
    } catch {
      // Not JSON: not a pin.
    }
  }
  return pins
}

const installCommit = (i: Install) => (i.source.kind === 'release' ? i.source.commit : null)

async function statusOf(
  install: Install | null,
  pin: PluginPin | null,
  consent: ConsentStore,
): Promise<PluginStatus> {
  if (install === null) return 'not-installed'
  const commit = installCommit(install)
  if (commit !== null) {
    if (pin !== null && pin.commit !== commit) return 'pin-differs'
    if (!(await consent.has(install.id, commit))) return 'needs-consent'
  }
  if (install.manifest.setup !== undefined && install.source.kind === 'release') {
    if (install.setup === 'failed') return 'setup-failed'
    if (install.setup !== 'ok') return 'needs-setup'
  }
  return 'ready'
}

function rowOf(
  id: string,
  install: Install | null,
  pin: PluginPin | null,
  status: PluginStatus,
  on: boolean,
): PluginRow {
  const manifest: PluginManifest = (install?.manifest ?? pin)!
  return {
    id,
    name: manifest.name,
    description: manifest.description ?? '',
    opens: manifest.opens,
    status,
    on,
    running: on && status === 'ready',
    pin: pin === null ? null : { repo: pin.repo, version: pin.version, commit: pin.commit },
    install:
      install === null
        ? null
        : install.source.kind === 'release'
          ? {
              kind: 'release',
              repo: install.source.repo,
              version: install.manifest.version,
              commit: install.source.commit,
            }
          : { kind: 'dev', folder: install.source.folder, version: install.manifest.version },
    setup: manifest.setup ?? null,
    serve: manifest.serve,
  }
}

/** Every plugin this vault pins or this machine has, as the settings tab
 *  lists them. */
export async function listPlugins(root: string, deps: Pick<CommunityDeps, 'store' | 'consent'>) {
  const [pins, installs, settings] = await Promise.all([
    readPins(root),
    deps.store.list(),
    readVaultSettings(root),
  ])
  const ids = [...new Set([...pins.keys(), ...installs.map((i) => i.id)])].sort()
  return Promise.all(
    ids.map(async (id) => {
      const install = installs.find((i) => i.id === id) ?? null
      const pin = pins.get(id) ?? null
      const status = await statusOf(install, pin, deps.consent)
      return rowOf(id, install, pin, status, settings.plugins.vault[id] === true)
    }),
  )
}

const idParams = (raw: unknown) => ({ id: stringParam(paramsObject(raw), 'id') })
const pathParam = (raw: unknown) => ({ path: vaultRelPath(stringParam(paramsObject(raw), 'path')) })

/** The server key: one per vault, plugin and file. */
const serverKey = (root: string, id: string, path: string) => `${root}\0${id}\0${path}`

export function communityCapabilities(deps: CommunityDeps) {
  const installOf = async (id: string): Promise<Install> => {
    const install = await deps.store.get(id)
    if (install === null) throw new CapabilityError('NOT_FOUND', `${id} is not installed here`)
    return install
  }

  const claimFirstParty = (id: string) => {
    if (!isCommunityPluginId(id, deps.firstPartyIds()))
      throw new CapabilityError('BAD_REQUEST', `${id} is the name of a plugin built into Holi`)
  }

  /** The running plugin that opens `path` here, or a refusal saying why not. */
  const servingPlugin = async (root: string, path: string): Promise<PluginRow> => {
    const rows = await listPlugins(root, deps)
    const row = rows.find((r) => r.on && r.opens.length > 0 && opensPath(r, path))
    if (row === undefined) throw new CapabilityError('NOT_FOUND', `no plugin opens ${path}`)
    if (!row.running)
      throw new CapabilityError(
        'FORBIDDEN',
        `${row.name} is not ready on this machine (${row.status})`,
      )
    return row
  }

  return {
    'community.list': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx) => listPlugins(ctx.root, deps),
    }),

    'community.registry': cap({
      doors: ['ui'],
      params: noParams,
      run: async () => fetchRegistry(deps.token()),
    }),

    'community.versions': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const repo = stringParam(paramsObject(raw), 'repo')
        if (!isRepoName(repo)) throw new CapabilityError('BAD_REQUEST', 'repo must be owner/repo')
        return { repo }
      },
      run: async (_ctx, { repo }) => listVersions(repo, deps.git),
    }),

    // Fetch a release onto this machine. Nothing of it runs yet: setup waits
    // for `community.consent`, which the dialog asks after showing what this
    // returns (the commit and the commands).
    'community.install': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        const repo = stringParam(p, 'repo')
        if (!isRepoName(repo)) throw new CapabilityError('BAD_REQUEST', 'repo must be owner/repo')
        const expectId = p.id === undefined ? undefined : stringParam(p, 'id')
        return { repo, version: stringParam(p, 'version'), expectId }
      },
      run: async (ctx, { repo, version, expectId }) => {
        const fetched = await fetchRelease(
          {
            repo,
            version,
            ...(expectId === undefined ? {} : { expectId }),
            scratch: deps.scratch,
            releaseDir: deps.store.releaseDir,
          },
          deps.git,
        )
        claimFirstParty(fetched.manifest.id)
        await deps.store.put({
          id: fetched.manifest.id,
          source: { kind: 'release', repo, tag: fetched.tag, commit: fetched.commit },
          manifest: fetched.manifest,
          setup: 'none',
        })
        const rows = await listPlugins(ctx.root, deps)
        return rows.find((r) => r.id === fetched.manifest.id)!
      },
    }),

    // A folder the person works on, used in place: their own code, so no
    // consent is asked, and it is never pinned.
    'community.installFolder': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ folder: stringParam(paramsObject(raw), 'folder') }),
      run: async (ctx, { folder }) => {
        const manifest = await readManifest(folder)
        claimFirstParty(manifest.id)
        await deps.store.put({
          id: manifest.id,
          source: { kind: 'dev', folder },
          manifest,
          setup: 'none',
        })
        const rows = await listPlugins(ctx.root, deps)
        return rows.find((r) => r.id === manifest.id)!
      },
    }),

    'community.consent': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), commit: stringParam(p, 'commit') }
      },
      run: async (_ctx, { id, commit }) => {
        const install = await installOf(id)
        // The commit the dialog showed: a re-fetch in between asks again.
        if (installCommit(install) !== commit)
          throw new CapabilityError('BAD_REQUEST', `${id} changed since it was shown; look again`)
        await deps.consent.grant(id, commit)
      },
    }),

    // Run the manifest's setup, its output streaming as `setup-log` events.
    'community.setup': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => {
        const install = await installOf(id)
        const commit = installCommit(install)
        if (commit !== null && !(await deps.consent.has(id, commit)))
          throw new CapabilityError('FORBIDDEN', `nobody here has agreed to run ${id} ${commit}`)
        if (install.manifest.setup === undefined) return true
        deps.emit(ctx.remote, 'setup-log', { id, line: null })
        const ok = await runSetup({
          argv: expandCommand(install.manifest.setup, { vault: ctx.root }),
          cwd: deps.store.codeDir(install),
          logPath: deps.store.setupLog(id),
          onLine: (line) => deps.emit(ctx.remote, 'setup-log', { id, line }),
        })
        await deps.store.setSetup(id, ok ? 'ok' : 'failed')
        return ok
      },
    }),

    'community.setupLog': cap({
      doors: ['ui'],
      params: idParams,
      run: async (_ctx, { id }) => readFile(deps.store.setupLog(id), 'utf8').catch(() => ''),
    }),

    // Pin this machine's release in the vault, so its members are offered
    // the same commit, and keep what its server writes out of the history.
    // The vault's `plugins.<id>` switch is the settings tab's own write.
    'community.pin': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => {
        const install = await installOf(id)
        if (install.source.kind !== 'release')
          throw new CapabilityError(
            'BAD_REQUEST',
            `${id} is a folder on this machine; pin a release`,
          )
        const pin: PluginPin = {
          ...install.manifest,
          repo: install.source.repo,
          commit: install.source.commit,
        }
        await writeAtomic(
          ctx.root,
          vaultRelPath(pluginPinPath(id)),
          `${JSON.stringify(pin, null, 2)}\n`,
        )
        const lines = install.manifest.ignore ?? []
        if (lines.length > 0) {
          const existing = await readFile(join(ctx.root, '.gitignore'), 'utf8').catch(() => null)
          const next = gitignoreWith(existing, lines)
          if (next !== null) await writeAtomic(ctx.root, vaultRelPath('.gitignore'), next)
        }
      },
    }),

    'community.unpin': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => {
        await rm(join(ctx.root, PLUGIN_PINS_DIR, vaultRelPath(id)), {
          recursive: true,
          force: true,
        })
      },
    }),

    // Take it off this machine: its code, its setup and every consent to it.
    // A vault's pin stays, and offers it again.
    'community.remove': cap({
      doors: ['ui'],
      params: idParams,
      run: async (_ctx, { id }) => {
        const install = await deps.store.remove(id)
        await deps.consent.forget(id)
        if (install?.source.kind === 'release')
          await rm(join(deps.store.releaseDir(id, install.source.commit), '..'), {
            recursive: true,
            force: true,
          })
      },
    }),

    // The server for a file a plugin opens, started if none is up. Resolves
    // with its port once it answers; each call holds it until `release`.
    'community.acquire': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }) => {
        const row = await servingPlugin(ctx.root, path)
        const install = await installOf(row.id)
        const file = await resolveRelative(ctx.root, path)
        const key = serverKey(ctx.root, row.id, path)
        const bridge = deps.bridgeScript()
        const { port } = await deps.supervisor.acquire(key, {
          cwd: deps.store.codeDir(install),
          argv: (port) => expandCommand(install.manifest.serve, { file, vault: ctx.root, port }),
          env: (port) =>
            pluginEnv({
              HOLI_VAULT_ROOT: ctx.root,
              HOLI_FILE: file,
              HOLI_PORT: String(port),
              ...(bridge === null ? {} : { HOLI_BRIDGE_SCRIPT: bridge }),
            }),
        })
        return { id: row.id, port }
      },
    }),

    'community.release': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }) => {
        const rows = await listPlugins(ctx.root, deps)
        for (const row of rows.filter((r) => opensPath(r, path)))
          await deps.supervisor.release(serverKey(ctx.root, row.id, path))
      },
    }),

    // What the file's server is doing, for a tab that mounts while it starts.
    'community.server': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }): Promise<ServerState | null> => {
        const rows = await listPlugins(ctx.root, deps)
        for (const row of rows.filter((r) => opensPath(r, path))) {
          const state = deps.supervisor.state(serverKey(ctx.root, row.id, path))
          if (state !== null) return state
        }
        return null
      },
    }),
  } satisfies CapabilityTable
}

/** The vault a server key belongs to, and its file, for events. */
export function parseServerKey(key: string): { root: string; id: string; path: string } {
  const [root, id, path] = key.split('\0')
  return { root: root!, id: id!, path: path! }
}
