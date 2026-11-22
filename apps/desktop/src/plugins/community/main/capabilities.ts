/**
 * Community plugins' capabilities, nearly all at the UI door only: installing,
 * consenting to and running code is the person's own act in the settings
 * tab, never something an app or the agent can ask for. At the CLI door are
 * a running plugin's folder (`holi community path`) and its verbs
 * (`holi plugin`, `verbs.ts`), each only for a plugin someone allowed here.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isCommunityPluginId,
  isPluginId,
  isPluginPath,
  isRepoName,
  parsePluginPin,
  PLUGIN_PINS_DIR,
  pluginPinPath,
  resolvePlugins,
  vaultRelPath,
  type PluginInfo,
  type PluginManifest,
  type PluginPin,
} from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  paramsObject,
  flagParam,
  readVaultSettings,
  writeVaultSettings,
  withFileLock,
  stringParam,
  toolPath,
  UnconfirmedOwnedProgramError,
  type CapabilityContext,
  type CapabilityTable,
} from '../../../main/plugin-api'
import type { Checks, CheckResult } from './checks'
import type { ConsentStore } from './consent'
import {
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
import { publishPin } from './pin-publication'
import { assertSafePublicationPath, readOptionalPublicationText } from './publication-files'
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
import { installCommit, installOf, installTransactions } from './install-transactions'
import { serverAuthorization } from './server-authorization'
import {
  assertInstallLaunchable,
  assertInstallProgramDrained,
  installIsReserved,
  installProgramFailure,
  retainInstallProgramFailure,
} from './owner'
import type { Install, InstallStore } from './store'
import type { Supervisor } from './supervisor'
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
  /** Opaque displayed-snapshot identity required to adopt a folder over a pin. */
  folderAdoptionToken?: string
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
  /** The readiness check's last answer (`checks.ts`), or a retained cleanup
   *  failure. Null when there is nothing to report. */
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
  /** Serialize machine mutations and then notify attachments. */
  mutate<T>(work: () => Promise<T>): Promise<T>
  /** Serialize resource reads with machine-wide mutations. */
  admit?<T>(work: () => Promise<T>): Promise<T>
  forgetChecks?(id: string): Promise<void>
  notifyMutation?(): Promise<void>
  context?: { root: string; remote: string }
  /** The admitting attachment's lifetime, including host activation revocation. */
  signal?: AbortSignal
  live?: () => boolean
  run?<T>(work: () => Promise<T>): Promise<T>
  /** The `PATH` the vault's agent inherits, before Holi's own folders: a
   *  plugin's command may not take a name already on it. By default
   *  `toolPath()`: a Dock-launched Holi's own `PATH` lacks the folders the
   *  person's shell, and so the agent's commands, have. */
  searchPath?(): string
}

export interface AttachmentAdmission {
  admit: NonNullable<CommunityDeps['admit']>
  ensureContext(ctx: CapabilityContext): void
  /** The original attachment's activation, even if the vault is later reopened. */
  signal?: AbortSignal
}

const pinIds = (root: string) => readdir(join(root, PLUGIN_PINS_DIR)).catch(() => [] as string[])

/** The vault's pins, by id; an unreadable one is left out. */
async function readPinRecords(
  root: string,
  only?: string,
): Promise<Map<string, { pin: PluginPin; text: string }>> {
  const pins = new Map<string, { pin: PluginPin; text: string }>()
  const ids = only === undefined ? await pinIds(root) : isPluginId(only) ? [only] : []
  for (const id of ids) {
    const text = await readBoundedRegularText(join(root, pluginPinPath(id)), 'plugin pin').catch(
      () => null,
    )
    if (text === null) continue
    try {
      const parsed = parsePluginPin(JSON.parse(text))
      if (parsed.ok && parsed.value.id === id) pins.set(id, { pin: parsed.value, text })
    } catch {
      // Not JSON: not a pin.
    }
  }
  return pins
}

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
  folderAdoptionToken?: string,
): PluginRow {
  const manifest: PluginManifest = (install?.manifest ?? pin)!
  return {
    ...(syncErrors.get(`${root}\0${id}`) === undefined
      ? {}
      : { syncError: syncErrors.get(`${root}\0${id}`) }),
    ...(syncBackups.get(`${root}\0${id}`) === undefined
      ? {}
      : { syncBackups: syncBackups.get(`${root}\0${id}`) }),
    ...(folderAdoptionToken === undefined ? {} : { folderAdoptionToken }),
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

export type ReadPluginEntries = typeof pluginEntries

/** Pair each authorized row with the install snapshot it describes. */
async function pluginEntries(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent'> & { checks?: Checks },
  only?: string,
) {
  const [pinRecords, installs, settings] = await Promise.all([
    readPinRecords(root, only),
    only === undefined ? deps.store.list() : deps.store.get(only).then((i) => (i ? [i] : [])),
    readVaultSettings(root),
  ])
  const communityOn = resolvePlugins(settings.plugins, [COMMUNITY_INFO]).running.has(
    COMMUNITY_INFO.id,
  )
  const byId = new Map<string, Install>()
  for (const install of installs) if (!byId.has(install.id)) byId.set(install.id, install)
  const ids = [...new Set([...pinRecords.keys(), ...byId.keys()])].sort()
  const localOff = new Set(settings.plugins.localOff)
  return Promise.all(
    ids.map(async (id) => {
      const install = byId.get(id) ?? null
      const pin = pinRecords.get(id)?.pin ?? null
      const status = await statusOf(install, pin, deps.consent)
      const on = settings.plugins.vault[id] === true
      const check = deps.checks?.get(root, id) ?? null
      const folderAdoptionToken =
        install?.source.kind === 'dev' && pin !== null
          ? createHash('sha256')
              .update(canonicalJson(install))
              .update('\0')
              .update(pinRecords.get(id)!.text)
              .digest('hex')
          : undefined
      const row = rowOf(
        root,
        id,
        install,
        pin,
        status,
        on,
        linkedIn(root),
        check,
        folderAdoptionToken,
      )
      const cleanupError = installProgramFailure(deps.store, id)
      if (cleanupError) row.check = { ok: false, hint: cleanupError.message }
      return {
        row,
        install,
        pin,
        // Keep the settings UI's row semantics distinct from launch authority.
        enabled: communityOn && on && !localOff.has(id),
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

const assertSafeVaultPath = assertSafePublicationPath

function insidePath(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

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
  const [records, installs, settings] = await Promise.all([
    readPinRecords(root),
    deps.store.list(),
    readVaultSettings(root),
  ])
  for (const { pin, text } of records.values()) {
    const install = installs.find((item) => item.id === pin.id)
    if (
      !settings.plugins.vault[pin.id] ||
      settings.plugins.localOff.includes(pin.id) ||
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
      const guard = async () => {
        if (deps.live?.() === false || deps.signal?.aborted)
          throw new Error('community attachment is closed')
        const [currentInstall, consented, currentSettings, currentPinText] = await Promise.all([
          deps.store.get(install.id),
          deps.consent.has(install.id, source.commit),
          readVaultSettings(root),
          readOptionalPublicationText(join(root, pluginPinPath(pin.id)), 'plugin pin'),
        ])
        if (
          currentInstall === null ||
          currentInstall.source.kind !== 'release' ||
          JSON.stringify(currentInstall.source) !== JSON.stringify(source) ||
          canonicalJson(currentInstall.manifest) !== canonicalJson(install.manifest) ||
          currentInstall.setup !== 'ok' ||
          !consented ||
          currentSettings.plugins.vault[install.id] !== true ||
          currentSettings.plugins.localOff.includes(install.id) ||
          currentPinText !== text
        )
          throw new Error('automatic community update authorization changed')
        await assertNoCompetingSkillClaims(root, install.id, install.manifest.skills ?? [])
        if (deps.live?.() === false || deps.signal?.aborted)
          throw new Error('community attachment is closed')
      }
      await publishPin({
        root,
        install,
        pin: next,
        originalPinText: text,
        store: deps.store,
        git: deps.git,
        signal: deps.signal,
        live: deps.live,
        guard,
        onBackups: (paths) =>
          syncBackups.set(key, [...new Set([...(syncBackups.get(key) ?? []), ...paths])]),
      })
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

  const admit = deps.admit ?? (<T>(work: () => Promise<T>) => work())

  const signal = deps.signal
  const ensureLive = () => {
    if (deps.live?.() === false || signal?.aborted)
      throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
  }

  const ensureContext = (ctx: CapabilityContext) => {
    ensureLive()
    ctx.assertCurrent?.()
    if (deps.context && (ctx.root !== deps.context.root || ctx.remote !== deps.context.remote))
      throw new CapabilityError('FORBIDDEN', 'community attachment does not own this vault')
  }

  const admission = { admit, ensureContext, signal }
  const installs = installTransactions(deps, admission, {
    listPlugins,
    linkRunningCommands,
    seedRunningApps,
    runChecks,
  })
  const servers = serverAuthorization(deps, admission, { pluginEntries, listPlugins })

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
      run: (ctx, params) => installs.install(ctx, params),
    }),

    // A folder the person works on, used in place: their own code, so no
    // consent is asked, and it is never pinned.
    'community.installFolder': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ folder: stringParam(paramsObject(raw), 'folder') }),
      run: (ctx, { folder }) => installs.installFolder(ctx, folder),
    }),

    'community.consent': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), commit: stringParam(p, 'commit') }
      },
      run: (ctx, { id, commit }) => installs.consent(ctx, id, commit),
    }),

    // Run the manifest's setup, its output streaming as `setup-log` events.
    'community.setup': cap({
      doors: ['ui'],
      params: idParams,
      run: (ctx, { id }) => installs.setup(ctx, id),
    }),

    // Ask a running plugin's readiness check again, for its settings row and
    // the vault notice. Resolves with the row as it stands after.
    'community.check': cap({
      doors: ['ui'],
      params: idParams,
      run: (ctx, { id }) => checkPlugin(ctx, id, deps, admission),
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
          const install = await installOf(deps.store, id)
          if (install.source.kind !== 'release')
            throw new CapabilityError(
              'BAD_REQUEST',
              `${id} is a folder on this machine; pin a release`,
            )
          const source = install.source
          const [consented, settings] = await Promise.all([
            deps.consent.has(id, source.commit),
            readVaultSettings(ctx.root),
          ])
          if (install.setup !== 'ok' || !consented || settings.plugins.localOff.includes(id))
            throw new CapabilityError(
              'FORBIDDEN',
              `${id} is not consented, setup-ready and enabled here`,
            )
          const pin: PluginPin = {
            ...install.manifest,
            repo: source.repo,
            path: source.path,
            commit: source.commit,
          }
          const pinPath = join(ctx.root, pluginPinPath(id))
          await assertSafeVaultPath(ctx.root, pinPath)
          const originalPinText = await readOptionalPublicationText(pinPath, 'plugin pin')
          const guard = async () => {
            ensureLive()
            const [current, consented, settings] = await Promise.all([
              deps.store.get(id),
              deps.consent.has(id, source.commit),
              readVaultSettings(ctx.root),
            ])
            if (
              !current ||
              current.source.kind !== 'release' ||
              JSON.stringify(current.source) !== JSON.stringify(source) ||
              canonicalJson(current.manifest) !== canonicalJson(install.manifest) ||
              current.setup !== 'ok' ||
              !consented ||
              settings.plugins.localOff.includes(id)
            )
              throw new CapabilityError(
                'FORBIDDEN',
                `${id} is not consented, setup-ready and enabled`,
              )
            await assertNoCompetingSkillClaims(ctx.root, id, install.manifest.skills ?? [], {
              allowIncompleteOwnPin: originalPinText === null,
            })
            ensureLive()
          }
          const backupKey = `${ctx.root}\0${id}`
          await publishPin({
            root: ctx.root,
            install,
            pin,
            originalPinText,
            store: deps.store,
            git: deps.git,
            signal: deps.signal,
            live: deps.live,
            guard,
            onBackups: (paths) =>
              syncBackups.set(backupKey, [
                ...new Set([...(syncBackups.get(backupKey) ?? []), ...paths]),
              ]),
          })
          await linkRunningCommands(ctx.root, deps)
          syncErrors.delete(backupKey)
        }),
    }),

    // Prepare a folder install before relinquishing the vault's release pin.
    // The exact install and pin snapshots bind this multi-file operation.
    'community.adoptFolder': cap({
      doors: ['ui'],
      params: (raw: unknown) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), token: stringParam(p, 'token') }
      },
      run: async (ctx, { id, token }) =>
        admit(async () => {
          ensureLive()
          const install = await installOf(deps.store, id)
          if (install.source.kind !== 'dev')
            throw new CapabilityError('FORBIDDEN', `${id} is not a folder installation`)
          const pinPath = join(ctx.root, pluginPinPath(id))
          await assertSafeVaultPath(ctx.root, pinPath)
          const originalPin = await readOptionalPublicationText(pinPath, 'plugin pin')
          if (originalPin === null)
            throw new CapabilityError('CONFLICT', `${id} has no release pin`)
          const displayedToken = createHash('sha256')
            .update(canonicalJson(install))
            .update('\0')
            .update(originalPin)
            .digest('hex')
          if (token !== displayedToken)
            throw new CapabilityError(
              'CONFLICT',
              `${id} folder installation or pin changed; look again`,
            )
          const guard = async () => {
            ensureLive()
            const [current, currentPin] = await Promise.all([
              deps.store.get(id),
              readOptionalPublicationText(pinPath, 'plugin pin'),
            ])
            if (
              !current ||
              current.source.kind !== 'dev' ||
              JSON.stringify(current.source) !== JSON.stringify(install.source) ||
              canonicalJson(current.manifest) !== canonicalJson(install.manifest) ||
              currentPin !== originalPin
            )
              throw new CapabilityError('CONFLICT', `${id} folder installation or pin changed`)
            await assertNoCompetingSkillClaims(ctx.root, id, install.manifest.skills ?? [])
            ensureLive()
          }
          await guard()
          const codeDir = deps.store.codeDir(install)
          const key = `${ctx.root}\0${id}`
          const skills = await writeSkills(install.manifest, codeDir, ctx.root, { guard })
          const backups = skills.filter((path) => path.endsWith('(guide backups)'))
          if (backups.length)
            syncBackups.set(key, [...new Set([...(syncBackups.get(key) ?? []), ...backups])])
          const apps = await seedApps(install.manifest, codeDir, ctx.root, {
            guard,
            signal: deps.signal,
          })
          await guard()
          const guardAfterUnpin = async () => {
            ensureLive()
            const current = await deps.store.get(id)
            const currentPin = await readOptionalPublicationText(pinPath, 'plugin pin')
            if (
              !current ||
              current.source.kind !== 'dev' ||
              JSON.stringify(current.source) !== JSON.stringify(install.source) ||
              canonicalJson(current.manifest) !== canonicalJson(install.manifest) ||
              currentPin !== null
            )
              throw new CapabilityError(
                'CONFLICT',
                `${id} folder installation changed during adoption`,
              )
            ensureLive()
          }
          try {
            await withFileLock(resolve(pinPath), async () => {
              await guard()
              const finalPin = await readOptionalPublicationText(pinPath, 'plugin pin')
              ensureLive()
              if (finalPin !== originalPin)
                throw new CapabilityError('CONFLICT', `${id} folder pin changed before adoption`)
              await rm(pinPath, { force: true })
              await rmdir(dirname(pinPath)).catch(() => {})
            })
            await guardAfterUnpin()
            await writeVaultSettings(
              ctx.root,
              { committed: { plugins: { [id]: true } } },
              { beforeWrite: guardAfterUnpin },
            )
          } catch (error) {
            await withFileLock(resolve(pinPath), async () => {
              await assertSafeVaultPath(ctx.root, pinPath)
              const currentPin = await readOptionalPublicationText(pinPath, 'plugin pin')
              if (currentPin !== null) return
              await mkdir(dirname(pinPath), { recursive: true })
              await writeFile(pinPath, originalPin, { flag: 'wx' })
            })
            throw error
          }
          await linkRunningCommands(ctx.root, deps)
          return [...skills, ...apps]
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
          const install = await installOf(deps.store, id)
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
            )
              throw new CapabilityError('CONFLICT', `${id} folder installation changed`)
            await assertNoCompetingSkillClaims(ctx.root, id, install.manifest.skills ?? [])
            ensureLive()
          }
          await guard()
          const key = `${ctx.root}\0${id}`
          const skills = await writeSkills(install.manifest, codeDir, ctx.root, { guard })
          const backups = skills.filter((path) => path.endsWith('(guide backups)'))
          if (backups.length)
            syncBackups.set(key, [...new Set([...(syncBackups.get(key) ?? []), ...backups])])
          const apps = await seedApps(install.manifest, codeDir, ctx.root, {
            guard,
            signal: deps.signal,
          })
          await guard()
          return [...skills, ...apps]
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
            deny(`${id} release checkout does not match its pin (complete pin metadata differs)`)
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
          ensureContext(ctx)
          const id = isPluginId(argv[0]) ? argv[0] : undefined
          // Admission alone is not enough: an install keeps its reservation
          // while waiting for native drain outside the queue.
          if (id !== undefined) assertInstallLaunchable(deps.store, id)
          const entries = await pluginEntries(ctx.root, deps)
          ensureContext(ctx)
          if (id !== undefined) assertInstallLaunchable(deps.store, id)
          const running: RunningPlugin[] = []
          for (const { row, install } of entries) {
            if ((id !== undefined && row.id !== id) || !row.running || install === null) continue
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
      run: (ctx, { id }) => installs.remove(ctx, id),
    }),

    // The server for a file a plugin opens, started if none is up. Resolves
    // with its port once it answers, and a lease that holds it until
    // `release` returns it. A rejected publication drops only its own reference.
    'community.acquire': cap({
      doors: ['ui'],
      params: pathParam,
      run: (ctx, { path }) => servers.acquire(ctx, path),
    }),

    'community.release': cap({
      doors: ['ui'],
      params: (raw: unknown) => ({ lease: stringParam(paramsObject(raw), 'lease') }),
      run: (_ctx, { lease }) => servers.release(lease),
    }),

    // What the file's server is doing, for a tab that mounts while it starts.
    'community.server': cap({
      doors: ['ui'],
      params: pathParam,
      run: (ctx, { path }) => servers.state(ctx, path),
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
        if (error instanceof UnconfirmedOwnedProgramError) throw error
        if (signal?.aborted || deps.live?.() === false)
          throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
        throw error
      }
    }
  }
  return table
}

/**
 * Copy the apps of every plugin that runs in the vault at `root` and is not
 * there yet: at the vault's open, and once a plugin is set up in it. A
 * `.local.app` never syncs, so this is how each machine gets its own.
 */
export async function seedRunningApps(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent'> & { signal?: AbortSignal; live?: () => boolean },
): Promise<string[]> {
  const written: string[] = []
  for (const row of await listPlugins(root, deps)) {
    if (!row.running || row.apps.length === 0) continue
    const install = await deps.store.get(row.id)
    if (install === null) continue
    const guard = async () => {
      if (deps.live?.() === false || deps.signal?.aborted)
        throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
      const [current, settings, consented] = await Promise.all([
        deps.store.get(row.id),
        readVaultSettings(root),
        install.source.kind === 'release'
          ? deps.consent.has(install.id, install.source.commit)
          : Promise.resolve(true),
      ])
      if (
        current === null ||
        JSON.stringify(current.source) !== JSON.stringify(install.source) ||
        canonicalJson(current.manifest) !== canonicalJson(install.manifest) ||
        (install.source.kind === 'release' && current.setup !== 'ok') ||
        !consented ||
        settings.plugins.vault[row.id] !== true ||
        settings.plugins.localOff.includes(row.id) ||
        deps.live?.() === false ||
        deps.signal?.aborted
      )
        throw new CapabilityError('FORBIDDEN', `${row.id} app seeding authorization changed`)
    }
    const options: Parameters<typeof seedApps>[3] = { guard, signal: deps.signal }
    if (install.source.kind === 'release')
      Object.assign(options, {
        release: {
          root: resolve(deps.store.releaseDir(install.id, install.source.commit)),
          commit: install.source.commit,
          sourcePath: install.source.path,
        },
      })
    written.push(...(await seedApps(install.manifest, deps.store.codeDir(install), root, options)))
  }
  return written
}

function readinessSpec({
  install,
  pin,
  enabled,
  row,
}: Awaited<ReturnType<typeof pluginEntries>>[number]) {
  const check = install?.manifest.check
  if (!enabled || !row.running || install === null || check === undefined) return null
  return { install, check, fingerprint: canonicalJson({ install, pin }) }
}

/** An explicit request must return a current answer, not just join a drain. */
async function checkPlugin(
  ctx: CapabilityContext,
  id: string,
  deps: Pick<CommunityDeps, 'store' | 'consent' | 'checks'>,
  { admit, ensureContext }: AttachmentAdmission,
): Promise<PluginRow> {
  const { root } = ctx
  let joined: Awaited<ReturnType<Checks['run']>> | undefined
  const assertAdmission = () => {
    ensureContext(ctx)
    assertInstallLaunchable(deps.store, id)
  }
  try {
    for (;;) {
      const attempt = await admit(async () => {
        assertAdmission()
        const [entry] = await pluginEntries(root, deps, id)
        assertAdmission()
        const spec = entry === undefined ? null : readinessSpec(entry)
        if (entry === undefined || spec === null) {
          const completion = deps.checks.invalidate(root, id)
          if (completion !== undefined) return { completion }
          if (entry === undefined) throw new CapabilityError('NOT_FOUND', `${id} is not here`)
          const { row, enabled } = entry
          return {
            row: {
              ...row,
              running: enabled && row.running,
              commandsNote: enabled ? row.commandsNote : null,
              check: null,
            },
          }
        }
        if (joined?.kind === 'stopped')
          throw new CapabilityError('FORBIDDEN', 'community readiness checks are closed')
        const answer = joined?.answerSince(spec.fingerprint)
        if (answer != null) return { row: { ...entry.row, check: answer } }
        // Spawn and publish the owned join in this admission turn, but never
        // hold the machine queue while the exact native process drains.
        const { install, check, fingerprint } = spec
        return {
          completion: deps.checks.run(root, id, check, deps.store.codeDir(install), fingerprint),
        }
      })
      if (attempt.row !== undefined) return attempt.row
      joined = await attempt.completion
      // Re-enter with the original attachment; neither EMPTY nor a completed
      // readiness answer authorizes a launch or publication on its own.
    }
  } catch (error) {
    retainInstallProgramFailure(deps.store, id, error)
    throw error
  }
}

type CheckOptions = {
  intent?: 'refresh'
  ids?: readonly string[]
  fresh?: boolean
  passive?: boolean
}

/**
 * Run the readiness check of every plugin that runs in the vault at `root`
 * and has one (`checks.ts`), or only of `ids`: those not asked yet, or all of
 * them with `fresh`. A plugin that does not run has its answer forgotten.
 * Resolves true when a row was asked or has a retained cleanup failure to show.
 * Refreshes skip reserved installs even when scoped to particular `ids`.
 * Passive refresh also invalidates old answers and reports unconfirmed cleanup
 * per row. Explicit requests go through checkPlugin, not this catalogue refresh.
 */
export async function runChecks(
  root: string,
  deps: Pick<CommunityDeps, 'store' | 'consent' | 'checks' | 'admit' | 'signal'>,
  opts: CheckOptions = {},
): Promise<boolean> {
  const { ids: targets, fresh, passive } = opts
  const admit = deps.admit ?? (<T>(work: () => Promise<T>) => work())
  const { signal } = deps
  if (signal?.aborted) return false
  try {
    // Discover candidates without inspecting every pin up front. Their
    // settings, pin and install are read fresh at their own admission turn.
    let ids = targets
    if (ids === undefined) {
      const [pins, installs] = await Promise.all([pinIds(root), deps.store.list()])
      ids = [
        ...new Set([...pins.filter(isPluginId), ...installs.map((install) => install.id)]),
      ].sort()
    }
    const answers = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          if (passive) {
            const { forgotten } = await admit(async () => ({
              forgotten:
                signal?.aborted || installIsReserved(deps.store, id)
                  ? undefined
                  : deps.checks.forget(root, id),
            }))
            await forgotten
          }
          const { completion, ran } = await admit(async () => {
            if (signal?.aborted || installIsReserved(deps.store, id)) return {}
            const [entry] = await pluginEntries(root, deps, id)
            if (signal?.aborted) return {}
            if (!entry?.enabled || !entry.row.running)
              return { completion: deps.checks.forget(root, id) }
            if (!passive && !fresh && deps.checks.get(root, id) !== null) return {}
            const spec = readinessSpec(entry)
            if (spec === null) return {}
            const { install, check, fingerprint } = spec
            assertInstallProgramDrained(deps.store, id)
            const cwd = deps.store.codeDir(install)
            // The check runner calls spawn synchronously. Do not yield after
            // testing the original attachment's activation here.
            if (signal?.aborted) return {}
            return {
              completion: deps.checks.run(root, id, check, cwd, fingerprint),
              ran: true,
            }
          })
          await completion
          return ran === true
        } catch (error) {
          retainInstallProgramFailure(deps.store, id, error)
          if (passive && error instanceof UnconfirmedOwnedProgramError) return true
          throw error
        }
      }),
    )
    for (const answer of answers)
      if (answer.status === 'rejected' && answer.reason instanceof UnconfirmedOwnedProgramError)
        throw answer.reason
    for (const answer of answers) if (answer.status === 'rejected') throw answer.reason
    return answers.some((answer) => answer.status === 'fulfilled' && answer.value)
  } catch (err) {
    if (err instanceof UnconfirmedOwnedProgramError) throw err
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
