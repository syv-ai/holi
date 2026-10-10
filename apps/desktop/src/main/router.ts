/**
 * The router: main's typed API, and the seam the renderer calls over IPC.
 * Documents are identified by vault-relative path.
 *
 * There is deliberately **no authorization here**, and there must never be one:
 * with no server, a check running on the machine of the person it restricts is
 * theatre. GitHub decides what leaves, at push time (docs/features/auth.md).
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { initTRPC, TRPCError } from '@trpc/server'
import {
  completeTask,
  isAgentSurfacePath,
  parseTaskFile,
  parseTaskPatch,
  serializeTaskFile,
  vaultRelPath,
  withIcon,
  ICONS_FILE,
  type Task,
  type TaskPatch,
  type VaultEntry,
  type VaultRelPath,
  parseThemePatch,
  RECENTS_CAP,
  type RecentEntry,
  VAULT_MARKER_FILE,
} from '@holi/shared'
import type { SeedResult } from './vault/seed/types'
import { searchBodies, type SearchHit } from './vault/search'
import { CapabilityError, trpcCodeOf } from './capabilities/error'
import { createCapabilityHost, type CapabilityHost } from './capabilities/dispatch'
import { createCapabilityRegistry } from './capabilities/registry'
import { noCoreServices, type UiReport } from './capabilities/services'
import { scanBackrefs, scanBackrefsMany } from './vault/backrefs'
import { fileHistory, type FileHistory } from './vault/file-facts'
import { copyNotes } from './vault/copy'
import { importFiles } from './vault/import-files'
import { exportFiles } from './vault/export-files'
import { moveNotes } from './vault/move'
import { getOrCreateDaily, sweepDaily } from './vault/daily'
import { openRepo, remoteUrl, type Commit } from './git'
import { GitHubApiError, type Repo } from './github/api'
import type { DeviceFlow } from './github/device-flow'
import { createMembersCache, type MembersCache } from './github/members-cache'
import type { GitHubSession } from './github/session'
import type { ActiveVault, SyncState, VaultHost } from './vault/active-vault'
import { ensureClone } from './vault/clone'
import { pruneEmptiedFolder, removeDocFile, writeAtomic, absPathFor } from './vault/vault-files'
import { renameNote } from './vault/rename'
import { scanVault, type ScanClaim, type VaultSnapshot } from './vault/vault-store'
import { holiTheme, readVaultTheme, resetVaultTheme, writeVaultTheme } from './vault/theme'
import { readVaultSettings, writeVaultSettings } from './vault/settings'
import { knownTransforms, parsePluginSettingsPatch, parseSettingsPatch } from '@holi/shared'
import { installedInfos } from './plugin-host/installed'
import type { PreCommitStatus, ResolvedTheme, ResolvedVaultSettings } from '@holi/shared'
import type { VaultPreCommit } from './vault/hooks/pre-commit'
import { isRemote, repoName, type VaultRegistry } from './vault/registry'
import type { UpdateStatus } from './updates/state'
import type { Updater } from './updates/updater'

const t = initTRPC.create()

/**
 * What the renderer is allowed to know about who is signed in, and nothing
 * beyond it.
 *
 * Hand-written rather than `Omit<StoredAuth, 'token'>`, because an `Omit` would
 * silently re-include whatever gets added to `StoredAuth` later. `accountId` is
 * absent on purpose too: it is our identity key, not the renderer's, and it has
 * no use for it.
 */
export interface PublicViewer {
  login: string
  name?: string
  avatarUrl?: string
}

/**
 * Where you stand on a vault's GitHub repo, for leaving and deleting it.
 * `gone`: GitHub no longer shows it to you. `accessVia` names the organization
 * your access comes through when it is not yours to drop; `others` are the
 * other collaborators, whom a delete takes it from too.
 */
export type VaultMembership =
  | { kind: 'gone' }
  | { kind: 'live'; owned: boolean; canAdmin: boolean; accessVia: string | null; others: string[] }

export interface RouterDeps {
  registry: VaultRegistry
  session: GitHubSession
  /** Which vault is open, and everything running behind it. */
  host: VaultHost
  /**
   * Write what a vault must have (`vault/seed/seed.ts`), over the seed
   * contributions the composition root assembled. Run before a vault goes
   * live, on add and on every open.
   */
  seed: (root: string) => Promise<SeedResult>
  /**
   * Start the plugins the vault at `root` enables (`plugin-host/host.ts`).
   * Run after the seed on add and open, and after a write to its plugins.
   * `opened` activates them in the vault once it is open. `scanClaimsFor`
   * is what the scanner claims in the vault at `root`.
   */
  plugins: {
    enter(root: string): Promise<void>
    opened(): Promise<void>
    scanClaimsFor(root: string): Promise<readonly ScanClaim[]>
  }
  /** The managed root clones live under — `~/Holi` in the app, a tmpdir in
   *  tests. Passed in rather than read from `vaultRoot()` here so the router
   *  has no ambient dependency on the environment. */
  vaultRoot: string
  /**
   * Where to clone a remote *from*. Defaults to its credential-free GitHub URL.
   *
   * A seam rather than a constant because the URL is not always derivable from
   * `owner/repo`: a GitHub Enterprise host is a different origin, and a local
   * bare repo is how the sync engine is exercised without a token at all.
   */
  cloneUrlFor?: (remote: string) => string
  /**
   * Electron's `shell.openExternal`, injected rather than imported so this
   * module keeps typechecking and testing under plain Node.
   *
   * Sign-in opens `github.com/login/device` in the **system** browser, so the
   * grant reuses the user's existing GitHub session and no credential enters
   * the app's web context; sharing deep-links to the repo's collaborator
   * settings, because Holi does not implement invitation.
   */
  openExternal: (url: string) => Promise<void>
  /**
   * Move a directory to the OS trash (Electron's `shell.trashItem`), injected
   * for the same reason as `openExternal`.
   *
   * Sign-out's "also delete local clones" uses this rather than a hard `rm`, on
   * purpose: a clone removed by mistake is recoverable from the trash. A
   * destructive account action should be undoable.
   */
  trashItem: (path: string) => Promise<void>
  /** The vault's own `.pre-commit-config.yaml`: its status here, and this
   *  person's allowance (`vault/hooks/pre-commit.ts`). Absent in tests that do
   *  not reach it. */
  preCommit?: Pick<VaultPreCommit, 'status' | 'allow' | 'disallow'>
  /** Wall-clock, injected so `lastOpenedAt` is testable. */
  now?: () => string
  /**
   * Today, **local**, as `YYYY-MM-DD` — the frame a recurrence rolls against.
   *
   * Separate from `now()` rather than sliced off it: `now()` is a UTC instant,
   * and for anyone west of Greenwich its date reads as yesterday for part of the
   * evening. The machine's local time is the only frame there is.
   */
  today?: () => string
  /**
   * The capability host the composition root built over its registry, shared
   * with the CLI door (`capabilities/dispatch.ts`); `cap.run` and `cap.names`
   * go through it. Optional so a test router builds without it; absent, every
   * method is "no such method".
   */
  capabilities?: CapabilityHost
  /** The collaborator lists the capability services read too, so Settings
   *  and an app share one. Optional: absent, the router keeps its own. */
  members?: MembersCache
  /** Where the renderer's report of what the person is looking at lands (the
   *  agent's focus file, the bridge's recents). Optional like the rest:
   *  absent, a report is dropped. */
  reportUi?: (remote: string, report: UiReport) => void
  /** Updating Holi itself (`updates/updater.ts`). Optional: absent, as in
   *  tests, the app reads as a build that cannot update. */
  updates?: Omit<Updater, 'dispose'>
  /** Whether Holi opens at login, this machine's login item. Optional: absent,
   *  as in tests, it reads as off and cannot be set. */
  loginItem?: { get(): boolean; set(open: boolean): void }
}

/** `YYYY-MM-DD` in the machine's own timezone. `toISOString().slice(0, 10)`
 * would be the UTC date, which is a different day for much of the world for
 * much of the day. */
export function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whether a clone carries the `.holi/vault` marker — i.e. it is a Holi vault
 * rather than an arbitrary repo. The durable on-disk twin of the `holi-vault`
 * GitHub topic (github/api.ts). Its EXISTENCE is the whole signal; the one line
 * inside is a format version nothing branches on yet. */
async function isVaultClone(root: string): Promise<boolean> {
  return readFile(join(root, VAULT_MARKER_FILE), 'utf8').then(
    () => true,
    () => false,
  )
}

/** A tiny validator, so the router keeps its input contract without pulling in a
 * schema library for four shapes. Each one throws on anything it did not ask
 * for; tRPC turns that into a BAD_REQUEST. */
type FieldKind = 'string' | 'string?' | 'boolean' | 'boolean?'

/** What a spec entry produces once parsed. */
type ValueOf<K extends FieldKind> = K extends 'boolean' | 'boolean?' ? boolean : string

type Parsed<T extends Record<string, FieldKind>> = {
  [K in keyof T as T[K] extends `${string}?` ? never : K]: ValueOf<T[K]>
} & {
  // Genuinely optional, not "required and possibly undefined". tRPC infers a
  // procedure's input from this type, so the difference is whether a caller may
  // omit the key at all — and every optional field here is one a caller omits.
  [K in keyof T as T[K] extends `${string}?` ? K : never]?: ValueOf<T[K]>
}

/**
 * Booleans are **checked, never coerced**: a coerced `"false"` reads as true,
 * which is how a calendar silently switches back on.
 */
function fields<T extends Record<string, FieldKind>>(spec: T) {
  return (raw: unknown): Parsed<T> => {
    if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
    const input = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, kind] of Object.entries(spec)) {
      const value = input[key]
      const wanted = kind.startsWith('boolean') ? 'boolean' : 'string'
      if (value === undefined || value === null) {
        if (kind.endsWith('?')) continue
        throw new Error(`${key} is required`)
      }
      if (typeof value !== wanted) throw new Error(`${key} must be a ${wanted}`)
      out[key] = value
    }
    return out as never
  }
}

/** Batch inputs the `fields` helper cannot express. Each throws on a
 *  bad shape; tRPC turns that into a BAD_REQUEST. The RETURN type is the client's
 *  input contract (tRPC infers it), so the keys here are what callers pass. */
function pairsOf(raw: unknown, key: 'moves' | 'copies'): { from: string; to: string }[] {
  if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
  const arr = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) throw new Error(`${key} must be an array`)
  return arr.map((p) => {
    if (p === null || typeof p !== 'object') throw new Error(`each ${key} entry must be an object`)
    const { from, to } = p as Record<string, unknown>
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new Error(`${key} entries need string from and to`)
    }
    return { from, to }
  })
}

function movesInput(raw: unknown): { remote: string; moves: { from: string; to: string }[] } {
  return { ...fields({ remote: 'string' })(raw), moves: pairsOf(raw, 'moves') }
}

function copiesInput(raw: unknown): { remote: string; copies: { from: string; to: string }[] } {
  return { ...fields({ remote: 'string' })(raw), copies: pairsOf(raw, 'copies') }
}

/** A list of strings from an untrusted input. Shared by the drop-import, whose
 *  sources are absolute OS paths rather than vault paths and so cannot ride
 *  `pathsInput`'s vault-relative contract. */
function stringsOrThrow(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error('sources must be an array of strings')
  }
  return value as string[]
}

function pathsInput(raw: unknown): { remote: string; paths: string[] } {
  const { remote } = fields({ remote: 'string' })(raw)
  return { remote, paths: stringList(raw, 'paths') }
}

function stringList(raw: unknown, key: string): string[] {
  const list = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return list as string[]
}

/** `pathsInput`, plus the folders the delete was aimed at (optional). */
function deleteManyInput(raw: unknown): { remote: string; paths: string[]; folders: string[] } {
  const folders = (raw as Record<string, unknown>).folders
  return {
    ...pathsInput(raw),
    folders: folders === undefined ? [] : stringList(raw, 'folders'),
  }
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date().toISOString())
  const today = deps.today ?? localToday
  const cloneUrlFor = deps.cloneUrlFor ?? remoteUrl
  const capabilities =
    deps.capabilities ??
    createCapabilityHost({
      registry: createCapabilityRegistry(),
      rootFor: async (remote) =>
        (await deps.registry.list()).find((e) => e.remote === remote)?.path ?? null,
      active: () => deps.host.active(),
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: (root) => deps.plugins.scanClaimsFor(root),
    })
  const members =
    deps.members ?? createMembersCache((remote) => deps.session.api.collaborators(remote))

  /**
   * A write must be visible to the very next read.
   *
   * `vaults.snapshot` answers from `ActiveVault`'s cache, and the filesystem
   * watcher is only a *hint* that genuinely drops `add` events on macOS, so a
   * create-then-re-read would race a debounce the renderer cannot see.
   *
   * Rescanning here rather than in `vaults.snapshot` keeps the read cheap: a
   * read is answered from memory, and a *write* is what invalidates it. A
   * middleware, so the next write procedure gets it without remembering to.
   *
   * It refreshes even when the mutation failed, on purpose. "Already exists" is
   * precisely the case where the caller's picture of the vault is wrong, so that
   * is the worst possible moment to skip the resync.
   */
  const refreshesVault = t.middleware(async (opts) => {
    const result = await opts.next()
    if (opts.type !== 'mutation') return result
    const raw = (await opts.getRawInput()) as { remote?: unknown } | null
    const active = deps.host.active()
    // Only the live vault has a cache to go stale; a write to any other vault is
    // read straight off disk by `vaults.snapshot` anyway.
    if (active !== null && active.remote === raw?.remote) {
      await active.refresh().catch((err) => console.error('[router] post-write rescan:', err))
    }
    return result
  })

  /** Every procedure that writes into a vault. Use this rather than
   *  `t.procedure` so the cache cannot be left behind — see `refreshesVault`. */
  const vaultMutation = t.procedure.use(refreshesVault)

  /** The open vault, or a refusal. Every `sync.*` procedure goes through here so
   *  "nothing is open" is one message rather than a null dereference. */
  function activeOrThrow(): ActiveVault {
    const active = deps.host.active()
    if (active === null) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no vault is open' })
    }
    return active
  }

  /**
   * Clone-or-adopt, seed, register, open. The order matters at both ends:
   * nothing is registered until the clone is really there (a half-registered
   * vault is one the switcher can never open), and the seed runs before the
   * vault goes live so the `.gitignore` is in place before any commit can be.
   */
  async function addVault(
    remote: string,
    url: string | undefined,
    opts: { requireVault?: boolean } = {},
  ): Promise<VaultSnapshot> {
    const { repo, outcome } = await ensureClone({
      root: deps.vaultRoot,
      remote,
      url: url ?? cloneUrlFor(remote),
      deps: { token: () => deps.session.token() },
    })
    // Joining an existing vault (not creating one) — refuse anything that is not
    // already a vault. The seed below would otherwise write `AGENTS.md`,
    // `.claude/` and friends into a plain code repo and the auto-push would carry
    // them upstream, quietly turning someone's codebase into a half-vault. The
    // marker is the `.holi/vault` the seed commits at creation. A repo we
    // just cloned for this is removed on refusal so nothing is left behind; a
    // pre-existing adopted path is left exactly as we found it.
    if (opts.requireVault && !(await isVaultClone(repo.root))) {
      if (outcome.kind === 'cloned') await rm(repo.root, { recursive: true, force: true })
      throw new Error(
        `${remote} is not a Holi vault. Create a new vault instead of adopting this repo.`,
      )
    }
    await deps.seed(repo.root)
    await deps.plugins.enter(repo.root)
    await deps.registry.add({
      remote,
      path: repo.root,
      name: repoName(remote),
      lastOpenedAt: now(),
    })
    const active = await deps.host.open(remote)
    await deps.plugins.opened()
    return active.snapshot()
  }

  /** remote -> the clone's root on this machine. Every path-taking procedure
   * goes through here, so an unknown vault fails once, in one place. */
  async function rootFor(remote: string): Promise<string> {
    const entry = (await deps.registry.list()).find((e) => e.remote === remote)
    if (!entry) throw new TRPCError({ code: 'NOT_FOUND', message: `no such vault: ${remote}` })
    return entry.path
  }

  /** The vault's contents: the live cache when the vault asked about is the open
   * one — a second walk could only disagree with what the renderer already has —
   * and a fresh scan otherwise. */
  async function snapshotFor(remote: string): Promise<VaultSnapshot> {
    const active = deps.host.active()
    if (active?.remote === remote) return active.snapshot()
    const root = await rootFor(remote)
    return scanVault(root, await deps.plugins.scanClaimsFor(root))
  }

  /** Every path from the renderer or the agent re-validates here. This is the
   * only thing between an input and the user's filesystem (architecture §8). */
  function safe(path: string): VaultRelPath {
    try {
      return vaultRelPath(path)
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
    }
  }

  /** Field edits are validated by the module that owns the format, not by a
   * second vocabulary here that could drift from it. */
  function patchOrThrow(raw: unknown): TaskPatch {
    try {
      return parseTaskPatch(raw)
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
    }
  }

  /** The renderer-facing projection of the session. */
  function publicViewer(): PublicViewer | null {
    const v = deps.session.viewer
    return v === null ? null : { login: v.login, name: v.name, avatarUrl: v.avatarUrl }
  }

  /**
   * Which `owner` to hand `createRepo`. GitHub can only create a repo under the
   * signed-in user (`POST /user/repos`, no owner) or an org they belong to
   * (`POST /orgs/{org}/repos`) — there is no "create under another user". So an
   * owner that IS the viewer must collapse to `undefined`; otherwise the org
   * endpoint 404s on the personal-account name, which is exactly what the
   * onboarding owner picker sends by default.
   */
  function repoOwner(owner: string | undefined): string | undefined {
    return owner && owner !== deps.session.viewer?.login ? owner : undefined
  }

  /**
   * Every GitHub call goes through here, so the mapping from *which kind of no*
   * to what the renderer is told lives in one place.
   *
   * The SSO URL rides in the message because it is advice for a human: a
   * `FORBIDDEN` with no URL is a dead end.
   */
  async function gh<T>(fn: () => Promise<T>): Promise<T> {
    // Refuse before the request rather than sending an unauthenticated one and
    // letting a 401 arrive at the same place by accident.
    if (deps.session.token() === null) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'not signed in to GitHub' })
    }
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof GitHubApiError)) throw err
      throw new TRPCError({
        code: TRPC_CODE[err.kind],
        message: err.ssoUrl ? `${err.message}: ${err.ssoUrl}` : err.message,
      })
    }
  }

  /** The signed-in login. `gh` has already refused a missing token, and a
   *  token is only ever stored with its viewer. */
  function viewerLogin(): string {
    const login = deps.session.viewer?.login
    if (!login) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'not signed in to GitHub' })
    return login
  }

  /** GitHub logins are case-insensitive. */
  const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  /**
   * Commit and push `remote`, then report what is still only here.
   *
   * The open vault goes through its own loop, which knows how to recover from
   * a rejected push. Any other vault was flushed when it was closed, so a dirty
   * tree there is someone's edit made outside Holi: it counts as stuck rather
   * than being committed from here, where its pre-commit hook has no endpoint.
   */
  async function settleVault(remote: string): Promise<{ ahead: number; dirty: boolean }> {
    const active = deps.host.active()
    if (active?.remote === remote) {
      await active.commitNow()
      await active.pushNow()
      const { ahead, dirty } = await active.repo.status()
      return { ahead, dirty }
    }
    const repo = openRepo(await rootFor(remote), { token: () => deps.session.token() })
    let status = await repo.status()
    if (status.ahead > 0 && !status.dirty) {
      try {
        let pushed = await repo.push()
        if (pushed.kind === 'rejected' && pushed.reason === 'non-fast-forward') {
          if ((await repo.pull()).kind !== 'conflict') pushed = await repo.push()
        }
      } catch (err) {
        // Offline, or the remote is gone: the status below says what is left.
        console.error(`[vaults] could not push ${remote}:`, err)
      }
      status = await repo.status()
    }
    return { ahead: status.ahead, dirty: status.dirty }
  }

  /** The guard on every removal that could lose work: settle, and refuse if
   *  anything is still only on this machine. The dialog settles first and says
   *  so; this is the backstop. */
  async function refuseIfStuck(remote: string): Promise<void> {
    const { ahead, dirty } = await settleVault(remote)
    if (ahead > 0 || dirty) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'this vault has work that has not reached GitHub',
      })
    }
  }

  /**
   * One vault's clone to the OS Trash, and out of the registry: sign-out's
   * `deleteClones`, for one vault. Closed first when it is the open one, so no
   * watcher or timer fires into a moved tree. Trash before unregister, so a
   * clone that will not move stays listed rather than orphaned.
   */
  async function removeClone(remote: string): Promise<void> {
    const root = await rootFor(remote)
    if (deps.host.active()?.remote === remote) await deps.host.close()
    await deps.trashItem(root)
    await deps.registry.remove(remote)
  }

  /** The remote is interpolated into a URL, so it is validated before it is. */
  function safeRemote(remote: string): string {
    if (!isRemote(remote)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `not an owner/repo remote: ${remote}` })
    }
    return remote
  }

  /**
   * The sign-in in progress.
   *
   * The device flow is two-phase — a code to show, then a grant that lands
   * later — and a tRPC procedure returns once. So `signIn` stashes the flow and
   * `awaitSignIn` waits on it: the renderer paints the code immediately and
   * long-polls for the verdict, rather than polling `auth.status` and guessing
   * when to stop.
   */
  let signInFlow: DeviceFlow | null = null

  const auth = t.router({
    status: t.procedure.query(() => ({ viewer: publicViewer() })),

    signIn: t.procedure.mutation(async () => {
      signInFlow = await deps.session.signIn()
      // The URI GitHub returned, never a hardcoded one — the code on screen
      // belongs to whatever it said.
      await deps.openExternal(signInFlow.code.verificationUri)
      return signInFlow.code
    }),

    awaitSignIn: t.procedure.mutation(async () => {
      if (signInFlow === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'no sign-in in progress' })
      }
      const result = await signInFlow.wait()
      signInFlow = null
      // The token stops here. The renderer gets the identity and nothing else.
      return result.kind === 'granted'
        ? { kind: 'granted' as const, viewer: publicViewer() }
        : { kind: result.kind }
    }),

    cancelSignIn: t.procedure.mutation(() => {
      signInFlow?.cancel()
      return { ok: true as const }
    }),

    signOut: t.procedure.mutation(async () => {
      // The keychain entry goes, the clones stay. Removing one is a separate,
      // deliberate act: `deleteClones`, or leaving or deleting a vault.
      await deps.session.signOut()
      // Another account may see other members, or none.
      members.forget()
      return { ok: true as const }
    }),
  })

  const github = t.router({
    repos: t.procedure.query((): Promise<Repo[]> => gh(() => deps.session.api.repos())),

    orgs: t.procedure.query(() => gh(() => deps.session.api.orgs())),

    collaborators: t.procedure.input(fields({ remote: 'string' })).query(({ input }) =>
      gh(async () => {
        const remote = safeRemote(input.remote)
        // Visibility arrives *with* the members rather than from a second call
        // the UI could forget to make: a vault silently becoming public is the
        // highest-severity thing that can happen to it, and this panel is the
        // only surface that would ever show it.
        // The list is cached; the visibility never is.
        const [repo, collaborators] = await Promise.all([
          deps.session.api.repo(remote),
          members.get(remote),
        ])
        return { visibility: repo.visibility, collaborators }
      }),
    ),

    openCollaboratorSettings: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }) => {
        // Holi does not implement invitation; it points at the flow that does.
        // Settings is about to change who is in it: whatever list is read
        // after this asks GitHub rather than the cache. An invite shows once
        // accepted, so it can still take a cache lifetime to appear.
        members.forget(safeRemote(input.remote))
        await deps.openExternal(`https://github.com/${safeRemote(input.remote)}/settings/access`)
        return { ok: true as const }
      }),

    createRepo: t.procedure
      .input(fields({ name: 'string', owner: 'string?' }))
      .mutation(({ input }): Promise<Repo> =>
        gh(() => deps.session.api.createRepo({ name: input.name, owner: repoOwner(input.owner) })),
      ),
  })

  const vaults = t.router({
    list: t.procedure.query((): Promise<VaultEntry[]> => deps.registry.list()),

    open: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<VaultSnapshot> => {
        // Opening is what starts the watcher and the sync loop — the snapshot
        // is a by-product, and comes from the vault that is now live rather
        // than from a second read that could already disagree with it.
        const root = await rootFor(input.remote)
        /**
         * Seed on **open**, not only on clone, for what an open may still
         * do: create a missing once-file and merge `.claude/settings.json`.
         * Skills and hooks are written only at creation.
         *
         * Before `host.open`, for `addVault`'s reason: nothing can be committed
         * ahead of the `.gitignore`.
         */
        await deps.seed(root)
        await deps.plugins.enter(root)
        await deps.registry.touch(input.remote, now())
        const active = await deps.host.open(input.remote)
        await deps.plugins.opened()
        return active.snapshot()
      }),

    add: t.procedure
      .input(fields({ remote: 'string', url: 'string?' }))
      // Clone the chosen repo into the managed root and open it, but only if it
      // is already a vault (see `addVault`'s `requireVault`).
      .mutation(({ input }) =>
        addVault(safeRemote(input.remote), input.url, { requireVault: true }),
      ),

    create: t.procedure
      .input(fields({ name: 'string', owner: 'string?', url: 'string?' }))
      // A private repo, seeded, committed, pushed, opened.
      .mutation(async ({ input }): Promise<VaultSnapshot> => {
        const repo = await gh(() =>
          deps.session.api.createRepo({ name: input.name, owner: repoOwner(input.owner) }),
        )
        const snapshot = await addVault(repo.remote, input.url)
        // The seed is the repo's first commit, and it has to leave the machine:
        // a "vault" that exists only locally is not one anybody can be invited
        // to. A brand-new repo should not wait out the coalesce timer to become
        // shareable, so kick the push explicitly.
        const active = deps.host.active()
        if (active !== null) {
          await active.commitNow()
          await active.pushNow()
        }
        // Mark it a vault ONLY here, after its content has been pushed. The
        // topic is what the picker filters on, so setting it earlier would leave
        // a topic'd-but-empty repo in everyone's "join" list that the adopt
        // guard then refuses.
        await gh(() => deps.session.api.markVault(repo.remote))
        return snapshot
      }),

    snapshot: t.procedure
      .input(fields({ remote: 'string' }))
      .query(({ input }): Promise<VaultSnapshot> => snapshotFor(input.remote)),

    remove: t.procedure
      .input(fields({ remote: 'string' }))
      // Deregisters the vault; the clone stays on disk. Deleting someone's files
      // — which may hold unpushed commits — is never a side effect here.
      .mutation(({ input }) => deps.registry.remove(input.remote)),

    // What "also delete local clones" would throw away. One
    // entry per registered clone with commits that never reached the remote, so
    // the sign-out dialog can warn before deleting. Advisory and best-effort: a
    // clone whose status can't be read (a local-fixture repo, a broken clone) is
    // omitted rather than breaking the whole summary — `status().ahead` needs the
    // upstream ref, which every real managed clone has.
    unpushed: t.procedure.query(async (): Promise<{ remote: string; ahead: number }[]> => {
      const out: { remote: string; ahead: number }[] = []
      for (const e of await deps.registry.list()) {
        try {
          const { ahead } = await openRepo(e.path).status()
          if (ahead > 0) out.push({ remote: e.remote, ahead })
        } catch {
          // best-effort: skip a clone we can't inspect
        }
      }
      return out
    }),

    // Sign-out's optional "also delete local clones". **Recoverable on
    // purpose:** each clone goes to the OS trash, not `rm -rf`, so a vault
    // deleted by mistake can be restored.
    //
    // Close the active vault first: its watcher and autosave/push timers run on
    // the clone dir, and trashing it out from under them would fire events into a
    // moved tree. `close()` also flushes and pushes the active vault on the way
    // out, so its work reaches the remote before the local copy goes. Per-clone
    // best-effort: one that won't trash stays on disk AND in the registry, never
    // orphaned.
    deleteClones: t.procedure.mutation(async (): Promise<{ ok: true }> => {
      await deps.host.close()
      for (const e of await deps.registry.list()) {
        try {
          await deps.trashItem(e.path)
          await deps.registry.remove(e.remote)
        } catch (err) {
          console.error(`[vaults] could not trash clone ${e.remote}:`, err)
        }
      }
      return { ok: true as const }
    }),

    /**
     * What this person may do to the vault on GitHub, for the leave and delete
     * dialogs. `gone` is a remote GitHub no longer shows them: deleted,
     * or their access was taken away. Either way the clone is all that is left.
     */
    membership: t.procedure
      .input(fields({ remote: 'string' }))
      .query(({ input }): Promise<VaultMembership> =>
        gh(async () => {
          const remote = safeRemote(input.remote)
          const login = viewerLogin()
          let repo: Repo
          try {
            repo = await deps.session.api.repo(remote)
          } catch (err) {
            if (err instanceof GitHubApiError && err.kind === 'not-found') return { kind: 'gone' }
            throw err
          }
          const owned = repo.owner.kind === 'user' && sameLogin(repo.owner.login, login)
          const [collaborators, direct] = await Promise.all([
            // Names for the delete confirm only: a listing GitHub refuses must
            // not stop someone leaving.
            members.get(remote).catch(() => []),
            // A personal repo has no other kind of access to have.
            owned || repo.owner.kind === 'user'
              ? true
              : deps.session.api.isDirectCollaborator(remote, login),
          ])
          return {
            kind: 'live',
            owned,
            canAdmin: repo.canAdmin,
            accessVia: direct ? null : repo.owner.login,
            others: collaborators.map((c) => c.login).filter((l) => !sameLogin(l, login)),
          }
        }),
      ),

    /**
     * Get the vault's work onto its remote, and say what could not go.
     * Leaving and deleting both wait on this: nothing is trashed while work is
     * stuck on this machine.
     */
    settle: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(({ input }) => settleVault(safeRemote(input.remote))),

    /**
     * Drop your own access on GitHub, then the clone. Refused for a vault
     * you own: an owner who wants out deletes it. Access that comes through an
     * organization is not yours to drop, so it stays, and the answer says whose
     * it is.
     */
    leave: t.procedure.input(fields({ remote: 'string' })).mutation(({ input }) =>
      gh(async (): Promise<{ accessVia: string | null }> => {
        const remote = safeRemote(input.remote)
        const login = viewerLogin()
        const repo = await deps.session.api.repo(remote)
        if (repo.owner.kind === 'user' && sameLogin(repo.owner.login, login)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'you own this vault: delete it instead of leaving',
          })
        }
        await refuseIfStuck(remote)
        const direct =
          repo.owner.kind === 'user' || (await deps.session.api.isDirectCollaborator(remote, login))
        if (direct) {
          await deps.session.api.removeCollaborator(remote, login)
          members.forget(remote)
        }
        await removeClone(remote)
        return { accessVia: direct ? null : repo.owner.login }
      }),
    ),

    /** Delete is GitHub's to do: this opens the repo's settings, whose
     *  Danger Zone holds it, and `forgetDeleted` follows once it is done. */
    openRepoSettings: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }) => {
        await deps.openExternal(`https://github.com/${safeRemote(input.remote)}/settings`)
        return { ok: true as const }
      }),

    /**
     * The clone of a vault that is gone from GitHub goes to the Trash.
     * Main asks GitHub itself rather than taking the renderer's word: the clone
     * is only let go once the remote answers 404, so a repo still standing keeps
     * its local copy (`gone: false`) however the dialog got here.
     */
    forgetDeleted: t.procedure.input(fields({ remote: 'string' })).mutation(({ input }) =>
      gh(async (): Promise<{ gone: boolean }> => {
        const remote = safeRemote(input.remote)
        try {
          await deps.session.api.repo(remote)
          return { gone: false }
        } catch (err) {
          if (!(err instanceof GitHubApiError) || err.kind !== 'not-found') throw err
        }
        await removeClone(remote)
        return { gone: true }
      }),
    ),

    // "Commit anyway" for a file the large-file gate held back: the user has
    // decided this big asset belongs in git. Bypasses the pre-commit hook.
    commitFile: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await openRepo(await rootFor(input.remote)).commitFileNoVerify(safe(input.path))
        return { ok: true as const }
      }),

    // "Keep local" for a held-back file: git-ignore it machine-locally so it
    // stays on disk but never commits or syncs (`.git/info/exclude`).
    keepFileLocal: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await openRepo(await rootFor(input.remote)).excludeLocally(safe(input.path))
        return { ok: true as const }
      }),
  })

  /** Does this file exist? The existence half of "create must not clobber". */
  async function exists(root: string, rel: VaultRelPath): Promise<boolean> {
    return (await readFile(absPathFor(root, rel), 'utf8').catch(() => null)) !== null
  }

  /** The task at `rel`, or a 404. An unparseable task file throws too: a field
   * edit has nothing to merge into, and the honest place to fix bad frontmatter
   * is the editor, on the text itself. */
  async function readTask(root: string, rel: VaultRelPath): Promise<Task> {
    const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
    if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: rel })
    try {
      return parseTaskFile(text, rel)
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `${rel}: ${(err as Error).message}` })
    }
  }

  const tasks = t.router({
    update: vaultMutation
      .input((raw: unknown) => ({
        ...fields({ remote: 'string', path: 'string' })(raw),
        patch: patchOrThrow((raw as { patch?: unknown }).patch ?? {}),
      }))
      .mutation(async ({ input }): Promise<Task> => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        // Read-modify-write: the file is the task, so an edit is a parse, a
        // merge and a full rewrite.
        const next = patched(await readTask(root, rel), input.patch)
        await writeAtomic(root, rel, serializeTaskFile(next))
        return next
      }),

    /**
     * The horizontal drag axis: moving a card to another lane moves the
     * `task.<name>.md` file into that folder and rewrites inbound `[[wiki-links]]`.
     * A task's path is its identity, so a lane change IS a rename, reusing
     * `renameNote`'s link-rewriting pass, never a second.
     *
     * A `status` rides along for a DIAGONAL drop (lane + column in one gesture):
     * it is written in place first, so the single `renameNote` carries the final
     * content to the destination and a card is never half-dropped
     * (docs/features/tasks.md). `done` is completion (`patched`), so a
     * recurring task advances instead of persisting done.
     *
     * The basename rides along unchanged (identity slug preserved, not re-slugged
     * from `title`), and a destination that already exists is refused rather than
     * silently suffixed, which would change an existing task's identity.
     */
    move: vaultMutation
      .input((raw: unknown) => {
        const base = fields({
          remote: 'string',
          path: 'string',
          folder: 'string',
          status: 'string?',
        })(raw)
        // Validated by `patchOrThrow` with the status.
        const order = (raw as { order?: number }).order
        return order === undefined ? base : { ...base, order }
      })
      .mutation(async ({ input }): Promise<Task> => {
        const root = await rootFor(input.remote)
        const from = safe(input.path)
        const basename = from.slice(from.lastIndexOf('/') + 1)
        const to = safe(input.folder ? `${input.folder}/${basename}` : basename)
        // The card's place in its new cell rides along like the status: a drop
        // lands where it was aimed, and is still one write.
        const fieldPatch = {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...('order' in input ? { order: input.order } : {}),
        }
        const hasPatch = Object.keys(fieldPatch).length > 0

        if (to === from && !hasPatch) return readTask(root, to)
        if (to !== from && (await exists(root, to))) {
          throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${to}` })
        }

        if (hasPatch) {
          const task = await readTask(root, from)
          const next = patched(task, patchOrThrow(fieldPatch))
          await writeAtomic(root, from, serializeTaskFile(next))
        }

        if (to !== from) await renameNote(root, from, to)
        return readTask(root, to)
      }),

    delete: vaultMutation
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await removeDocFile(await rootFor(input.remote), safe(input.path))
        return { ok: true as const }
      }),
  })

  /**
   * A patch applied to a task. **Done is completion**, wherever it comes from
   * (a field edit, a drop into Done, the card's checkbox): on a recurring task
   * it is the next occurrence, not the end of the series (`completeTask`).
   * The merge SPREADS rather than testing for undefined: a key
   * present-and-undefined is how `parseTaskPatch` spells "clear this field".
   */
  function patched(task: Task, patch: TaskPatch): Task {
    const next = { ...task, ...patch }
    return patch.status === 'done' ? { ...next, ...completeTask(next, today()) } : next
  }

  /**
   * Bytes for a file the renderer renders itself (the PDF viewer). The
   * `holi-vault://` protocol serves the same bytes to `<img>`, but a renderer
   * `fetch` of it fails on CORS, and giving the protocol a permissive header
   * would open it to the sandboxed vault-app frames too: a packaged `file://`
   * renderer sends the same `null` origin they do, so no origin check could tell
   * them apart. So bytes cross the IPC seam instead, as a `Uint8Array` that
   * structured clone carries verbatim.
   */
  const files = t.router({
    read: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<Uint8Array> => {
        const abs = absPathFor(await rootFor(input.remote), safe(input.path))
        const buf = await readFile(abs).catch(() => null)
        if (buf === null) throw new TRPCError({ code: 'NOT_FOUND', message: input.path })
        // A fresh copy, not the Buffer: small Buffers are views into a shared
        // 8 KB pool, and structured clone copies the whole underlying buffer.
        return new Uint8Array(buf)
      }),

    /** Overwrite a binary in place; returns the mtime the scanner will report,
     *  so the writer can tell its own change from a foreign one. */
    write: vaultMutation
      .input((raw: unknown) => {
        const base = fields({ remote: 'string', path: 'string' })(raw)
        const bytes = (raw as { bytes?: unknown }).bytes
        if (!(bytes instanceof Uint8Array)) throw new Error('bytes must be a Uint8Array')
        return { ...base, bytes }
      })
      .mutation(async ({ input }): Promise<{ updatedAt: string }> => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        await writeAtomic(root, rel, input.bytes)
        const info = await stat(absPathFor(root, rel))
        return { updatedAt: info.mtime.toISOString() }
      }),
  })

  const notes = t.router({
    read: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<string> => {
        const abs = absPathFor(await rootFor(input.remote), safe(input.path))
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: input.path })
        return text
      }),

    /**
     * The notes whose text holds `q`, most recently modified first: ⌘P's rows
     * after the name matches it ranks itself. Holi's own UI, so nothing is out
     * of reach, the agent surface included; the palette shows only what it
     * would list by name anyway.
     */
    search: t.procedure
      .input(fields({ remote: 'string', q: 'string' }))
      .query(async ({ input }): Promise<SearchHit[]> => {
        const q = input.q.trim()
        if (q === '') return []
        const docs = [...(await snapshotFor(input.remote)).docs].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        )
        return searchBodies(
          await rootFor(input.remote),
          docs.map((d) => d.path),
          q,
        )
      }),

    /** The file's last commit, first commit and commit count. Null when the
     *  file has no history yet. Resolved against the active vault's repo, since
     *  the editor only shows the active vault. The log is never limited: the
     *  first commit is the far end of it. */
    fileHistory: t.procedure
      .input(fields({ path: 'string' }))
      .query(async ({ input }): Promise<FileHistory | null> =>
        fileHistory(await activeOrThrow().repo.log({ path: safe(input.path) })),
      ),

    /**
     * Set or clear a path's icon in `.holi/settings/icons.yaml`.
     *
     * The map rather than the note's frontmatter, whatever the path is: one
     * gesture with one destination is what makes the menu item explicable, and
     * the map is the only home that can serve a folder or a PDF. A note whose
     * own frontmatter names an icon still outranks whatever lands here; the
     * dialog says so rather than letting the write look like it did nothing.
     */
    setIcon: vaultMutation
      .input(fields({ remote: 'string', path: 'string', emoji: 'string?' }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        const rel = safe(ICONS_FILE)
        const existing = await readFile(join(root, ICONS_FILE), 'utf8').catch(() => null)
        // `?? null` and not `|| null`: an empty string is a cleared icon, and
        // the two must not collapse into the same argument.
        await writeAtomic(root, rel, withIcon(existing, input.path, input.emoji ?? null))
        return { ok: true as const }
      }),

    write: vaultMutation
      .input(fields({ remote: 'string', path: 'string', text: 'string' }))
      .mutation(async ({ input }) => {
        await writeAtomic(await rootFor(input.remote), safe(input.path), input.text)
        return { ok: true as const }
      }),

    create: vaultMutation
      .input(fields({ remote: 'string', path: 'string', text: 'string?' }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        // Refuse rather than overwrite: "create" that clobbers an existing note
        // is indistinguishable from losing it. A task takes a numeric suffix
        // instead (`tasks.create`), because its path is derived from its title
        // rather than chosen by the user.
        if (await exists(root, rel)) {
          throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${rel}` })
        }
        await writeAtomic(root, rel, input.text ?? '')
        return { path: rel }
      }),

    delete: vaultMutation
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await removeDocFile(await rootFor(input.remote), safe(input.path))
        return { ok: true as const }
      }),

    // What links here, so a delete can name what it will turn into
    // tombstones rather than silently dangling. The same scan rename rewrites.
    backrefs: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<{ path: string; count: number }[]> => {
        return scanBackrefs(await rootFor(input.remote), safe(input.path))
      }),

    // Move the file AND rewrite every inbound [[link]] in one pass. The
    // move-half alone silently breaks links, so the two are one procedure. The
    // rewrite runs before the move, so a mid-run failure leaves the source in
    // place and visible in `git status` (there is no transaction).
    // Commits are the renderer's job (it flushes and commits around this call).
    rename: vaultMutation
      .input(fields({ remote: 'string', from: 'string', to: 'string' }))
      .mutation(async ({ input }): Promise<{ rewritten: { path: string; count: number }[] }> => {
        const root = await rootFor(input.remote)
        const from = safe(input.from)
        const to = safe(input.to)
        if (await exists(root, to)) {
          throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${to}` })
        }
        return renameNote(root, from, to)
      }),

    // Batch move: one commit-pair from the renderer, one single-pass link
    // rewrite here. The renderer expands a folder to its file list before
    // calling; each `to` outside the moved set must be free (a swap-shaped chain,
    // where a `to` IS another move's `from`, is allowed, which is why it is one
    // procedure).
    move: vaultMutation
      .input(movesInput)
      .mutation(async ({ input }): Promise<{ rewritten: { path: string; count: number }[] }> => {
        const root = await rootFor(input.remote)
        const fromSet = new Set(input.moves.map((m) => m.from))
        for (const m of input.moves) {
          safe(m.from)
          const to = safe(m.to)
          if (!fromSet.has(m.to) && (await exists(root, to))) {
            throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${m.to}` })
          }
        }
        return moveNotes(root, input.moves)
      }),

    // Batch copy: verbatim, no link rewrite. Refuses to clobber
    // and reports a missing source rather than writing an empty file.
    copy: vaultMutation
      .input(copiesInput)
      .mutation(async ({ input }): Promise<{ copied: string[] }> => {
        const root = await rootFor(input.remote)
        for (const c of input.copies) {
          const from = safe(c.from)
          const to = safe(c.to)
          if (!(await exists(root, from))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: c.from })
          }
          if (await exists(root, to)) {
            throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${c.to}` })
          }
        }
        await copyNotes(root, input.copies)
        return { copied: input.copies.map((c) => c.to) }
      }),

    // Batch delete: file, folder (expanded by the renderer) or multi-selection.
    // Lands as one commit-pair (the renderer wraps it); a missing path is not an
    // error, matching single delete. `folders` are what the delete was aimed
    // at: once their documents are gone, what that emptied goes too, or the
    // folder would stay on its `.gitkeep` with nothing left to delete.
    deleteMany: vaultMutation.input(deleteManyInput).mutation(async ({ input }) => {
      const root = await rootFor(input.remote)
      for (const p of input.paths) await removeDocFile(root, safe(p))
      for (const f of input.folders) await pruneEmptiedFolder(root, safe(f))
      return { ok: true as const }
    }),

    /**
     * A drop from Finder. `sources` are absolute paths OUTSIDE the vault,
     * which is the point of the operation, so only the destination is
     * checked; the copy itself refuses a clobber per file and reports it.
     */
    importFiles: vaultMutation
      .input((raw: unknown) => ({
        ...fields({ remote: 'string', folder: 'string' })(raw),
        sources: stringsOrThrow((raw as { sources?: unknown }).sources),
      }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        const folder = input.folder === '' ? '' : safe(input.folder)
        return importFiles(root, input.sources, folder)
      }),

    /**
     * Vault content out to a folder on disk: the inverse of the import above,
     * and the checks invert with it. `dest` is absolute, outside
     * the vault, and deliberately unvalidated: it comes from the native folder
     * chooser, so it is the user's own choice, and second-guessing it here
     * would only refuse places they can already write to from Finder. The
     * SOURCES are what need `safe()`, because those name vault content.
     */
    exportFiles: vaultMutation
      .input((raw: unknown) => ({
        ...fields({ remote: 'string', dest: 'string' })(raw),
        paths: stringsOrThrow((raw as { paths?: unknown }).paths),
      }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        return exportFiles(root, input.paths.map(safe), input.dest)
      }),

    // The delete preview for a folder or multi-selection.
    backrefsMany: t.procedure
      .input(pathsInput)
      .query(async ({ input }): Promise<{ path: string; count: number }[]> => {
        return scanBackrefsMany(
          await rootFor(input.remote),
          input.paths.map((p) => safe(p)),
        )
      }),

    // Create today's daily note if absent and hand back its path. The
    // personal-vault gate lives in the renderer (it owns the collaborators
    // call); this proc just does the deterministic if-not-exists-write.
    getOrCreateDaily: vaultMutation
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<{ path: string; created: boolean }> => {
        return getOrCreateDaily(await rootFor(input.remote), today())
      }),

    // Archive prior-day dailies into journal/ and GC untouched stubs. Does not
    // commit: the renderer batches the sweep into one commit.
    sweepDaily: vaultMutation
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<{ archived: number; deleted: number }> => {
        return sweepDaily(await rootFor(input.remote), today())
      }),
  })

  const sync = t.router({
    /** The push channel carries changes; this is the initial read. */
    state: t.procedure.query((): SyncState => activeOrThrow().syncState()),

    /** ⌘S: a real commit point rather than a placebo. */
    commitNow: t.procedure.mutation(() => activeOrThrow().commitNow()),

    /** ⌘S's second half: push the just-committed work now (docs/features/vaults-sync.md).
     *  Best-effort: a non-fast-forward recovers into the conflict
     *  path, a network failure surfaces as `offline`; the renderer only kicks it. */
    pushNow: t.procedure.mutation(async () => {
      await activeOrThrow().pushNow()
      return { ok: true as const }
    }),

    /** Re-materialise the conflict for the agent and return the conflicted
     *  paths for its seed prompt. `{paths:[]}` when the merge now applies cleanly. */
    reconcile: t.procedure.mutation(() => activeOrThrow().reconcile()),

    /** "Try again" on a sticky conflict: clear it, commit and pull. A
     *  conflict that is still real comes straight back. */
    retry: t.procedure.mutation(async () => {
      await activeOrThrow().retry()
      return { ok: true as const }
    }),

    /** Take the merge back out of the tree. The conflict is still a
     *  conflict afterwards, so the banner comes back with it. */
    abandon: t.procedure.mutation(async () => {
      await activeOrThrow().abandon()
      return { ok: true as const }
    }),
  })

  // The vault's history IS git history (docs/features/history.md): no snapshot
  // store, git's object store is the timeline. `--follow` (in `repo.log`) tracks a
  // file through renames; `HISTORY_LIMIT` caps a long-lived file's timeline.
  const HISTORY_LIMIT = 200
  const history = t.router({
    /** The open file's commits, newest-first, following renames. Empty for a
     *  file with no commits yet (new/untracked). */
    list: t.procedure
      .input(fields({ path: 'string' }))
      .query(({ input }): Promise<Commit[]> =>
        activeOrThrow().repo.log({ path: safe(input.path), limit: HISTORY_LIMIT }),
      ),

    /** The whole vault's commit log, newest-first — the broad history dialog. */
    log: t.procedure.query((): Promise<Commit[]> =>
      activeOrThrow().repo.log({ limit: HISTORY_LIMIT }),
    ),

    /** The paths one commit changed — the file list beside a commit's diff. */
    changed: t.procedure
      .input(fields({ sha: 'string' }))
      .query(({ input }): Promise<string[]> => activeOrThrow().repo.changedFiles(input.sha)),

    /** One file's before/after at a commit (vs its parent) — fed to the merge
     *  view as a diff. Either side is `''` when the file was added or removed
     *  (or the commit is the root): the diff then reads as a pure add/delete. */
    fileDiff: t.procedure
      .input(fields({ path: 'string', sha: 'string' }))
      .query(async ({ input }): Promise<{ before: string; after: string }> => {
        const repo = activeOrThrow().repo
        const rel = safe(input.path)
        const after = await repo.show(input.sha, rel).catch(() => '')
        const before = await repo.show(`${input.sha}^`, rel).catch(() => '')
        return { before, after }
      }),

    /** Restore writes the old content as a **new commit**, never a rewrite of
     *  history (docs/features/history.md). Lands as an autosave `Update`
     *  commit. */
    restore: vaultMutation
      .input(fields({ remote: 'string', path: 'string', sha: 'string' }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        const text = await activeOrThrow().repo.show(input.sha, rel)
        await writeAtomic(root, rel, text)
        await activeOrThrow().commitNow()
        return { ok: true as const }
      }),
  })

  // Per-vault theming: the resolved (merged + validated) colour/chrome tokens
  // the renderer writes onto the document root. Most themes are written by hand
  // or by the agent; the settings pane's `write` merges per key per mode so
  // those authors keep their tokens.
  const theme = t.router({
    read: t.procedure
      .input(fields({ remote: 'string' }))
      .query(({ input }): Promise<ResolvedTheme> => rootFor(input.remote).then(readVaultTheme)),

    /** Holi's own theme, what a token's reset writes back. The same for every
     *  vault, so it takes none. */
    holi: t.procedure.query(() => holiTheme()),

    /**
     * One pane edit, into one of the two files.
     *
     * **Takes a JSON string and parses it HERE**, exactly as `settings.write`
     * does and for its reason: `fields` validates `string` and `boolean` only,
     * so the patch arrives as text and goes through `parseThemePatch`: the
     * same whitelist and the same per-token value check that guard a committed
     * file a teammate wrote. A write cannot reach these files by a route that
     * skips the check, and the promise that a theme is structurally incapable
     * of changing layout holds however the theme was authored.
     *
     * Returns the warnings rather than throwing: a refused token must not
     * strand the pane, and the caller can say which colour did not stick.
     */
    write: t.procedure
      .input(fields({ remote: 'string', layer: 'string', patchJson: 'string' }))
      .mutation(async ({ input }) => {
        const layer = input.layer === 'local' ? 'local' : 'committed'
        const { patch, warnings } = parseThemePatch(input.patchJson)
        await writeVaultTheme(await rootFor(input.remote), layer, patch)
        return { ok: true as const, warnings }
      }),

    // One mode back to Holi's theme, in both files. The running app follows
    // through the watcher, as for any write.
    reset: t.procedure
      .input(fields({ remote: 'string', mode: 'string' }))
      .mutation(async ({ input }) => {
        if (input.mode !== 'light' && input.mode !== 'dark') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `no such mode: ${input.mode}` })
        }
        await resetVaultTheme(await rootFor(input.remote), input.mode)
        return { ok: true as const }
      }),
  })

  // The vault's own settings: what it opens on, whether it keeps a daily note,
  // which pre-commit transforms run, and how it should look — resolved from
  // `.holi/settings/app.yaml` under its per-key `.holi/settings/app.local.yaml`
  // override. The files are also authored by the user or the agent with
  // ordinary file tools.
  const settings = t.router({
    read: t.procedure
      .input(fields({ remote: 'string' }))
      .query(({ input }): Promise<ResolvedVaultSettings> =>
        rootFor(input.remote).then(readVaultSettings),
      ),

    /**
     * The router's write to these files, used by onboarding and the settings
     * pane.
     *
     * **Takes JSON strings, and that is a feature.** `fields` above validates
     * `string` and `boolean` only, with no object kind, so the patches
     * arrive as text and are parsed HERE, through `parseSettingsPatch`: the same
     * validator that guards a committed file a teammate wrote. A write cannot
     * reach these files by a route that skips the check, and cannot introduce a
     * key Holi does not own.
     *
     * Returns the warnings rather than throwing on a refused value. The vault
     * exists and its seeded defaults are valid; a preference that did not stick
     * must not strand anyone mid-ritual.
     */
    write: t.procedure
      .input(fields({ remote: 'string', committedJson: 'string?', localJson: 'string?' }))
      .mutation(async ({ input }) => {
        // The same patch answers both files: app keys through `parseSettingsPatch`,
        // `plugins` and each plugin's own settings through
        // `parsePluginSettingsPatch`, each ignoring what the other owns.
        const known = installedInfos()
        const transforms = knownTransforms(known)
        const parse = (json: string | null) => {
          const app = parseSettingsPatch(json, transforms)
          const plugins = parsePluginSettingsPatch(json, known)
          return {
            patch: { ...app.patch, ...plugins.patch },
            warnings: [...app.warnings, ...plugins.warnings],
          }
        }
        const committed = parse(input.committedJson ?? null)
        const local = parse(input.localJson ?? null)
        const root = await rootFor(input.remote)
        await writeVaultSettings(root, { committed: committed.patch, local: local.patch })
        // A plugin just turned on gets its files and starts now, not at the
        // vault's next open.
        if ('plugins' in committed.patch || 'plugins' in local.patch) {
          await deps.seed(root)
          await deps.plugins.enter(root)
          await deps.plugins.opened()
          // Which files are claimed follows the plugins, so the open vault's
          // snapshot is scanned again now rather than at its next change.
          const active = deps.host.active()
          if (active?.remote === input.remote) {
            await active.refresh().catch((err) => console.error('[router] rescan:', err))
          }
        }
        return { ok: true as const, warnings: [...committed.warnings, ...local.warnings] }
      }),

    /** The vault's `.pre-commit-config.yaml` on this machine: its hooks, the
     *  tool, whether this person allows it, and its last run. */
    preCommit: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<PreCommitStatus | null> => {
        if (deps.preCommit === undefined) return null
        return deps.preCommit.status(input.remote, await rootFor(input.remote))
      }),

    /** Allow the config `hash` names on this machine. False when it changed
     *  since the person was shown it; they are then shown it again. */
    allowPreCommit: t.procedure
      .input(fields({ remote: 'string', hash: 'string' }))
      .mutation(async ({ input }) => {
        if (deps.preCommit === undefined) return { ok: false as const }
        const ok = await deps.preCommit.allow(input.remote, await rootFor(input.remote), input.hash)
        return { ok }
      }),

    disallowPreCommit: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }) => {
        await deps.preCommit?.disallow(input.remote)
        return { ok: true as const }
      }),
  })

  /** What the renderer, and only it, knows about the person's attention. */
  const ui = t.router({
    /**
     * The focused note, the open notes and the recents, for one vault: main
     * writes the agent's per-turn focus file from it and answers
     * `holi vault recents` / `holi.recents()` with it. One report, sent whenever any
     * of it changes; main keeps only the last, in memory.
     */
    report: t.procedure
      .input((raw: unknown): UiReport & { remote: string } => {
        const { remote } = fields({ remote: 'string' })(raw)
        const r = raw as { focusedPath?: unknown; openPaths?: unknown; recents?: unknown }
        const strings = (v: unknown) =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        const recents = (Array.isArray(r.recents) ? r.recents : [])
          .filter(
            (e): e is RecentEntry =>
              e !== null &&
              typeof e === 'object' &&
              typeof (e as RecentEntry).kind === 'string' &&
              typeof (e as RecentEntry).key === 'string',
          )
          .slice(0, RECENTS_CAP)
          .map(({ kind, key, id }) => (typeof id === 'string' ? { kind, key, id } : { kind, key }))
        return {
          remote,
          focusedPath: typeof r.focusedPath === 'string' ? r.focusedPath : null,
          openPaths: strings(r.openPaths),
          recents,
        }
      })
      .mutation(({ input }) => {
        const { remote, ...report } = input
        deps.reportUi?.(remote, report)
      }),
  })

  /**
   * The UI door: Holi's own renderer calling a capability, which is how a
   * plugin's renderer reaches its main side (plugins add no routers). Params
   * arrive as JSON text because `fields` has no object kind; dispatch parses
   * them against the capability's own `params`, as at every door.
   *
   * `names` is what a plugin asks before offering a call into another plugin
   * (`has('tasks.create')`): the UI door's names in that vault, core's and
   * those of the plugins it runs.
   */
  const cap = t.router({
    names: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<string[]> => {
        try {
          return await capabilities.names(input.remote, 'ui')
        } catch (err) {
          if (err instanceof CapabilityError) {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
          }
          throw err
        }
      }),

    run: t.procedure
      .input(fields({ remote: 'string', name: 'string', paramsJson: 'string?' }))
      .mutation(async ({ input }): Promise<unknown> => {
        let params: unknown
        try {
          params = input.paramsJson === undefined ? undefined : JSON.parse(input.paramsJson)
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'params are not JSON' })
        }
        try {
          const result = await capabilities.dispatch({
            door: 'ui',
            remote: input.remote,
            name: input.name,
            params,
          })
          return result.value
        } catch (err) {
          if (err instanceof CapabilityError) {
            throw new TRPCError({
              code: trpcCodeOf(err.code),
              message: err.message,
            })
          }
          throw err
        }
      }),
  })

  /** Updating Holi itself; the status also arrives pushed, on change. */
  const unsupported = (): UpdateStatus => ({
    supported: false,
    enabled: false,
    version: '',
    state: 'idle',
    availableVersion: null,
    percent: null,
    lastCheckAt: null,
    checkStartedAt: null,
    lastError: null,
  })
  const updates = t.router({
    status: t.procedure.query((): UpdateStatus => deps.updates?.status() ?? unsupported()),
    check: t.procedure.mutation(
      async (): Promise<UpdateStatus> => (await deps.updates?.check()) ?? unsupported(),
    ),
    download: t.procedure.mutation(
      async (): Promise<UpdateStatus> => (await deps.updates?.download()) ?? unsupported(),
    ),
    install: t.procedure.mutation(() => {
      deps.updates?.install()
      return { ok: true as const }
    }),
    setEnabled: t.procedure
      .input(fields({ enabled: 'boolean' }))
      .mutation(
        async ({ input }): Promise<UpdateStatus> =>
          (await deps.updates?.setEnabled(input.enabled)) ?? unsupported(),
      ),
  })

  /** This machine's app: whether it opens at login, so the reminders and
   *  sync are there from the start. */
  const app = t.router({
    loginItem: t.procedure.query((): { openAtLogin: boolean } => ({
      openAtLogin: deps.loginItem?.get() ?? false,
    })),
    setLoginItem: t.procedure
      .input(fields({ openAtLogin: 'boolean' }))
      .mutation(({ input }): { openAtLogin: boolean } => {
        deps.loginItem?.set(input.openAtLogin)
        return { openAtLogin: deps.loginItem?.get() ?? false }
      }),
  })

  return t.router({
    auth,
    github,
    vaults,
    notes,
    files,
    tasks,
    sync,
    history,
    theme,
    settings,
    ui,
    cap,
    updates,
    app,
  })
}

/**
 * Which refusal becomes which tRPC code.
 *
 * `saml-required` maps to FORBIDDEN like a plain 403, and the difference lives
 * entirely in the message — because the two really are the same *kind* of no,
 * and only one of them has a link that fixes it.
 */
const TRPC_CODE = {
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  'saml-required': 'FORBIDDEN',
  'rate-limited': 'TOO_MANY_REQUESTS',
  'not-found': 'NOT_FOUND',
  other: 'INTERNAL_SERVER_ERROR',
} as const satisfies Record<GitHubApiError['kind'], TRPCError['code']>

export type AppRouter = ReturnType<typeof createRouter>
