/**
 * Community plugins' capabilities, all at the UI door only: installing,
 * consenting to and running code is the person's own act in the settings
 * tab, never something an app or the agent can ask for.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isCommunityPluginId,
  isRepoName,
  servedFile,
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
import { fetchRelease, listVersions, newestFirst, readManifest, type GitAccess } from './fetch'
import { searchPlugins } from './search'
import { writeSkills } from './skills'
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
  /** The folders it opens as one document (`.deck` holding `slides.md`). */
  folder?: { suffix: string; entry: string }
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
    ...(manifest.folder === undefined ? {} : { folder: manifest.folder }),
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
const pathParam = (raw: unknown): { path: string } => ({
  path: vaultRelPath(stringParam(paramsObject(raw), 'path')),
})

/** The server key: one per vault, plugin and file. */
const serverKey = (root: string, id: string, path: string) => `${root}\0${id}\0${path}`

/** How long a check for newer releases is trusted before GitHub is asked again. */
const UPDATE_CHECK_MS = 60 * 60 * 1000

export function communityCapabilities(deps: CommunityDeps, now = () => Date.now()) {
  /** The newest release of each repository, as last asked, and when. */
  const newest = new Map<string, { at: number; version: string | null }>()

  /** Each acquire's server key, by the lease it returned: a release names
   *  its lease, so it drops exactly what its acquire took, whatever has
   *  changed about the plugin since. */
  const leases = new Map<string, string>()

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
    const row = rows.find((r) => r.on && servedFile(r, path) !== null)
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

    // Repositories matching what is typed, each read as a plugin or not.
    'community.search': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ query: stringParam(paramsObject(raw), 'query') }),
      run: async (_ctx, { query }) => searchPlugins(query, deps.token()),
    }),

    // A newer release of each plugin installed here from one, by id: what
    // settings and the vault notice offer as an update. GitHub is asked at
    // most hourly per repository, or now with `fresh`.
    'community.updates': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ fresh: paramsObject(raw).fresh === true }),
      run: async (_ctx, { fresh }) => {
        const updates: Record<string, string> = {}
        for (const install of await deps.store.list()) {
          if (install.source.kind !== 'release') continue
          const { repo } = install.source
          let known = newest.get(repo)
          if (fresh || known === undefined || now() - known.at > UPDATE_CHECK_MS) {
            const versions = await listVersions(repo, deps.git).catch(() => null)
            // An unreachable GitHub is no answer, not "no update": ask again next time.
            if (versions === null) continue
            known = { at: now(), version: versions[0] ?? null }
            newest.set(repo, known)
          }
          if (known.version !== null && newestFirst(known.version, install.manifest.version) < 0)
            updates[install.id] = known.version
        }
        return updates
      },
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
        const params: { repo: string; version: string; expectId?: string } = {
          repo,
          version: stringParam(p, 'version'),
        }
        if (p.expectId !== undefined) params.expectId = stringParam(p, 'expectId')
        return params
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
    // the same commit, write its skills for the vault's agent, and keep what
    // its server writes out of the history.
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
        await writeSkills(install.manifest, deps.store.codeDir(install), ctx.root)
        const lines = install.manifest.ignore ?? []
        if (lines.length > 0) {
          const existing = await readFile(join(ctx.root, '.gitignore'), 'utf8').catch(() => null)
          const next = gitignoreWith(existing, lines)
          if (next !== null) await writeAtomic(ctx.root, vaultRelPath('.gitignore'), next)
        }
      },
    }),

    // A folder install's skills, which no pin writes: turning one on in a
    // vault gives its agent the skills as they are in the folder now.
    'community.skills': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => {
        const install = await installOf(id)
        return writeSkills(install.manifest, deps.store.codeDir(install), ctx.root)
      },
    }),

    // Where a plugin's code is on this machine, for the vault's agent to run
    // its tools (Prezzi's skill renders slides with it). Only a plugin that
    // runs here: the commit someone allowed, set up.
    'community.path': cap({
      doors: ['cli'],
      cli: { args: ['id'], summary: "a running community plugin's folder on this machine" },
      params: idParams,
      run: async (ctx, { id }) => {
        const row = (await listPlugins(ctx.root, deps)).find((r) => r.id === id)
        if (row === undefined || !row.running)
          throw new CapabilityError('NOT_FOUND', `${id} does not run in this vault here`)
        return deps.store.codeDir(await installOf(id))
      },
      text: (dir) => dir,
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
        // Its servers first: their code is about to go.
        await deps.supervisor.stopAll((key) => parseServerKey(key).id === id)
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
    // with its port once it answers, and a lease that holds it until
    // `release` returns it. A failed acquire holds nothing.
    'community.acquire': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }) => {
        const row = await servingPlugin(ctx.root, path)
        const install = await installOf(row.id)
        // A folder document's server is given its entry file.
        const file = await resolveRelative(ctx.root, servedFile(row, path)!)
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
        const lease = randomUUID()
        leases.set(lease, key)
        return { id: row.id, port, lease }
      },
    }),

    'community.release': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ lease: stringParam(paramsObject(raw), 'lease') }),
      run: async (_ctx, { lease }) => {
        const key = leases.get(lease)
        if (key === undefined) return
        leases.delete(lease)
        await deps.supervisor.release(key)
      },
    }),

    // What the file's server is doing, for a tab that mounts while it starts.
    'community.server': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }): Promise<ServerState | null> => {
        const rows = await listPlugins(ctx.root, deps)
        for (const row of rows.filter((r) => servedFile(r, path) !== null)) {
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
