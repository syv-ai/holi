/**
 * Community plugins' capabilities, nearly all at the UI door only: installing,
 * consenting to and running code is the person's own act in the settings
 * tab, never something an app or the agent can ask for. At the CLI door are
 * a running plugin's folder (`holi community path`) and its verbs
 * (`holi plugin`, `verbs.ts`), each only for a plugin someone allowed here.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomUUID } from 'node:crypto'
import { lstat, realpath, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isCommunityPluginId,
  isPluginPath,
  isRepoName,
  servedFile,
  parsePluginPin,
  PLUGIN_PINS_DIR,
  pluginPinPath,
  resolvePlugins,
  vaultRelPath,
  type PluginInfo,
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
  flagParam,
  readVaultSettings,
  stringParam,
  toolPath,
  writeAtomic,
  type CapabilityTable,
} from '../../../main/plugin-api'
import type { Checks, CheckResult } from './checks'
import type { ConsentStore } from './consent'
import {
  fetchRelease,
  listReleases,
  listVersions,
  newestFirst,
  readBoundedRegularText,
  readManifest,
  versionsOf,
  type GitAccess,
} from './fetch'
import { searchPlugins } from './search'
import { refreshSkills, seedApps, writeSkills } from './skills'
import {
  assertCheckoutIdentity,
  assertManifestPinned,
  assertNoCompetingSkillClaims,
  canonicalJson,
  prepareAuthenticatedRelease,
  validateSkillSnapshot,
} from './skill-release'
import { COMMUNITY_INFO } from '../info'
import { linkCommands, linkedIn, unlinkCommands, type LinkedCommands } from './commands'
import { expandCommand, pluginEnv, runSetup } from './setup'
import type { Install, InstallStore } from './store'
import type { ServerState, Supervisor } from './supervisor'
import { resolveVerb, type RunningPlugin, type VerbAnswer } from './verbs'

export const COMMUNITY_NAMESPACES = ['community', 'plugin'] as const

/** Where a plugin stands, for this vault on this machine, in the order the
 *  settings tab walks someone through. */
type PluginStatus =
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
  /** A failed automatic guide/pin update, retained until a later successful refresh. */
  syncError?: string
  syncBackups?: string[]
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
  /** `path` is where in `repo` the plugin is: `''` for its root. */
  pin: { repo: string; path: string; version: string; commit: string } | null
  install:
    | { kind: 'release'; repo: string; path: string; version: string; commit: string }
    | { kind: 'dev'; folder: string; version: string }
    | null
  /** What it will run, for the consent dialog. */
  setup: string[] | null
  /** Null for a plugin that only ships apps and skills. */
  serve: string[] | null
  /** The vault apps it ships. */
  apps: string[]
  /** The commands it adds to the agent's `PATH`, for the consent dialog. */
  bin: string[]
  /** What `holi plugin <id> <verb>` runs and its verbs, for the consent
   *  dialog; null for a plugin without verbs. */
  cli: { run: string[]; verbs: string[] } | null
  /** Running, which of its commands the agent did not get and why, as the
   *  vault's last rebuild left them; null when it has them all. */
  commandsNote: string | null
  /** Running, its readiness check's last answer (`checks.ts`); null when it
   *  has none or it has not been asked. A failing one does not stop it. */
  check: CheckResult | null
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
  /** The plugins' readiness checks' last answers. */
  checks: Checks
  /** Serialize machine-wide install, consent, setup and removal transitions. */
  mutate<T>(work: () => Promise<T>): Promise<T>
  /** Serialize resource reads with machine-wide mutations. */
  admit?<T>(work: () => Promise<T>): Promise<T>
  /** Attachment lifetime, supplied by the main-process owner; omitted by focused tests. */
  signal?: AbortSignal
  live?: () => boolean
  run?<T>(work: () => Promise<T>): Promise<T>
  /** The `PATH` the vault's agent inherits, before Holi's own folders: a
   *  plugin's command may not take a name already on it. By default
   *  `toolPath()`: a Dock-launched Holi's own `PATH` lacks the folders the
   *  person's shell, and so the agent's commands, have. */
  searchPath?(): string
}

async function readOptionalBoundedRegularText(path: string, label: string): Promise<string | null> {
  try {
    return await readBoundedRegularText(path, label)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** The vault's pins, by id; an unreadable one is left out. */
async function readPins(root: string): Promise<Map<string, PluginPin>> {
  const pins = new Map<string, PluginPin>()
  const dirs = await readdir(join(root, PLUGIN_PINS_DIR)).catch(() => [] as string[])
  for (const id of dirs) {
    const text = await readBoundedRegularText(join(root, pluginPinPath(id)), 'plugin pin').catch(
      () => null,
    )
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
  if (
    pin !== null &&
    (install.source.kind !== 'release' ||
      pin.commit !== commit ||
      pin.repo !== install.source.repo ||
      pin.path !== install.source.path)
  )
    return 'pin-differs'
  if (commit !== null && !(await consent.has(install.id, commit))) return 'needs-consent'
  if (install.manifest.setup !== undefined && install.source.kind === 'release') {
    if (install.setup === 'failed') return 'setup-failed'
    if (install.setup !== 'ok') return 'needs-setup'
  }
  return 'ready'
}

const syncErrors = new Map<string, string>()
const syncBackups = new Map<string, string[]>()

function rowOf(
  root: string,
  id: string,
  install: Install | null,
  pin: PluginPin | null,
  status: PluginStatus,
  on: boolean,
  linked: LinkedCommands | null,
  check: CheckResult | null,
): PluginRow {
  const manifest: PluginManifest = (install?.manifest ?? pin)!
  return {
    ...(syncErrors.get(`${root}\0${id}`) === undefined
      ? {}
      : { syncError: syncErrors.get(`${root}\0${id}`) }),
    ...(syncBackups.get(`${root}\0${id}`) === undefined
      ? {}
      : { syncBackups: syncBackups.get(`${root}\0${id}`) }),
    id,
    name: manifest.name,
    description: manifest.description ?? '',
    opens: manifest.opens,
    ...(manifest.folder === undefined ? {} : { folder: manifest.folder }),
    status,
    on,
    running: on && status === 'ready',
    pin:
      pin === null
        ? null
        : { repo: pin.repo, path: pin.path, version: pin.version, commit: pin.commit },
    install:
      install === null
        ? null
        : install.source.kind === 'release'
          ? {
              kind: 'release',
              repo: install.source.repo,
              path: install.source.path,
              version: install.manifest.version,
              commit: install.source.commit,
            }
          : { kind: 'dev', folder: install.source.folder, version: install.manifest.version },
    setup: manifest.setup ?? null,
    serve: manifest.serve ?? null,
    apps: manifest.apps ?? [],
    bin: Object.keys(manifest.bin ?? {}),
    cli:
      manifest.cli === undefined
        ? null
        : { run: manifest.cli.run, verbs: Object.keys(manifest.cli.verbs) },
    commandsNote: on && status === 'ready' ? commandsNote(id, linked) : null,
    check: on && status === 'ready' && manifest.check !== undefined ? check : null,
  }
}

function commandsNote(id: string, linked: LinkedCommands | null): string | null {
  if (linked === null) return null
  if (linked.error !== undefined) return `Its commands could not be linked: ${linked.error}.`
  const mine = linked.refused.filter((r) => r.id === id)
  if (mine.length === 0) return null
  return mine.map((r) => `${r.name} is not on the agent's PATH: ${r.reason}.`).join(' ')
}

/** Pair each authorized row with the install snapshot it describes. */
async function pluginEntries(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent'> & { checks?: Checks },
) {
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
      const on = settings.plugins.vault[id] === true
      const check = deps.checks?.get(root, id) ?? null
      return {
        row: rowOf(root, id, install, pin, status, on, linkedIn(root), check),
        install,
      }
    }),
  )
}

/** Every plugin this vault pins or this machine has, as the settings tab lists them.
 * @public exported for its test
 */
export async function listPlugins(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent'> & { checks?: Checks },
) {
  return (await pluginEntries(root, deps)).map(({ row }) => row)
}

const idParams = (raw: unknown) => ({ id: stringParam(paramsObject(raw), 'id') })
const pathParam = (raw: unknown): { path: string } => ({
  path: vaultRelPath(stringParam(paramsObject(raw), 'path')),
})

/** The server key: one per vault, plugin and file. */
async function assertSafeVaultPath(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== resolve(root)) throw new Error('vault root is not canonical')
  const rel = relative(canonicalRoot, resolve(path))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('publication path escapes the vault')
  let current = canonicalRoot
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isSymbolicLink() || (info !== null && !info.isDirectory()))
      throw new Error(`unsafe vault path ancestor: ${current}`)
  }
}

function insidePath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

const serverKey = (root: string, id: string, path: string) => `${root}\0${id}\0${path}`

const repoParam = (p: Record<string, unknown>): string => {
  const repo = stringParam(p, 'repo')
  if (!isRepoName(repo)) throw new CapabilityError('BAD_REQUEST', 'repo must be owner/repo')
  return repo
}

/** Where in the repository the plugin is: `''` for its root. */
const pluginPathParam = (p: Record<string, unknown>): string => {
  const path = p.path
  if (!isPluginPath(path))
    throw new CapabilityError('BAD_REQUEST', "path must be '' or the plugin's folder")
  return path
}

/** How long a check for newer releases is trusted before GitHub is asked again. */
function manifestFromPin(pin: PluginPin): PluginManifest {
  const { repo: _repo, path: _path, commit: _commit, ...manifest } = pin
  return manifest
}

const UPDATE_CHECK_MS = 60 * 60 * 1000

/** Adopt a newer, already-consented same-source install for this vault. Called
 *  from the attachment's owner-admitted refresh; do not re-enter owner.admit. */
export async function refreshInstalledPins(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent' | 'git' | 'signal' | 'live'>,
): Promise<void> {
  const [pins, installs, settings] = await Promise.all([
    readPins(root),
    deps.store.list(),
    readVaultSettings(root),
  ])
  const originalPinTexts = new Map<string, string | null>()
  for (const pin of pins.values())
    originalPinTexts.set(
      pin.id,
      await readOptionalBoundedRegularText(join(root, pluginPinPath(pin.id)), 'plugin pin'),
    )
  for (const pin of pins.values()) {
    const install = installs.find((item) => item.id === pin.id)
    if (
      !settings.plugins.vault[pin.id] ||
      install === undefined ||
      install.source.kind !== 'release' ||
      install.source.repo !== pin.repo ||
      install.source.path !== pin.path ||
      newestFirst(install.manifest.version, pin.version) >= 0 ||
      install.setup !== 'ok' ||
      !(await deps.consent.has(install.id, install.source.commit))
    )
      continue
    const source = install.source
    const key = `${root}\0${pin.id}`
    try {
      const next: PluginPin = {
        ...install.manifest,
        repo: source.repo,
        path: source.path,
        commit: source.commit,
      }
      const codeDir = resolve(deps.store.codeDir(install))
      const expectedRoot = await realpath(
        resolve(deps.store.releaseDir(install.id, source.commit)),
      ).catch(() => null)
      const codeReal = await realpath(codeDir).catch(() => null)
      if (
        expectedRoot === null ||
        codeReal === null ||
        codeReal !== resolve(expectedRoot, source.path) ||
        !insidePath(expectedRoot, codeReal)
      )
        throw new Error('installed release paths do not match their canonical source')
      const checkoutManifest = await readManifest(codeDir, source.path)
      await assertCheckoutIdentity(
        expectedRoot,
        source.commit,
        deps.git.url(source.repo),
        deps.signal,
      )
      await assertManifestPinned(
        expectedRoot,
        source.commit,
        source.path,
        checkoutManifest,
        deps.signal,
      )
      if (canonicalJson(checkoutManifest) !== canonicalJson(install.manifest))
        throw new Error('installed release manifest does not match its source')
      const pinPath = join(root, pluginPinPath(pin.id))
      await assertSafeVaultPath(root, pinPath)
      const expectedSnapshots = await prepareAuthenticatedRelease({
        root: expectedRoot,
        commit: source.commit,
        sourcePath: source.path,
        originUrl: deps.git.url(source.repo),
        manifest: install.manifest,
        skills: install.manifest.skills ?? [],
        signal: deps.signal,
      })
      const originalPinText = originalPinTexts.get(pin.id) ?? null
      if (originalPinText === null) throw new Error('automatic community update pin changed')
      const guard = async () => {
        if (deps.live?.() === false || deps.signal?.aborted)
          throw new Error('community attachment is closed')
        await assertSafeVaultPath(root, pinPath)
        const [currentInstall, consented, currentSettings, currentPinText] = await Promise.all([
          deps.store.get(install.id),
          deps.consent.has(install.id, source.commit),
          readVaultSettings(root),
          readBoundedRegularText(pinPath, 'plugin pin').catch(() => null),
        ])
        if (
          currentInstall === null ||
          currentInstall.source.kind !== 'release' ||
          JSON.stringify(currentInstall.source) !== JSON.stringify(source) ||
          canonicalJson(currentInstall.manifest) !== canonicalJson(install.manifest) ||
          currentInstall.setup !== 'ok' ||
          !consented ||
          currentSettings.plugins.vault[install.id] !== true ||
          currentPinText !== originalPinText
        )
          throw new Error('automatic community update authorization changed')
        await assertNoCompetingSkillClaims(root, install.id, install.manifest.skills ?? [])
        if (deps.live?.() === false || deps.signal?.aborted)
          throw new Error('community attachment is closed')
      }
      const validateSnapshot = async (snapshots: Parameters<typeof validateSkillSnapshot>[4]) => {
        await guard()
        await validateSkillSnapshot(
          expectedRoot,
          source.commit,
          source.path,
          install.manifest.skills ?? [],
          snapshots,
          deps.signal,
        )
        await guard()
      }
      await guard()
      const ignorePath = join(root, '.gitignore')
      const originalIgnoreText = await readOptionalBoundedRegularText(ignorePath, 'vault .gitignore')
      const writtenGuides = await writeSkills(install.manifest, codeDir, root, {
        guard,
        expectedSnapshots,
        validateSnapshot,
      })
      const retainedBackups = writtenGuides.filter((path) => path.endsWith('(guide backups)'))
      if (retainedBackups.length)
        syncBackups.set(key, [...new Set([...(syncBackups.get(key) ?? []), ...retainedBackups])])
      await seedApps(install.manifest, codeDir, root, { guard })
      await guard()
      const lines = install.manifest.ignore ?? []
      if (lines.length > 0) {
        const updated = gitignoreWith(originalIgnoreText, lines)
        if (updated !== null)
          await writeAtomic(root, vaultRelPath('.gitignore'), updated, async () => {
            await guard()
            if ((await readOptionalBoundedRegularText(ignorePath, 'vault .gitignore')) !== originalIgnoreText)
              throw new Error('vault .gitignore changed during publication')
          })
      }
      await writeAtomic(
        root,
        vaultRelPath(pluginPinPath(pin.id)),
        `${JSON.stringify(next, null, 2)}\n`,
        guard,
      )
      syncErrors.delete(key)
    } catch (error) {
      syncErrors.set(key, `Could not update guides for ${pin.name}: ${String(error)}`)
    }
  }
}

export function communityCapabilities(deps: CommunityDeps, now = () => Date.now()) {
  /** Each repository's releases, of every plugin in it, as last asked, and
   *  when: one read serves all the plugins a repository holds. */
  const releasesOf = new Map<
    string,
    { at: number; releases: { path: string; version: string }[] }
  >()

  /** Each acquire's server key, by the lease it returned: a release names
   *  its lease, so it drops exactly what its acquire took, whatever has
   *  changed about the plugin since. */
  const leases = new Map<string, () => Promise<void>>()

  const admit = deps.admit ?? (<T>(work: () => Promise<T>) => work())

  const ensureLive = () => {
    if (deps.live?.() === false || deps.signal?.aborted)
      throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
  }

  const installOf = async (id: string): Promise<Install> => {
    const install = await deps.store.get(id)
    if (install === null) throw new CapabilityError('NOT_FOUND', `${id} is not installed here`)
    return install
  }

  const claimFirstParty = (id: string) => {
    if (!isCommunityPluginId(id, deps.firstPartyIds()))
      throw new CapabilityError('BAD_REQUEST', `${id} is the name of a plugin built into Holi`)
  }

  /** Set up afresh: what its check said before no longer holds. Asked now
   *  when it runs in the vault; otherwise once it is turned on there. */
  const checkAfterSetup = async (root: string, id: string) => {
    await deps.checks.forget(root, id)
    await runChecks(root, deps, { ids: [id], fresh: true })
  }

  const table = {
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
    // settings and the vault notice offer as an update, from that plugin's own
    // tags. GitHub is asked at most hourly per repository, or now with `fresh`.
    'community.updates': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ fresh: paramsObject(raw).fresh === true }),
      run: async (_ctx, { fresh }) => {
        const updates: Record<string, string> = {}
        for (const install of await deps.store.list()) {
          if (install.source.kind !== 'release') continue
          const { repo, path } = install.source
          let known = releasesOf.get(repo)
          if (fresh || known === undefined || now() - known.at > UPDATE_CHECK_MS) {
            const releases = await listReleases(repo, deps.git).catch(() => null)
            // An unreachable GitHub is no answer, not "no update": ask again next time.
            if (releases === null) continue
            known = { at: now(), releases }
            releasesOf.set(repo, known)
          }
          const latest = versionsOf(known.releases, path)[0]
          if (latest !== undefined && newestFirst(latest, install.manifest.version) < 0)
            updates[install.id] = latest
        }
        return updates
      },
    }),

    'community.versions': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        return { repo: repoParam(p), path: pluginPathParam(p) }
      },
      run: async (_ctx, { repo, path }) => listVersions(repo, path, deps.git),
    }),

    // Fetch a release onto this machine. Nothing of it runs yet: setup waits
    // for `community.consent`, which the dialog asks after showing what this
    // returns (the commit and the commands).
    'community.install': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        const params: { repo: string; path: string; version: string; expectId?: string } = {
          repo: repoParam(p),
          path: pluginPathParam(p),
          version: stringParam(p, 'version'),
        }
        if (p.expectId !== undefined) params.expectId = stringParam(p, 'expectId')
        return params
      },
      run: async (ctx, { repo, path, version, expectId }) =>
        deps.mutate(async () => {
          const fetched = await fetchRelease(
            {
              repo,
              path,
              version,
              ...(expectId === undefined ? {} : { expectId }),
              scratch: deps.scratch,
              releaseDir: deps.store.releaseDir,
            },
            deps.git,
          )
          ensureLive()
          claimFirstParty(fetched.manifest.id)
          await deps.supervisor.stopAll((key) => parseServerKey(key).id === fetched.manifest.id)
          await deps.store.put({
            id: fetched.manifest.id,
            source: { kind: 'release', repo, path, tag: fetched.tag, commit: fetched.commit },
            manifest: fetched.manifest,
            setup: 'none',
          })
          await deps.checks.forget(ctx.root, fetched.manifest.id)
          // A new release of a running plugin waits for consent: its commands go
          // until then.
          await linkRunningCommands(ctx.root, deps)
          const rows = await listPlugins(ctx.root, deps)
          return rows.find((r) => r.id === fetched.manifest.id)!
        }),
    }),

    // A folder the person works on, used in place: their own code, so no
    // consent is asked, and it is never pinned.
    'community.installFolder': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ folder: stringParam(paramsObject(raw), 'folder') }),
      run: async (ctx, { folder }) =>
        deps.mutate(async () => {
          const manifest = await readManifest(folder)
          claimFirstParty(manifest.id)
          await deps.supervisor.stopAll((key) => parseServerKey(key).id === manifest.id)
          await deps.store.put({
            id: manifest.id,
            source: { kind: 'dev', folder },
            manifest,
            setup: 'none',
          })
          await deps.checks.forget(ctx.root, manifest.id)
          await linkRunningCommands(ctx.root, deps)
          const rows = await listPlugins(ctx.root, deps)
          return rows.find((r) => r.id === manifest.id)!
        }),
    }),

    'community.consent': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), commit: stringParam(p, 'commit') }
      },
      run: async (_ctx, { id, commit }) =>
        deps.mutate(async () => {
          const install = await installOf(id)
          // The commit the dialog showed: a re-fetch in between asks again.
          if (installCommit(install) !== commit)
            throw new CapabilityError('BAD_REQUEST', `${id} changed since it was shown; look again`)
          ensureLive()
          await deps.consent.grant(id, commit)
        }),
    }),

    // Run the manifest's setup, its output streaming as `setup-log` events.
    'community.setup': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) =>
        deps.mutate(async () => {
          const install = await installOf(id)
          const commit = installCommit(install)
          if (commit !== null && !(await deps.consent.has(id, commit)))
            throw new CapabilityError('FORBIDDEN', `nobody here has agreed to run ${id} ${commit}`)
          ensureLive()
          await deps.supervisor.stopAll((key) => parseServerKey(key).id === id)
          if (install.manifest.setup === undefined) {
            await deps.store.setSetup(id, 'ok')
            await seedRunningApps(ctx.root, deps)
            await linkRunningCommands(ctx.root, deps)
            await checkAfterSetup(ctx.root, id)
            return true
          }
          // Setup can partially change machine state before failing or being
          // cancelled. Invalidate shared readiness before starting it.
          await deps.store.setSetup(id, 'failed')
          deps.emit(ctx.remote, 'setup-log', { id, line: null })
          const ok = await runSetup({
            argv: expandCommand(install.manifest.setup, { vault: ctx.root }),
            signal: deps.signal,
            cwd: deps.store.codeDir(install),
            logPath: deps.store.setupLog(id),
            onLine: (line) => {
              if (deps.live?.() !== false) deps.emit(ctx.remote, 'setup-log', { id, line })
            },
          })
          // Persist the outcome even if this attachment closed while setup ran:
          // the install state is machine-wide and other vaults must see failure.
          await deps.store.setSetup(id, ok ? 'ok' : 'failed')
          // Set up in a vault that runs it: its apps and commands arrive now, not
          // at the next open.
          if (ok) {
            await seedRunningApps(ctx.root, deps)
            await linkRunningCommands(ctx.root, deps)
            await checkAfterSetup(ctx.root, id)
          }
          return ok
        }),
    }),

    // Ask a running plugin's readiness check again, for its settings row and
    // the vault notice. Resolves with the row as it stands after.
    'community.check': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) =>
        admit(async () => {
          ensureLive()
          await runChecks(ctx.root, deps, { ids: [id], fresh: true })
          const row = (await listPlugins(ctx.root, deps)).find((r) => r.id === id)
          if (row === undefined) throw new CapabilityError('NOT_FOUND', `${id} is not here`)
          return row
        }),
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
      run: async (ctx, { id }) =>
        admit(async () => {
          ensureLive()
          const install = await installOf(id)
          if (install.source.kind !== 'release')
            throw new CapabilityError(
              'BAD_REQUEST',
              `${id} is a folder on this machine; pin a release`,
            )
          const source = install.source
          const pin: PluginPin = {
            ...install.manifest,
            repo: source.repo,
            path: source.path,
            commit: source.commit,
          }
          const codeDir = resolve(deps.store.codeDir(install))
          const expectedRoot = await realpath(
            resolve(deps.store.releaseDir(id, source.commit)),
          ).catch(() => null)
          const codeReal = await realpath(codeDir).catch(() => null)
          if (
            expectedRoot === null ||
            codeReal === null ||
            codeReal !== resolve(expectedRoot, source.path) ||
            !insidePath(expectedRoot, codeReal)
          )
            throw new CapabilityError('FORBIDDEN', `${id} release paths do not match its source`)
          const validateSource = async () => {
            const manifest = await readManifest(codeDir, source.path)
            await assertCheckoutIdentity(
              expectedRoot,
              source.commit,
              deps.git.url(source.repo),
              deps.signal,
            )
            await assertManifestPinned(
              expectedRoot,
              source.commit,
              source.path,
              manifest,
              deps.signal,
            )
            if (canonicalJson(manifest) !== canonicalJson(install.manifest))
              throw new CapabilityError('FORBIDDEN', `${id} manifest does not match its source`)
          }
          const pinPath = join(ctx.root, pluginPinPath(id))
          await assertSafeVaultPath(ctx.root, pinPath)
          const originalPinText = await readBoundedRegularText(pinPath, 'plugin pin').catch(
            (error) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
              throw error
            },
          )
          const expectedSnapshots = await prepareAuthenticatedRelease({
            root: expectedRoot,
            commit: source.commit,
            sourcePath: source.path,
            originUrl: deps.git.url(source.repo),
            manifest: install.manifest,
            skills: install.manifest.skills ?? [],
            signal: deps.signal,
          })
          let publishingOwnPinDirectory = false
          const guard = async () => {
            ensureLive()
            await assertSafeVaultPath(ctx.root, pinPath)
            await validateSource()
            const currentPinText = await readBoundedRegularText(pinPath, 'plugin pin').catch(
              (error) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
              },
            )
            if (currentPinText !== originalPinText)
              throw new CapabilityError('CONFLICT', `${id} vault pin changed during pin`)
            const current = await deps.store.get(id)
            if (
              current === null ||
              current.source.kind !== 'release' ||
              JSON.stringify(current.source) !== JSON.stringify(source) ||
              canonicalJson(current.manifest) !== canonicalJson(install.manifest)
            )
              throw new CapabilityError('CONFLICT', `${id} changed during pin`)
            await assertNoCompetingSkillClaims(ctx.root, id, install.manifest.skills ?? [], {
              allowIncompleteOwnPin: publishingOwnPinDirectory,
            })
            ensureLive()
          }
          await guard()
          // Publish vault assets first. In particular, a failed guide refresh must
          // leave the old pin truthful so the operation can be retried.
          const validateSnapshot = async (
            snapshots: Parameters<typeof validateSkillSnapshot>[4],
          ) => {
            await guard()
            await validateSkillSnapshot(
              expectedRoot,
              source.commit,
              source.path,
              install.manifest.skills ?? [],
              snapshots,
              deps.signal,
            )
            await guard()
          }
          const writtenGuides = await writeSkills(install.manifest, codeDir, ctx.root, {
            guard,
            expectedSnapshots,
            validateSnapshot,
          })
          const backupKey = `${ctx.root}\0${id}`
          const retainedBackups = writtenGuides.filter((path) => path.endsWith('(guide backups)'))
          if (retainedBackups.length)
            syncBackups.set(backupKey, [...new Set([...(syncBackups.get(backupKey) ?? []), ...retainedBackups])])
          await seedApps(install.manifest, codeDir, ctx.root, { guard })
          await linkRunningCommands(ctx.root, deps)
          await guard()
          const lines = install.manifest.ignore ?? []
          if (lines.length > 0) {
            let existing: string | null
            try {
              existing = await readBoundedRegularText(
                join(ctx.root, '.gitignore'),
                'vault .gitignore',
              )
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') existing = null
              else throw error
            }
            const next = gitignoreWith(existing, lines)
            if (next !== null) await writeAtomic(ctx.root, vaultRelPath('.gitignore'), next, guard)
          }
          const pinDir = join(ctx.root, PLUGIN_PINS_DIR, id)
          const pinDirWasAbsent = (await lstat(pinDir).catch(() => null)) === null
          publishingOwnPinDirectory = pinDirWasAbsent
          try {
            await writeAtomic(
              ctx.root,
              vaultRelPath(pluginPinPath(id)),
              `${JSON.stringify(pin, null, 2)}\n`,
              guard,
            )
          } catch (error) {
            publishingOwnPinDirectory = false
            if (pinDirWasAbsent) {
              const contents = await readdir(pinDir).catch(() => null)
              if (contents?.length === 0) await rmdir(pinDir).catch(() => {})
            }
            throw error
          }
          publishingOwnPinDirectory = false
          syncErrors.delete(`${ctx.root}\0${id}`)
        }),
    }),

    // A folder install's skills, which no pin writes: turning one on in a
    // vault gives its agent the skills as they are in the folder now.
    'community.skills': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) =>
        admit(async () => {
          ensureLive()
          const install = await installOf(id)
          if (install.source.kind !== 'dev')
            throw new CapabilityError('FORBIDDEN', `${id} is not a folder installation`)
          const codeDir = deps.store.codeDir(install)
          const guard = async () => {
            ensureLive()
            const current = await deps.store.get(id)
            if (
              current === null ||
              current.source.kind !== 'dev' ||
              JSON.stringify(current.source) !== JSON.stringify(install.source) ||
              canonicalJson(current.manifest) !== canonicalJson(install.manifest)
            ) throw new CapabilityError('CONFLICT', `${id} folder installation changed`)
            await assertNoCompetingSkillClaims(ctx.root, id, install.manifest.skills ?? [])
            ensureLive()
          }
          await guard()
          const result = [
            ...(await writeSkills(install.manifest, codeDir, ctx.root, { guard })),
            ...(await seedApps(install.manifest, codeDir, ctx.root, { guard, signal: deps.signal })),
          ]
          await guard()
          return result
        }),
    }),

    // Where a plugin's code is on this machine, for the vault's agent to run
    // its tools (Prezzi's skill renders slides with it). Only a plugin that
    // runs here: the commit someone allowed, set up.
    'community.path': cap({
      doors: ['cli'],
      cli: { args: ['id'], summary: "a running community plugin's folder on this machine" },
      params: idParams,
      run: async (ctx, { id }) =>
        admit(async () => {
          ensureLive()
          const entry = (await pluginEntries(ctx.root, deps)).find(({ row }) => row.id === id)
          if (entry === undefined || !entry.row.running || entry.install === null)
            throw new CapabilityError('NOT_FOUND', `${id} does not run in this vault here`)
          return deps.store.codeDir(entry.install)
        }),
      text: (dir) => dir,
    }),

    'community.refresh-skills': cap({
      doors: ['cli'],
      cli: {
        args: ['id'],
        flags: ['force'],
        values: [],
        summary:
          'refresh skills from this vault’s pinned community-plugin release; --force replaces complete skill folders, including local edits',
      },
      params: (raw) => ({
        id: stringParam(paramsObject(raw), 'id'),
        force: flagParam(paramsObject(raw), 'force'),
      }),
      run: async (ctx, { id, force }) =>
        admit(async () => {
          ensureLive()
          const deny: (message: string) => never = (message) => {
            throw new CapabilityError('FORBIDDEN', message)
          }
          if (!isCommunityPluginId(id, deps.firstPartyIds()))
            throw new CapabilityError('BAD_REQUEST', `${id} is not a valid community plugin id`)
          const pinPath = join(ctx.root, pluginPinPath(id))
          await assertSafeVaultPath(ctx.root, pinPath)
          const pinInfo = await lstat(pinPath).catch(() => null)
          if (
            !pinInfo?.isFile() ||
            pinInfo.isSymbolicLink() ||
            resolve(pinPath) !== pinPath ||
            (await realpath(pinPath).catch(() => null)) !== pinPath
          )
            deny(`${id} has no safe release pin in this vault`)
          let pin: PluginPin
          try {
            const parsed = parsePluginPin(
              JSON.parse(await readBoundedRegularText(pinPath, 'plugin pin')),
            )
            if (!parsed.ok || parsed.value.id !== id) throw new Error('invalid identity')
            pin = parsed.value
          } catch {
            return deny(`${id} has no valid release pin in this vault`)
          }
          const install = await deps.store.get(id)
          if (install === null || install.source.kind !== 'release')
            deny(`${id} is not an installed release`)
          const source = install.source
          if (
            pin.id !== install.id ||
            pin.repo !== source.repo ||
            pin.path !== source.path ||
            pin.commit !== source.commit
          )
            deny(`${id} installed release does not match this vault's complete pin`)
          if (!(await deps.consent.has(id, source.commit)) || install.setup !== 'ok')
            deny(`${id} is not consented and setup-ready`)
          const entries = await pluginEntries(ctx.root, deps)
          const entry = entries.find(({ row }) => row.id === id)
          if (entry === undefined || !entry.row.on || entry.row.status !== 'ready')
            deny(`${id} is disabled or not ready in this vault`)
          const skills = install.manifest.skills ?? []
          try {
            await assertNoCompetingSkillClaims(ctx.root, id, skills)
          } catch (error) {
            deny(String(error))
          }
          const codeDir = resolve(deps.store.codeDir(install))
          const expectedRoot = resolve(deps.store.releaseDir(id, source.commit))
          const expectedDir = resolve(expectedRoot, source.path)
          if (codeDir !== expectedDir || !insidePath(expectedRoot, codeDir))
            deny(`${id} source provenance does not match its pinned release`)
          const rootReal = await realpath(expectedRoot).catch(() => null)
          const codeReal = await realpath(codeDir).catch(() => null)
          if (rootReal !== expectedRoot || codeReal !== codeDir)
            deny(`${id} release paths are not canonical`)
          const manifest = await readManifest(codeDir, source.path).catch(() => null)
          if (
            manifest === null ||
            canonicalJson(manifest) !== canonicalJson(install.manifest) ||
            canonicalJson(manifest) !== canonicalJson(manifestFromPin(pin))
          )
            deny(`${id} release checkout does not match its complete pin`)
          let expectedSnapshots
          try {
            expectedSnapshots = await prepareAuthenticatedRelease({
              root: expectedRoot,
              commit: source.commit,
              sourcePath: source.path,
              originUrl: deps.git.url(source.repo),
              manifest,
              skills,
              signal: deps.signal,
            })
          } catch (error) {
            deny(`${id} release checkout does not match its pin: ${String(error)}`)
          }
          const guard = async () => {
            ensureLive()
            await assertSafeVaultPath(ctx.root, pinPath)
            const [currentPin, currentInstall, consented, settings] = await Promise.all([
              readBoundedRegularText(pinPath, 'plugin pin').catch(() => null),
              deps.store.get(id),
              deps.consent.has(id, source.commit),
              readVaultSettings(ctx.root),
            ])
            let parsedPin: PluginPin | null = null
            try {
              const parsed = parsePluginPin(JSON.parse(currentPin ?? ''))
              if (parsed.ok) parsedPin = parsed.value
            } catch {
              /* fail closed below */
            }
            const currentEntry = (await pluginEntries(ctx.root, deps)).find(
              ({ row }) => row.id === id,
            )
            if (
              !parsedPin ||
              canonicalJson(parsedPin) !== canonicalJson(pin) ||
              currentInstall === null ||
              currentInstall.source.kind !== 'release' ||
              JSON.stringify(currentInstall.source) !== JSON.stringify(source) ||
              canonicalJson(currentInstall.manifest) !== canonicalJson(install.manifest) ||
              !consented ||
              currentInstall.setup !== 'ok' ||
              settings.plugins.vault[id] !== true ||
              !currentEntry?.row.on ||
              currentEntry.row.status !== 'ready'
            )
              deny(`${id} authorization changed during refresh`)
            const nowRoot = await realpath(expectedRoot).catch(() => null)
            const nowDir = await realpath(codeDir).catch(() => null)
            if (nowRoot !== expectedRoot || nowDir !== codeDir)
              deny(`${id} release provenance changed during refresh`)
            await assertCheckoutIdentity(
              expectedRoot,
              source.commit,
              deps.git.url(source.repo),
              deps.signal,
            ).catch(() => deny(`${id} release provenance changed during refresh`))
            try {
              await assertManifestPinned(
                expectedRoot,
                source.commit,
                source.path,
                install.manifest,
                deps.signal,
              )
            } catch (error) {
              deny(`${id} manifest provenance changed during refresh: ${String(error)}`)
            }
            await assertNoCompetingSkillClaims(ctx.root, id, skills).catch((error) =>
              deny(String(error)),
            )
            ensureLive()
          }
          return refreshSkills(install.manifest, codeDir, ctx.root, {
            force,
            guard,
            expectedSnapshots,
            validateSnapshot: async (snapshots) => {
              await guard()
              try {
                await validateSkillSnapshot(
                  expectedRoot,
                  source.commit,
                  source.path,
                  skills,
                  snapshots,
                  deps.signal,
                )
              } catch (error) {
                deny(`${id} private snapshot does not match pinned Git objects: ${String(error)}`)
              }
              await guard()
            },
          })
        }),
      text: (paths) => paths.join('\n'),
    }),

    // A running plugin's verbs, `holi plugin <id> <verb> …`: read here and
    // run by the `holi` script in its own place (`verbs.ts`). Each call asks,
    // as any command does, until the person allows that plugin's verb.
    'plugin.run': cap({
      doors: ['cli'],
      cli: {
        args: [],
        rest: true,
        summary: "a running community plugin's verbs: holi plugin <id> <verb> [arguments]",
      },
      params: (raw): { argv: string[] } => {
        const argv = paramsObject(raw).argv
        if (!Array.isArray(argv) || !argv.every((w) => typeof w === 'string'))
          throw new CapabilityError('BAD_REQUEST', 'argv must be a list of words')
        return { argv }
      },
      run: async (ctx, { argv }): Promise<VerbAnswer> =>
        admit(async () => {
          ensureLive()
          const running: RunningPlugin[] = []
          for (const { row, install } of await pluginEntries(ctx.root, deps)) {
            if (!row.running || install === null) continue
            running.push({
              id: row.id,
              name: row.name,
              ...(install.manifest.cli === undefined ? {} : { cli: install.manifest.cli }),
              codeDir: deps.store.codeDir(install),
            })
          }
          return resolveVerb(argv, running, ctx.root)
        }),
      cliRun: (answer) => (answer.kind === 'run' ? answer.run : null),
      text: (answer) => (answer.kind === 'text' ? answer.text : ''),
    }),

    'community.unpin': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) => {
        await rm(join(ctx.root, PLUGIN_PINS_DIR, vaultRelPath(id)), {
          recursive: true,
          force: true,
        })
        await linkRunningCommands(ctx.root, deps)
      },
    }),

    // Take it off this machine: its code, its setup and every consent to it.
    // A vault's pin stays, and offers it again.
    'community.remove': cap({
      doors: ['ui'],
      params: idParams,
      run: async (ctx, { id }) =>
        deps.mutate(async () => {
          // Its servers first: their code is about to go.
          await deps.supervisor.stopAll((key) => parseServerKey(key).id === id)
          ensureLive()
          const install = await deps.store.remove(id)
          await deps.consent.forget(id)
          await deps.checks.forget(ctx.root, id)
          await linkRunningCommands(ctx.root, deps)
          if (install?.source.kind === 'release')
            await rm(join(deps.store.releaseDir(id, install.source.commit), '..'), {
              recursive: true,
              force: true,
            })
        }),
    }),

    // The server for a file a plugin opens, started if none is up. Resolves
    // with its port once it answers, and a lease that holds it until
    // `release` returns it. A failed acquire holds nothing.
    'community.acquire': cap({
      doors: ['ui'],
      params: pathParam,
      run: async (ctx, { path }) => {
        const admitted = await admit(async () => {
          ensureLive()
          const entries = await pluginEntries(ctx.root, deps)
          ensureLive()
          const entry = entries.find(({ row }) => row.on && servedFile(row, path) !== null)
          if (entry === undefined) throw new CapabilityError('NOT_FOUND', `no plugin opens ${path}`)
          if (!entry.row.running)
            throw new CapabilityError(
              'FORBIDDEN',
              `${entry.row.name} is not ready on this machine (${entry.row.status})`,
            )
          if (entry.install === null)
            throw new CapabilityError('NOT_FOUND', `${entry.row.id} is not installed here`)
          const { row, install } = entry
          const file = await resolveRelative(ctx.root, servedFile(row, path)!)
          const key = serverKey(ctx.root, row.id, path)
          const bridge = deps.bridgeScript()
          const cwd = deps.store.codeDir(install)
          // Path canonicalization can yield while this attachment is closed.
          // Do not acquire a server after close's stopAll sweep has passed.
          ensureLive()
          const start = deps.supervisor.acquire(key, {
            cwd,
            argv: (port) => expandCommand(install.manifest.serve!, { file, vault: ctx.root, port }),
            env: (port) =>
              pluginEnv({
                HOLI_VAULT_ROOT: ctx.root,
                HOLI_FILE: file,
                HOLI_PORT: String(port),
                ...(bridge === null ? {} : { HOLI_BRIDGE_SCRIPT: bridge }),
              }),
          })
          return { row, install, start }
        })
        // Keep readiness outside the FIFO so a remove/update can stop this start.
        const acquired = await admitted.start
        try {
          return await admit(async () => {
            ensureLive()
            const current = await deps.store.get(admitted.row.id)
            const same =
              current !== null &&
              current.source.kind === admitted.install.source.kind &&
              JSON.stringify(current.source) === JSON.stringify(admitted.install.source) &&
              current.manifest.version === admitted.install.manifest.version &&
              deps.store.codeDir(current) === deps.store.codeDir(admitted.install)
            if (
              !same ||
              !acquired.isCurrentAndRunning() ||
              deps.live?.() === false ||
              deps.signal?.aborted
            ) {
              throw new CapabilityError(
                'FORBIDDEN',
                'community installation changed while starting',
              )
            }
            const lease = randomUUID()
            leases.set(lease, acquired.release)
            return { id: admitted.row.id, port: acquired.port, lease }
          })
        } catch (error) {
          await acquired.release()
          throw error
        }
      },
    }),

    'community.release': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ lease: stringParam(paramsObject(raw), 'lease') }),
      run: async (_ctx, { lease }) => {
        const release = leases.get(lease)
        if (release === undefined) return
        leases.delete(lease)
        await release()
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
  for (const capability of Object.values(table)) {
    const mutable = capability as { run: (ctx: never, params: never) => Promise<unknown> }
    const run = mutable.run
    mutable.run = async (ctx, params) => {
      if (deps.live?.() === false)
        throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
      try {
        return await (deps.run ? deps.run(() => run(ctx, params)) : run(ctx, params))
      } catch (error) {
        if (deps.signal?.aborted || deps.live?.() === false)
          throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
        throw error
      }
    }
  }
  return table
}

/** The vault a server key belongs to, and its file, for events. */
function parseServerKey(key: string): { root: string; id: string; path: string } {
  const [root, id, path] = key.split('\0')
  return { root: root!, id: id!, path: path! }
}

/**
 * Copy the apps of every plugin that runs in the vault at `root` and is not
 * there yet: at the vault's open, and once a plugin is set up in it. A
 * `.local.app` never syncs, so this is how each machine gets its own.
 */
export async function seedRunningApps(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent'>,
): Promise<string[]> {
  const written: string[] = []
  for (const row of await listPlugins(root, deps)) {
    if (!row.running || row.apps.length === 0) continue
    const install = await deps.store.get(row.id)
    if (install === null) continue
    written.push(...(await seedApps(install.manifest, deps.store.codeDir(install), root)))
  }
  return written
}

/**
 * Run the readiness check of every plugin that runs in the vault at `root`
 * and has one (`checks.ts`), or only of `ids`: those not asked yet, or all of
 * them with `fresh`. A plugin that does not run has its answer forgotten.
 * Resolves true when any was asked. Never throws.
 */
export async function runChecks(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent' | 'checks'>,
  opts: { ids?: readonly string[]; fresh?: boolean } = {},
): Promise<boolean> {
  try {
    const asked = []
    for (const row of await listPlugins(root, deps)) {
      // Turned off, or no longer ready: what its check said no longer holds,
      // so turning it on again asks afresh.
      if (!row.running) {
        await deps.checks.forget(root, row.id)
        continue
      }
      if (opts.ids !== undefined && !opts.ids.includes(row.id)) continue
      if (!opts.fresh && deps.checks.get(root, row.id) !== null) continue
      const install = await deps.store.get(row.id)
      const check = install?.manifest.check
      if (install === null || check === undefined) continue
      asked.push(deps.checks.run(root, row.id, check, deps.store.codeDir(install)))
    }
    await Promise.all(asked)
    return asked.length > 0
  } catch (err) {
    console.error('[community] checks:', err)
    return false
  }
}

/**
 * Link the commands of every plugin that runs in the vault at `root`
 * (`commands.ts`): at the vault's open, and whenever what runs in it may have
 * changed. Never throws: the pin, setup or removal that asked for it has
 * happened either way, so a failure is logged and returned.
 */
export async function linkRunningCommands(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent' | 'searchPath'>,
): Promise<LinkedCommands> {
  const running = async () => {
    const plugins = []
    for (const row of await listPlugins(root, deps)) {
      if (!row.running || row.bin.length === 0) continue
      const install = await deps.store.get(row.id)
      if (install?.manifest.bin === undefined) continue
      plugins.push({ id: row.id, bin: install.manifest.bin, codeDir: deps.store.codeDir(install) })
    }
    return plugins
  }
  try {
    return await linkCommands(root, running, deps.searchPath?.() ?? toolPath())
  } catch (err) {
    console.error('[community] commands:', err)
    return { linked: [], refused: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * As the community plugin stops: when it no longer runs in the vault at
 * `root` (turned off, or a plugin it needs is), its plugins' commands go too.
 * Not when the vault is left or Holi quits, which leave the settings on: the
 * vault's background sessions still run, and its next open links them again.
 */
export async function unlinkWhenOff(root: string, infos: readonly PluginInfo[]): Promise<void> {
  const settings = await readVaultSettings(root).catch(() => null)
  if (settings === null) return
  if (resolvePlugins(settings.plugins, infos).running.has(COMMUNITY_INFO.id)) return
  await unlinkCommands(root).catch((err) => console.error('[community] commands:', err))
}
