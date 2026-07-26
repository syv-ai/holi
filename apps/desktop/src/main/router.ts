/**
 * The router — main's typed API, and the seam the renderer calls.
 *
 * It used to proxy to the Syv server; it now reads and writes the clone. The
 * *shape* survives that change on purpose (architecture §9): the renderer keeps
 * calling a typed router over IPC, so the pivot is an implementation swap rather
 * than a rewrite of every call site. The signatures do change — identity is a
 * path now, not a `docId` — and that is the part call sites feel.
 *
 * There is deliberately **no authorization here**, and there must never be one:
 * with no server, a check running on the machine of the person it restricts is
 * theatre. GitHub decides what leaves, at push time (auth PRD §Access model).
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { initTRPC, TRPCError } from '@trpc/server'
import {
  nextDueCatchup,
  parseTaskFile,
  parseTaskPatch,
  serializeTaskFile,
  shiftForRollover,
  taskFilePath,
  taskSlug,
  vaultRelPath,
  type Task,
  type TaskPatch,
  type VaultEntry,
  type VaultRelPath,
} from '@holi/shared'
import { ensureSeeded } from './agent/seed-content'
import { scanBackrefs, scanBackrefsMany } from './vault/backrefs'
import { copyNotes } from './vault/copy'
import { moveNotes } from './vault/move'
import { getOrCreateDaily, sweepDaily } from './vault/daily'
import { remoteUrl } from './git'
import { GitHubApiError, type Repo } from './github/api'
import type { DeviceFlow } from './github/device-flow'
import type { GitHubSession } from './github/session'
import type { ActiveVault, SyncState, VaultHost } from './vault/active-vault'
import { ensureClone } from './vault/clone'
import { removeDocFile, writeAtomic, absPathFor } from './vault/vault-files'
import { renameNote } from './vault/rename'
import { scanVault, type VaultSnapshot } from './vault/vault-store'
import { isRemote, repoName, type VaultRegistry } from './vault/registry'
import { listTemplates } from './pdf/templates'
import { renderPdf } from './pdf/render'
import { ensureTypst } from './pdf/typst-bin'

const t = initTRPC.create()

/**
 * What the renderer is allowed to know about who is signed in — FR-5, and
 * nothing beyond it.
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

export interface RouterDeps {
  registry: VaultRegistry
  session: GitHubSession
  /** Which vault is open, and everything running behind it. */
  host: VaultHost
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
   * Two requirements need it: FR-2 opens `github.com/login/device` in the
   * **system** browser, so the grant reuses the user's existing GitHub session
   * and no credential enters the app's web context; and FR-11 deep-links to the
   * repo's collaborator settings, because Holi does not implement invitation.
   */
  openExternal: (url: string) => Promise<void>
  /** Absolute dir the Convert-to-PDF output is written to (the user's Downloads).
   *  Injected rather than read from electron here so the router stays
   *  typecheckable and testable under plain Node. */
  downloadsDir: string
  /** Where a downloaded typst binary is cached (userData/typst). Injected for
   *  the same reason; the resolver only reads it, never electron. */
  typstCacheDir: string
  /** Wall-clock, injected so `lastOpenedAt` is testable. */
  now?: () => string
  /**
   * Today, **local**, as `YYYY-MM-DD` — the frame a recurrence rolls against.
   *
   * Separate from `now()` rather than sliced off it: `now()` is a UTC instant,
   * and for anyone west of Greenwich its date reads as yesterday for part of the
   * evening. With no server left, the machine's local time is the only frame
   * there is — and it is the one the reminder anchor already uses.
   */
  today?: () => string
}

/** `YYYY-MM-DD` in the machine's own timezone. `toISOString().slice(0, 10)`
 * would be the UTC date, which is a different day for much of the world for
 * much of the day. */
function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whether a clone carries the `.holi/vault.json` marker — i.e. it is a Holi
 * vault rather than an arbitrary repo. The durable on-disk twin of the
 * `holi-vault` GitHub topic (github/api.ts). */
async function isVaultClone(root: string): Promise<boolean> {
  return readFile(join(root, '.holi', 'vault.json'), 'utf8').then(
    () => true,
    () => false,
  )
}

/** A tiny validator, so the router keeps its input contract without pulling in a
 * schema library for four shapes. Each one throws on anything it did not ask
 * for; tRPC turns that into a BAD_REQUEST. */
type Parsed<T extends Record<string, 'string' | 'string?'>> = {
  [K in keyof T as T[K] extends 'string?' ? never : K]: string
} & {
  // Genuinely optional, not "required and possibly undefined". tRPC infers a
  // procedure's input from this type, so the difference is whether a caller may
  // omit the key at all — and every optional field here is one a caller omits.
  [K in keyof T as T[K] extends 'string?' ? K : never]?: string
}

function fields<T extends Record<string, 'string' | 'string?'>>(spec: T) {
  return (raw: unknown): Parsed<T> => {
    if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
    const input = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, kind] of Object.entries(spec)) {
      const value = input[key]
      if (value === undefined || value === null) {
        if (kind === 'string?') continue
        throw new Error(`${key} is required`)
      }
      if (typeof value !== 'string') throw new Error(`${key} must be a string`)
      out[key] = value
    }
    return out as never
  }
}

/** Batch inputs the string-only `fields` helper cannot express. Each throws on a
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

function pathsInput(raw: unknown): { remote: string; paths: string[] } {
  const { remote } = fields({ remote: 'string' })(raw)
  const paths = (raw as Record<string, unknown>).paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('paths must be an array of strings')
  }
  return { remote, paths: paths as string[] }
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date().toISOString())
  const today = deps.today ?? localToday
  const cloneUrlFor = deps.cloneUrlFor ?? remoteUrl

  /**
   * A write must be visible to the very next read.
   *
   * `vaults.snapshot` answers from `ActiveVault`'s cache, and that cache was
   * refreshed only by the filesystem watcher — which is documented as a *hint*
   * and genuinely drops `add` events on macOS. So the renderer's create-then-
   * re-read (`createNoteAtom`) raced a debounce it could not see: the new note
   * did not appear, creating it again failed with "already exists" for a file
   * the user had no way to know was there, and it finally surfaced on a later
   * heal tick.
   *
   * Rescanning here rather than in `vaults.snapshot` keeps the read cheap and
   * the cache meaningful — a read is answered from memory, and a *write* is what
   * invalidates it. That is also why this is a middleware and not a line at the
   * end of each mutation: the next write procedure gets it without remembering
   * to.
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
    // already a vault. `ensureSeeded` below would otherwise write `AGENTS.md`,
    // `.claude/` and friends into a plain code repo and the auto-push would carry
    // them upstream, quietly turning someone's codebase into a half-vault. The
    // marker is the `.holi/vault.json` the seed commits at creation. A repo we
    // just cloned for this is removed on refusal so nothing is left behind; a
    // pre-existing adopted path is left exactly as we found it.
    if (opts.requireVault && !(await isVaultClone(repo.root))) {
      if (outcome.kind === 'cloned') await rm(repo.root, { recursive: true, force: true })
      throw new Error(
        `${remote} is not a Holi vault. Create a new vault instead of adopting this repo.`,
      )
    }
    await ensureSeeded(repo.root)
    await deps.registry.add({
      remote,
      path: repo.root,
      name: repoName(remote),
      lastOpenedAt: now(),
    })
    const active = await deps.host.open(remote)
    return active.snapshot()
  }

  /** remote -> the clone's root on this machine. Every path-taking procedure
   * goes through here, so an unknown vault fails once, in one place. */
  async function rootFor(remote: string): Promise<string> {
    const entry = (await deps.registry.list()).find((e) => e.remote === remote)
    if (!entry) throw new TRPCError({ code: 'NOT_FOUND', message: `no such vault: ${remote}` })
    return entry.path
  }

  /** Every path from the renderer or the agent re-validates here. This is the
   * only thing between an input and the user's filesystem now that server-side
   * authorization is gone (architecture §10). */
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

  /** The renderer-facing projection of the session (FR-5). */
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
   * The SSO URL rides in the message because it is advice for a human — a
   * `FORBIDDEN` with no URL is the dead end the PRD calls out by name.
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
      // FR-15: the keychain entry goes, the clones stay. `vaults.remove` is a
      // separate, deliberate act.
      await deps.session.signOut()
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
        const [repo, collaborators] = await Promise.all([
          deps.session.api.repo(remote),
          deps.session.api.collaborators(remote),
        ])
        return { visibility: repo.visibility, collaborators }
      }),
    ),

    openCollaboratorSettings: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }) => {
        // FR-11. Holi does not implement invitation; it points at the flow
        // that does.
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
        await rootFor(input.remote)
        await deps.registry.touch(input.remote, now())
        const active = await deps.host.open(input.remote)
        return active.snapshot()
      }),

    add: t.procedure
      .input(fields({ remote: 'string', url: 'string?' }))
      // FR-7: clone the chosen repo into the managed root and open it — but only
      // if it is already a vault (see `addVault`'s `requireVault`).
      .mutation(({ input }) => addVault(safeRemote(input.remote), input.url, { requireVault: true })),

    create: t.procedure
      .input(fields({ name: 'string', owner: 'string?', url: 'string?' }))
      // FR-8: a private repo, seeded, committed, pushed, opened.
      .mutation(async ({ input }): Promise<VaultSnapshot> => {
        const repo = await gh(() =>
          deps.session.api.createRepo({ name: input.name, owner: repoOwner(input.owner) }),
        )
        const snapshot = await addVault(repo.remote, input.url)
        // The seed is the repo's first commit, and it has to leave the machine:
        // a "vault" that exists only locally is not one anybody can be invited
        // to. Push is automatic now, but a brand-new repo should not wait out the
        // coalesce timer to become shareable, so kick it explicitly.
        const active = deps.host.active()
        if (active !== null) {
          await active.commitNow()
          await active.pushNow()
        }
        // Mark it a vault ONLY here — after its content has been pushed. The
        // topic is what the picker filters on, so setting it before the push
        // (as this once did) is exactly what leaves a topic'd-but-empty repo in
        // everyone's "join" list that the adopt guard then rightly refuses. A
        // repo carrying the topic now means a repo with a vault on the remote.
        await gh(() => deps.session.api.markVault(repo.remote))
        return snapshot
      }),

    snapshot: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<VaultSnapshot> => {
        // The live vault's cache when it is the one being asked about — a
        // second walk could only disagree with what the renderer already has.
        const active = deps.host.active()
        if (active?.remote === input.remote) return active.snapshot()
        return scanVault(await rootFor(input.remote))
      }),

    remove: t.procedure
      .input(fields({ remote: 'string' }))
      // Deregisters the vault; the clone stays on disk. Deleting someone's files
      // — which may hold unpublished commits — is never a side effect here.
      .mutation(({ input }) => deps.registry.remove(input.remote)),
  })

  /** Does this file exist? The existence half of "create must not clobber". */
  async function exists(root: string, rel: VaultRelPath): Promise<boolean> {
    return (await readFile(absPathFor(root, rel), 'utf8').catch(() => null)) !== null
  }

  /**
   * The first free `task.<slug>.md` in `folder`.
   *
   * Two tasks may honestly share a title — "Call the vendor" twice is a normal
   * week — so a colliding slug takes a numeric suffix. Refusing would make a
   * board quick-add fail on a repeated title, which reads as a bug; overwriting
   * would silently destroy the earlier task.
   */
  async function freeTaskPath(root: string, folder: string, title: string): Promise<VaultRelPath> {
    const slug = taskSlug(title)
    for (let n = 1; n <= 1000; n++) {
      const rel = safe(taskFilePath(folder, n === 1 ? slug : `${slug}-${n}`))
      if (!(await exists(root, rel))) return rel
    }
    throw new TRPCError({ code: 'CONFLICT', message: `too many tasks named like: ${title}` })
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
    create: vaultMutation
      .input(fields({ remote: 'string', folder: 'string?', title: 'string', status: 'string?' }))
      .mutation(async ({ input }): Promise<{ path: string }> => {
        const root = await rootFor(input.remote)
        // The status rides through the same validator a field edit does, so the
        // board cannot create a file it would then refuse to parse.
        const patch = patchOrThrow({ status: input.status ?? 'todo' })
        const rel = await freeTaskPath(root, input.folder ?? '', input.title)
        await writeAtomic(
          root,
          rel,
          serializeTaskFile({
            title: input.title,
            status: patch.status ?? 'todo',
            tags: [],
            description: '',
          }),
        )
        return { path: rel }
      }),

    update: vaultMutation
      .input((raw: unknown) => ({
        ...fields({ remote: 'string', path: 'string' })(raw),
        patch: patchOrThrow((raw as { patch?: unknown }).patch ?? {}),
      }))
      .mutation(async ({ input }): Promise<Task> => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        // Read-modify-write. There is no record to patch — the file is the task,
        // so an edit is a parse, a merge and a full rewrite. The merge SPREADS
        // rather than testing for undefined: a key present-and-undefined is how
        // `parseTaskPatch` spells "clear this field".
        const next = { ...(await readTask(root, rel)), ...input.patch }
        await writeAtomic(root, rel, serializeTaskFile(next))
        return next
      }),

    /**
     * The single roll-forward path.
     *
     * The card's checkbox and a drop into Done both land here rather than writing
     * `status: done`, because for a recurring task `done` is not the answer — the
     * next occurrence is. A patch would silently skip the roll and the series
     * would end wherever someone happened to tick the box.
     */
    complete: vaultMutation
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }): Promise<Task> => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        const task = await readTask(root, rel)

        const next = rollForward(task)
        await writeAtomic(root, rel, serializeTaskFile(next))
        return next
      }),

    delete: vaultMutation
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await removeDocFile(await rootFor(input.remote), safe(input.path))
        return { ok: true as const }
      }),
  })

  /**
   * Completing a task: the next occurrence if there is one, `done` if there is
   * not.
   *
   * A recurrence with no `due` has nothing to advance from, and one that has run
   * past its `endDate` has nowhere left to go — both end the series rather than
   * looking set and never firing again (prd/tasks.md §Recurrence & reminders).
   */
  function rollForward(task: Task): Task {
    const rolled =
      task.recurrence !== undefined && task.due !== undefined
        ? nextDueCatchup(task.due, task.recurrence, today())
        : null
    if (rolled === null) return { ...task, status: 'done' }

    // An ABSOLUTE reminder is a wall-clock instant tied to the old occurrence, so
    // it moves by the same delta the due date did. A relative one (`1d`) already
    // re-resolves against the new `due`, so shifting it would double-count.
    const reminder =
      task.reminder === undefined
        ? undefined
        : (shiftForRollover(task.reminder, task.due!, rolled) ?? task.reminder)

    return { ...task, status: 'todo', due: rolled, reminder }
  }

  const notes = t.router({
    read: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<string> => {
        const abs = absPathFor(await rootFor(input.remote), safe(input.path))
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: input.path })
        return text
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
        // is indistinguishable from losing it. (A task, by contrast, takes a
        // numeric suffix — see freeTaskPath. The difference is that a note's path
        // is chosen by the user and a task's is derived from its title.)
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

    // FR-12: what links here, so a delete can name what it will turn into
    // tombstones rather than silently dangling. The same scan rename rewrites.
    backrefs: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<{ path: string; count: number }[]> => {
        return scanBackrefs(await rootFor(input.remote), safe(input.path))
      }),

    // FR-11: move the file AND rewrite every inbound [[link]] in one pass. The
    // move-half alone silently breaks links, so the two are one procedure. The
    // rewrite runs before the move, so a mid-run failure leaves the source in
    // place and visible in `git status` (there is no transaction — prd §Rename).
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
    // where a `to` IS another move's `from`, is allowed — that is the whole
    // reason it is one procedure).
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

    // Batch copy: verbatim, no link rewrite (spec §Cut/Copy). Refuses to clobber
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
    // error, matching single delete.
    deleteMany: vaultMutation
      .input(pathsInput)
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        for (const p of input.paths) await removeDocFile(root, safe(p))
        return { ok: true as const }
      }),

    // FR-12 generalized: the delete preview for a folder or multi-selection.
    backrefsMany: t.procedure
      .input(pathsInput)
      .query(async ({ input }): Promise<{ path: string; count: number }[]> => {
        return scanBackrefsMany(
          await rootFor(input.remote),
          input.paths.map((p) => safe(p)),
        )
      }),

    // FR-4: create today's daily note if absent and hand back its path. The
    // personal-vault gate lives in the renderer (it owns the collaborators
    // call); this proc just does the deterministic if-not-exists-write.
    getOrCreateDaily: vaultMutation
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<{ path: string; created: boolean }> => {
        return getOrCreateDaily(await rootFor(input.remote), today())
      }),

    // FR-5: archive prior-day dailies into journal/ and GC untouched stubs. Does
    // not commit — the renderer batches the sweep into one commit (§Archiving).
    sweepDaily: vaultMutation
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<{ archived: number; deleted: number }> => {
        return sweepDaily(await rootFor(input.remote), today())
      }),
  })

  const sync = t.router({
    /** The push channel carries changes; this is the initial read. */
    state: t.procedure.query((): SyncState => activeOrThrow().syncState()),

    /** ⌘S. FR-4 calls it a real commit point rather than a placebo. */
    commitNow: t.procedure.mutation(() => activeOrThrow().commitNow()),

    /** ⌘S's second half: push the just-committed work now (`prd/vaults-sync.md`
     *  §Pushing). Best-effort — a non-fast-forward recovers into the conflict
     *  path, a network failure surfaces as `offline`; the renderer only kicks it. */
    pushNow: t.procedure.mutation(async () => {
      await activeOrThrow().pushNow()
      return { ok: true as const }
    }),

    /** FR-18's first step. The reconcile itself needs the agent drawer. */
    pause: t.procedure
      .input(fields({ reason: 'string' }))
      .mutation(({ input }) => {
        activeOrThrow().pause(input.reason)
        return { ok: true as const }
      }),

    resume: t.procedure.mutation(() => {
      activeOrThrow().resume()
      return { ok: true as const }
    }),
  })

  const pdf = t.router({
    // The vault's templates, for the Convert picker. Slice 1 only needs
    // name/slug/description; the full `fields` shape drives slice 2's inputs.
    templates: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<{ name: string; slug: string; description: string }[]> => {
        const root = await rootFor(input.remote)
        return (await listTemplates(root)).map(({ name, slug, description }) => ({
          name,
          slug,
          description,
        }))
      }),

    // Render `path` through `template` to a PDF in Downloads; return its path.
    // Not a vaultMutation — the output goes to Downloads, not the vault, so
    // there is no snapshot to refresh.
    render: t.procedure
      .input(fields({ remote: 'string', path: 'string', template: 'string' }))
      .mutation(async ({ input }): Promise<{ pdfPath: string }> => {
        const root = await rootFor(input.remote)
        const noteAbs = absPathFor(root, safe(input.path))
        const tpl = (await listTemplates(root)).find((t) => t.slug === input.template)
        if (tpl === undefined) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `template ${input.template}` })
        }
        const typstBin = await ensureTypst({ cacheDir: deps.typstCacheDir })
        if (typstBin === null) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'typst is not available' })
        }
        const base = input.path.split('/').at(-1)!.replace(/\.(md|markdown)$/i, '')
        const outPath = join(deps.downloadsDir, `${base}.pdf`)
        await renderPdf({ typstBin, templateDir: tpl.dir, notePath: noteAbs, outPath, meta: {} })
        return { pdfPath: outPath }
      }),
  })

  return t.router({ auth, github, vaults, notes, tasks, sync, pdf })
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
