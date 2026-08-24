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
  isAgentSurfacePath,
  nextDueCatchup,
  parseTaskFile,
  parseTaskPatch,
  serializeTaskFile,
  shiftForRollover,
  taskFilePath,
  taskSlug,
  vaultRelPath,
  withIcon,
  ICONS_FILE,
  type Task,
  type TaskPatch,
  type VaultEntry,
  type VaultRelPath,
} from '@holi/shared'
import { ensureSeeded } from './agent/seed-content'
import {
  initAppOp,
  renameAppOp,
  type AppInitResult,
  type AppRenameResult,
} from './apps/app-ops'
import { migrateAppManifests } from './apps/migrate-manifests'
import { scanBackrefs, scanBackrefsMany } from './vault/backrefs'
import { copyNotes } from './vault/copy'
import { importFiles } from './vault/import-files'
import { exportFiles } from './vault/export-files'
import { moveNotes } from './vault/move'
import { getOrCreateDaily, sweepDaily } from './vault/daily'
import { openRepo, remoteUrl, type Commit } from './git'
import { GitHubApiError, type Repo } from './github/api'
import type { DeviceFlow } from './github/device-flow'
import type { GitHubSession } from './github/session'
import type { LoopbackFlow as GoogleFlow } from './google/loopback-flow'
import type { GoogleSession } from './google/session'
import type { GoogleAccountsManager } from './google/accounts'
import { GoogleApi, GoogleApiError, type GoogleErrorCode } from './google/api'
import {
  listAgenda,
  resolveCalendars,
  type CalendarChoice,
  type CalendarEvent,
  type CalendarOverrides,
} from './google/calendar'
import { resolveThreadMeeting, type ThreadMeeting } from './google/invite'
import type { CalendarPrefsStore } from './google/calendar-prefs'
import type { GoogleData } from './google/data'
import {
  fetchCategoryCounts,
  fetchMailCounts,
  listDrafts,
  listSendAs,
  listThreads,
  readDraft,
  readThread,
  type CategoryCounts,
  type DraftBody,
  type DraftSummary,
  type MailAddress,
  type MailboxName,
  type MailCategory,
  type MailCounts,
  type MailPage,
  type MailThread,
} from './google/gmail'
import type { OutgoingMail } from './google/mime'
import type { ImagePrefsStore } from './google/image-prefs'
import { listContacts } from './google/people'
import type { ActiveVault, SyncState, VaultHost } from './vault/active-vault'
import { ensureClone } from './vault/clone'
import { removeDocFile, writeAtomic, absPathFor } from './vault/vault-files'
import { renameNote } from './vault/rename'
import { scanVault, type VaultSnapshot } from './vault/vault-store'
import { readVaultTheme, resetVaultTheme } from './vault/theme'
import { readVaultSettings, writeVaultSettings } from './vault/settings'
import { parseSettingsPatch } from '@holi/shared'
import type { ResolvedTheme, ResolvedVaultSettings } from '@holi/shared'
import { isRemote, repoName, type VaultRegistry } from './vault/registry'
import { listTemplates } from './pdf/templates'
import type { TemplateField } from '@holi/shared'
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
  /**
   * The Google connector (D67), when configured.
   *
   * Optional so every existing router test keeps constructing deps without it —
   * and so the app still runs when the Google client id has not been filled in.
   * The `google.*` procedures refuse with a clear precondition failure rather
   * than pretending to be connected.
   */
  googleAccounts?: GoogleAccountsManager
  /**
   * Which calendars the user has switched on. Optional for the same reason as
   * `googleSession`; absent means every calendar follows the default rule, and
   * `google.setCalendar` refuses rather than pretending to remember.
   */
  calendarPrefs?: CalendarPrefsStore
  /**
   * The UI's cached Google data. Optional like the two above; absent means
   * every read goes to Google, which is exactly how the pillar shipped.
   *
   * **The agent's ops server is deliberately not given this** — it asks for
   * current data and must not be handed a stale answer (D67).
   */
  googleDataFor?: (remote: string) => Promise<GoogleData | null>
  /**
   * Senders whose remote images always load. Optional like the rest; absent
   * means the standing exceptions are simply empty, so every message blocks
   * until the user says otherwise — the safe direction to degrade in.
   */
  imagePrefs?: ImagePrefsStore
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
  /**
   * Move a directory to the OS trash (Electron's `shell.trashItem`), injected
   * for the same reason as `openExternal` — the router stays electron-free and
   * testable under plain Node.
   *
   * Sign-out's "also delete local clones" (FR-15) uses this rather than a hard
   * `rm`, on purpose: a clone removed by mistake — or the user's private vault —
   * is recoverable from the trash and can be re-ingested. A destructive account
   * action should be undoable.
   */
  trashItem: (path: string) => Promise<void>
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
 * Booleans are **checked, never coerced.**
 *
 * This validator was string-only for a reason worth keeping now that it is not:
 * a coerced `"false"` reads as true, which is how a calendar silently switches
 * back on. So a `boolean` field demands an actual boolean and throws on
 * anything else, rather than accepting the string form and guessing.
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

const MAIL_CATEGORIES: readonly MailCategory[] = [
  'primary',
  'social',
  'promotions',
  'updates',
  'forums',
]

/**
 * The composer's payload, which `fields` cannot express (D71).
 *
 * `fields` handles strings and booleans; a mail carries arrays and a nested
 * object. Validated for **shape** only — the semantic rules stay in
 * `buildRfc822`, which is the last thing to see the message and already refuses
 * a newline in any header and an empty `html` that had body text to render.
 * Duplicating those here would mean two places to disagree, and the plan's
 * stricter "reject any empty html" would have re-broken sending an empty
 * message.
 */
function composeInput(raw: unknown): {
  draftId?: string
  threadId?: string
  forwardOf?: { messageId: string }
  mail: OutgoingMail
} {
  if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
  const input = raw as Record<string, unknown>

  const optionalId = (key: 'draftId' | 'threadId'): string | undefined => {
    const value = input[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a string`)
    return value
  }

  const mail = input.mail
  if (mail === null || typeof mail !== 'object') throw new Error('mail must be an object')
  const m = mail as Record<string, unknown>

  const addresses = (key: 'to' | 'cc'): string[] => {
    const value = m[key]
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) throw new Error(`mail.${key} must be an array`)
    return value.map((address) => {
      if (typeof address !== 'string') throw new Error(`mail.${key} must be strings`)
      return address
    })
  }

  const text = (key: 'subject' | 'body'): string => {
    const value = m[key]
    if (typeof value !== 'string') throw new Error(`mail.${key} must be a string`)
    return value
  }

  const html = m.html
  if (html !== undefined && html !== null && typeof html !== 'string') {
    throw new Error('mail.html must be a string')
  }

  /**
   * A forward names the message whose attachments travel with it — never the
   * files. Main fetches the bytes, so nothing base64 crosses the IPC seam.
   */
  const forward = input.forwardOf
  let forwardOf: { messageId: string } | undefined
  if (forward !== undefined && forward !== null) {
    const messageId = (forward as { messageId?: unknown }).messageId
    if (typeof messageId !== 'string' || messageId === '') {
      throw new Error('forwardOf.messageId must be a string')
    }
    forwardOf = { messageId }
  }

  const cc = addresses('cc')
  const draftId = optionalId('draftId')
  const threadId = optionalId('threadId')
  return {
    ...(draftId === undefined ? {} : { draftId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(forwardOf === undefined ? {} : { forwardOf }),
    mail: {
      to: addresses('to'),
      ...(cc.length === 0 ? {} : { cc }),
      subject: text('subject'),
      body: text('body'),
      ...(html === undefined || html === null ? {} : { html }),
    },
  }
}

/** A category arrives as a string (`fields` is string-only) and is narrowed
 *  here. An unknown value means "no category", not an error: the worst it can
 *  do is compose a query Gmail answers nothing to. */
function asMailCategory(value: string | undefined): MailCategory | undefined {
  return MAIL_CATEGORIES.find((c) => c === value)
}

/** The same narrowing for the mailbox, with the same forgiveness: an
 *  unrecognised value falls back to the inbox rather than refusing the request.
 *  The cost of being wrong is a list of the wrong mailbox, which the user can
 *  see and correct; the cost of throwing is a mail pane that shows an error. */
function asMailbox(value: string | undefined): MailboxName | undefined {
  return value === 'sent' ? 'sent' : undefined
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
  const paths = (raw as Record<string, unknown>).paths
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
    throw new Error('paths must be an array of strings')
  }
  return { remote, paths: paths as string[] }
}

/** The Convert-to-PDF render input. The three string fields ride the string-only
 * `fields` helper; `meta` (the template's declared fields → user values) and the
 * optional `outPath` (an absolute destination the native save dialog chose) do
 * not, so they are validated here — the same split `movesInput`/`pathsInput` use.
 * `outPath` absent → the procedure defaults to Downloads (the agent path). */
function renderPdfInput(raw: unknown): {
  remote: string
  path: string
  template: string
  outPath?: string
  meta?: Record<string, string>
} {
  const base = fields({ remote: 'string', path: 'string', template: 'string', outPath: 'string?' })(
    raw,
  )
  return { ...base, meta: metaOf(raw) }
}

/** A flat string→string metadata map from the render input. Missing → `{}`. Any
 *  non-string value throws (tRPC → BAD_REQUEST) rather than reaching `typst`. */
function metaOf(raw: unknown): Record<string, string> {
  const m = (raw as Record<string, unknown>).meta
  if (m === undefined || m === null) return {}
  if (typeof m !== 'object') throw new Error('meta must be an object')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`meta value for ${k} must be a string`)
    out[k] = v
  }
  return out
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
    await migrateApps(repo.root)
    await deps.registry.add({
      remote,
      path: repo.root,
      name: repoName(remote),
      lastOpenedAt: now(),
    })
    const active = await deps.host.open(remote)
    return active.snapshot()
  }

  /**
   * Give a pre-manifest app the manifest that now registers it.
   *
   * Runs wherever `ensureSeeded` does and always **ahead of `host.open`**, for
   * the seed's reason and a sharper one: the renderer keys registration on
   * `app.yaml`, so an app written before the manifest existed is missing from
   * the first snapshot and arrives only on the next rescan — a slice-1 app
   * blinking out of the sidebar and back on every single open.
   */
  async function migrateApps(root: string): Promise<void> {
    const migrated = await migrateAppManifests(root)
    if (migrated.length > 0) {
      console.log(`[apps] wrote a manifest for: ${migrated.join(", ")}`)
    }
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
    return scanVault(await rootFor(remote))
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
        const root = await rootFor(input.remote)
        /**
         * Seed on **open**, not only on clone (D70).
         *
         * `ensureSeeded` has always said it is "safe to run on every vault
         * activation", and was wired only to `addVault` — so a vault created
         * before a managed file existed never received it. That is not a
         * cosmetic gap: it is how the send gate would have been absent from
         * every established vault, with `send` reaching a real mailbox and
         * nothing asking first.
         *
         * Before `host.open`, for `addVault`'s reason — the seed lands before
         * the vault goes live, so nothing can be committed ahead of the
         * `.gitignore`.
         */
        await ensureSeeded(root)
        await migrateApps(root)
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
      .query(({ input }): Promise<VaultSnapshot> => snapshotFor(input.remote)),

    remove: t.procedure
      .input(fields({ remote: 'string' }))
      // Deregisters the vault; the clone stays on disk. Deleting someone's files
      // — which may hold unpublished commits — is never a side effect here.
      .mutation(({ input }) => deps.registry.remove(input.remote)),

    // What "also delete local clones" would throw away (FR-15 / Open-Q3). One
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

    // Sign-out's optional "also delete local clones" (FR-15). **Recoverable on
    // purpose:** each clone goes to the OS trash, not `rm -rf`, so a vault
    // deleted by mistake — or a private one — can be restored and re-ingested.
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
      .input(
        fields({
          remote: 'string',
          folder: 'string?',
          title: 'string',
          status: 'string?',
          description: 'string?',
        }),
      )
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
            // Optional, and empty for every existing caller. The agenda's
            // create-from-event uses it to seed the body with the event's
            // markdown link — which under D67 *is* the whole representation of
            // the link, so dropping it would defeat the feature silently.
            description: input.description ?? '',
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

    /**
     * The horizontal drag axis: moving a card to another lane moves the
     * `task.<name>.md` file into that folder and rewrites inbound `[[wiki-links]]`
     * — a task's path is its identity, so a lane change IS a rename, reusing the
     * one link-rewriting pass notes already own (`renameNote`), never a second
     * (D63).
     *
     * A `status` rides along for a DIAGONAL drop (lane + column in one gesture):
     * it is written in place first, so the single `renameNote` carries the final
     * content to the destination — one route call, one write burst, one autosave
     * commit, and a card is never half-dropped (prd/tasks.md §Board UX). `done`
     * routes through `rollForward`, never a bare `status: done`, so a recurring
     * task advances instead of persisting done.
     *
     * The basename rides along unchanged (identity slug preserved, not re-slugged
     * from `title`), and a destination that already exists is refused rather than
     * silently suffixed — that would change an existing task's identity.
     */
    move: vaultMutation
      .input(fields({ remote: 'string', path: 'string', folder: 'string', status: 'string?' }))
      .mutation(async ({ input }): Promise<Task> => {
        const root = await rootFor(input.remote)
        const from = safe(input.path)
        const basename = from.slice(from.lastIndexOf('/') + 1)
        const to = safe(input.folder ? `${input.folder}/${basename}` : basename)

        if (to === from && input.status === undefined) return readTask(root, to)
        if (to !== from && (await exists(root, to))) {
          throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${to}` })
        }

        if (input.status !== undefined) {
          const task = await readTask(root, from)
          const next =
            input.status === 'done'
              ? rollForward(task)
              : { ...task, ...patchOrThrow({ status: input.status }) }
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

  /**
   * What a vault app may ask the vault for (D74).
   *
   * **The refusal lives here and not in the renderer.** The renderer could do
   * every check in this namespace with no new IPC at all — and must not: it is
   * the process that hosts the app's own code, and the process rendering
   * untrusted code must not also be the process deciding what it may read. The
   * renderer only forwards, and it supplies the `remote` and the path from the
   * frame it mounted, so an app cannot address a vault or a file by claim.
   *
   * Read-only, and narrower than `notes`: the agent surface (`AGENTS.md`,
   * `CLAUDE.md`, `MEMORY.md`, `USER.local.md`, `.claude/`) is refused outright,
   * because `.claude/hooks/google-send-gate.mjs` IS the mail send gate and
   * MEMORY.md is what the user told the assistant.
   */
  /**
   * Two audiences, and the split matters.
   *
   * `read` / `docs` / `tasks` are what a **vault app** reaches, through the
   * postMessage bridge — which is why they are read-only and why `read` refuses
   * the agent surface. `rename` / `register` are what **Holi's own sidebar**
   * reaches, and they mutate.
   *
   * They share a namespace safely only because `AppFrame` answers the bridge
   * with an exhaustive `switch` over `APP_METHODS`, never by forwarding a
   * method name into tRPC. **Do not turn that switch into a passthrough** — it
   * is the only thing standing between an app and renaming its neighbours.
   */
  const apps = t.router({
    read: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<string> => {
        // FORBIDDEN, distinct from NOT_FOUND: the UI (and the app's own error
        // handling) must be able to tell "you may not" from "it is not there".
        if (isAgentSurfacePath(input.path)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: input.path })
        }
        const abs = absPathFor(await rootFor(input.remote), safe(input.path))
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: input.path })
        return text
      }),

    docs: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<VaultSnapshot['docs']> => {
        const snapshot = await snapshotFor(input.remote)
        return snapshot.docs.filter((d) => !isAgentSurfacePath(d.path))
      }),

    tasks: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<Task[]> => (await snapshotFor(input.remote)).tasks),

    // ---- Holi's own UI from here down. Not reachable from an app. ----

    /** Rename an app's directory, which is to say rename the app: the id is the
     *  directory name and the `holi-app://` host both. A refusal comes back as a
     *  value, not a throw, because the caller is an inline rename field that has
     *  somewhere to put the reason. */
    rename: vaultMutation
      .input(fields({ remote: 'string', from: 'string', to: 'string' }))
      .mutation(
        async ({ input }): Promise<AppRenameResult> =>
          renameAppOp(await rootFor(input.remote), input.from, input.to),
      ),

    /** Write the manifest that registers a directory as a finished app — the
     *  sidebar's "finish this app", and the same op as `holi app init`. Never
     *  overwrites, so it cannot clobber a manifest someone is mid-way through. */
    register: vaultMutation
      .input(fields({ remote: 'string', appId: 'string' }))
      .mutation(
        async ({ input }): Promise<AppInitResult> =>
          initAppOp(await rootFor(input.remote), input.appId),
      ),
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

    /** The file's last commit — author + date — for the collapsed frontmatter
     *  summary. Null when the file has no history yet (new/untracked). Resolved
     *  against the active vault's live repo; the editor only shows the active
     *  vault, so a remote is not needed. */
    lastCommit: t.procedure
      .input(fields({ path: 'string' }))
      .query(async ({ input }): Promise<{ date: string; author: string } | null> => {
        const [commit] = await activeOrThrow().repo.log({ path: safe(input.path), limit: 1 })
        return commit === undefined ? null : { date: commit.date, author: commit.author }
      }),

    /**
     * Set or clear a path's icon in `.holi/icons.json` (D82).
     *
     * The map rather than the note's frontmatter, whatever the path is: one
     * gesture with one destination is what makes the menu item explicable, and
     * the map is the only home that can serve a folder or a PDF. A note whose
     * own frontmatter names an icon still outranks whatever lands here — the
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

    /**
     * A drop from Finder (FR-13). `sources` are absolute paths OUTSIDE the
     * vault — that is the point of the operation — so only the destination is
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
     * Vault content out to a folder on disk (FR-13) — the exact inverse of the
     * import above, and the checks invert with it. `dest` is absolute, outside
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

    /** FR-18: re-materialise the conflict for the agent and return the conflicted
     *  paths for its seed prompt. `{paths:[]}` when the merge now applies cleanly. */
    reconcile: t.procedure.mutation(() => activeOrThrow().reconcile()),

    /** FR-20: take the merge back out of the tree. The conflict is still a
     *  conflict afterwards, so the banner comes back with it. */
    abandon: t.procedure.mutation(async () => {
      await activeOrThrow().abandon()
      return { ok: true as const }
    }),
  })

  // The vault's history IS git history (`prd/vaults-sync.md` §History): no snapshot
  // store, git's object store is the timeline. `--follow` (in `repo.log`) tracks a
  // file through renames; `HISTORY_LIMIT` caps a long-lived file's timeline.
  const HISTORY_LIMIT = 200
  const history = t.router({
    /** The open file's commits, newest-first, following renames. Empty for a
     *  file with no commits yet (new/untracked). */
    list: t.procedure
      .input(fields({ path: 'string' }))
      .query(
        ({ input }): Promise<Commit[]> =>
          activeOrThrow().repo.log({ path: safe(input.path), limit: HISTORY_LIMIT }),
      ),

    /** The whole vault's commit log, newest-first — the broad history dialog. */
    log: t.procedure.query((): Promise<Commit[]> => activeOrThrow().repo.log({ limit: HISTORY_LIMIT })),

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

    /** Restore writes the old content as a **new commit** — never a rewrite of
     *  history (`prd/vaults-sync.md` §History). Lands as an autosave `Update`
     *  commit; a labelled landmark is a later refinement. */
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
  // the renderer writes onto the document root. A read, not a write — the theme
  // files are authored by the user or the agent with ordinary file tools, never
  // through the router, which is why there is no `theme.write` here.
  const theme = t.router({
    read: t.procedure
      .input(fields({ remote: 'string' }))
      .query(({ input }): Promise<ResolvedTheme> => rootFor(input.remote).then(readVaultTheme)),

    // Back to standard: delete both theme files. A write (deletion), so it lives
    // as a mutation. The running app reverts on its own via the watcher — no
    // channel needed.
    reset: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }) => {
        await resetVaultTheme(await rootFor(input.remote))
        return { ok: true as const }
      }),
  })

  // The vault's own settings: what it opens on, whether it keeps a daily note,
  // which pre-commit transforms run, and how it should look — resolved from
  // `.holi/settings.json` under its per-key `.holi/settings.local.json`
  // override. A read, like `theme.read`: the files are authored by the user or
  // the agent with ordinary file tools. The one write is the onboarding step,
  // which arrives with it.
  const settings = t.router({
    read: t.procedure
      .input(fields({ remote: 'string' }))
      .query(
        ({ input }): Promise<ResolvedVaultSettings> => rootFor(input.remote).then(readVaultSettings),
      ),

    /**
     * The onboarding step's answers, and the only write to these files.
     *
     * **Takes JSON strings, and that is a feature.** `fields` above validates
     * `string` and `boolean` only — there is no object kind — so the patches
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
        const committed = parseSettingsPatch(input.committedJson ?? null)
        const local = parseSettingsPatch(input.localJson ?? null)
        await writeVaultSettings(await rootFor(input.remote), {
          committed: committed.patch,
          local: local.patch,
        })
        return { ok: true as const, warnings: [...committed.warnings, ...local.warnings] }
      }),
  })

  const pdf = t.router({
    // The vault's templates, for the Convert picker + its metadata inputs.
    // `fields` drives slice 2's per-template inputs, so it is no longer stripped.
    templates: t.procedure
      .input(fields({ remote: 'string' }))
      .query(
        async ({
          input,
        }): Promise<
          { name: string; slug: string; description: string; fields: TemplateField[]; warnings: string[] }[]
        > => {
          const root = await rootFor(input.remote)
          return (await listTemplates(root)).map(({ name, slug, description, fields, warnings }) => ({
            name,
            slug,
            description,
            fields,
            warnings,
          }))
        },
      ),

    // Render `path` through `template` to a PDF and return its path. Writes to
    // `outPath` when given (the native save dialog's choice); otherwise defaults
    // to Downloads (the agent path). Not a vaultMutation — the output goes
    // outside the vault, so there is no snapshot to refresh.
    render: t.procedure
      .input(renderPdfInput)
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
        const outPath = input.outPath ?? join(deps.downloadsDir, `${base}.pdf`)
        await renderPdf({
          typstBin,
          templateDir: tpl.dir,
          notePath: noteAbs,
          outPath,
          fields: tpl.fields,
          meta: input.meta ?? {},
        })
        return { pdfPath: outPath }
      }),
  })

  /**
   * The Google connection (D67) — a **data connector**, not identity.
   *
   * Deliberately its own sub-router rather than a branch of `auth`: signing out
   * of GitHub must not drop your mail/calendar connection, and disconnecting
   * Google must not touch your vaults. Two independent grants, two surfaces.
   *
   * Same two-phase shape as `auth.signIn` and for the same reason — a tRPC
   * procedure returns once, but the grant lands later, so `connect` stashes the
   * flow and `awaitConnect` waits on it.
   */
  let connectFlow: GoogleFlow | null = null

  const google = t.router({
    /**
     * Who is connected, and whether that grant is still wide enough.
     *
     * `missingScopes` is not diagnostics. Widening `GOOGLE_SCOPES` leaves an
     * existing grant working *and* insufficient — mail still lists, every write
     * 403s — so without this the only symptom is a feature that looks broken.
     * It is what lets settings offer the one action that fixes it.
     */
    status: t.procedure.query(async () => {
      const remote = activeRemoteOrNull()
      const session =
        remote === null ? null : await deps.googleAccounts?.sessionFor(remote).catch(() => null)
      return {
        account: session?.account ?? null,
        missingScopes: session?.missingScopes() ?? [],
      }
    }),

    connect: t.procedure.mutation(async () => {
      // A second connect supersedes the first, rather than leaving an orphaned
      // listener holding a port for the life of the app.
      connectFlow?.cancel()
      connectFlow = await googleAccounts().connect(activeRemote())
      // The browser is opened by the session itself (the system browser, so the
      // consent reuses the user's Google session). Hand the URL back anyway:
      // some desktop environments swallow the launch, and "open it again" is
      // the only recovery that does not mean restarting the flow.
      return { authUrl: connectFlow.authUrl }
    }),

    awaitConnect: t.procedure.mutation(async () => {
      if (connectFlow === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'no Google connect in progress' })
      }
      const result = await connectFlow.wait()
      connectFlow = null
      // The tokens stop here. The renderer gets an email address and nothing else.
      return result.kind === 'granted'
        ? { kind: 'granted' as const, account: (await activeGoogleSession()).account }
        : { kind: result.kind }
    }),

    cancelConnect: t.procedure.mutation(() => {
      connectFlow?.cancel()
      connectFlow = null
      return { ok: true as const }
    }),

    /**
     * Every account connected on this machine, and the one this vault uses.
     *
     * The picker's whole point: a second vault reusing an account already in the
     * store costs a mapping and no consent round trip, because the grant exists.
     */
    accounts: t.procedure.query(async () => {
      const manager = googleAccounts()
      const remote = activeRemoteOrNull()
      const session = remote === null ? null : await manager.sessionFor(remote)
      return { accounts: manager.list(), current: session?.accountSub ?? null }
    }),

    /** Point this vault at an account already connected. No consent. */
    useAccount: t.procedure
      .input(fields({ sub: 'string' }))
      .mutation(async ({ input }) => {
        await googleAccounts().link(activeRemote(), input.sub)
        return { ok: true as const }
      }),

    /**
     * Revoke an account at Google and drop it everywhere, including from every
     * vault pointing at it.
     *
     * The destructive half of what used to be one `disconnect`. It takes a `sub`
     * rather than acting on the active vault, so removing an account is always
     * an explicit choice of WHICH account.
     */
    removeAccount: t.procedure
      .input(fields({ sub: 'string' }))
      .mutation(async ({ input }) => {
        await googleAccounts().removeAccount(input.sub)
        return { ok: true as const }
      }),

    /**
     * Unlink **this vault**. The account and its tokens survive, and any other
     * vault using it keeps working.
     *
     * Renamed rather than repurposed (D87): the destructive half is
     * `removeAccount`, and a caller that still says `disconnect` should fail to
     * typecheck rather than silently revoke someone's grant.
     */
    disconnectVault: t.procedure.mutation(async () => {
      await googleAccounts().unlinkVault(activeRemote())
      return { ok: true as const }
    }),

    /**
     * The agenda for a window the **caller** supplies.
     *
     * Main never computes "today": the machine's local date is the renderer's
     * fact, and a main-side `new Date()` would silently disagree with it across
     * a timezone or a midnight boundary — the same rule daily notes follow.
     *
     * **Always fetched, never served from the cache.** A stale agenda is worse
     * than a slow one — `agendaCached` is the separate, explicit way to paint
     * the last one while this is in flight.
     */
    agenda: t.procedure
      .input(fields({ timeMin: 'string', timeMax: 'string' }))
      .query(async ({ input }): Promise<CalendarEvent[]> => {
        const window = { timeMin: input.timeMin, timeMax: input.timeMax }
        const overrides = await calendarOverrides()
        const data = await googleReads()
        return data === null
          ? listAgenda(googleApi(), window, { overrides })
          : data.agenda(window, overrides)
      }),

    /**
     * The last agenda for this exact window and calendar set, or `null`.
     *
     * **Never a request**, and never a substitute for `agenda`: the panel
     * paints this immediately and replaces it the moment the live one lands.
     * Two procedures rather than one stale-while-revalidate answer, because
     * there is no push channel to tell the renderer the second one arrived.
     */
    agendaCached: t.procedure
      .input(fields({ timeMin: 'string', timeMax: 'string' }))
      .query(async ({ input }): Promise<CalendarEvent[] | null> =>
        (await googleReads())?.cachedAgenda(
          { timeMin: input.timeMin, timeMax: input.timeMax },
          await calendarOverrides(),
        ) ?? null,
      ),

    /** Every calendar the account can draw from, with its colour and whether it
     *  is switched on — what the agenda's calendar picker renders. */
    calendars: t.procedure.query(
      async (): Promise<CalendarChoice[]> => resolveCalendars(googleApi(), await calendarOverrides()),
    ),

    /**
     * Switch one calendar on or off.
     *
     * Persisted in main rather than held in the renderer, because the **agent**
     * resolves its agenda through the same file — otherwise turning a
     * colleague's calendar off would hide it from the panel while the agent
     * carried on reading their day.
     */
    setCalendar: t.procedure
      .input(fields({ id: 'string', enabled: 'boolean' }))
      .mutation(async ({ input }) => {
        if (deps.calendarPrefs === undefined) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'the Google connector is not configured',
          })
        }
        await deps.calendarPrefs.set(input.id, input.enabled)
        return { ok: true as const }
      }),

    /**
     * Threads matching Gmail's own search grammar. Empty query = the inbox.
     *
     * A **page**, not a list: Gmail returns 25 at a time and the list foot has
     * a "load more" that passes the token back. `category` composes into the
     * same query grammar rather than filtering here — one way to narrow a list,
     * not two that can disagree.
     */
    threads: t.procedure
      .input(
        fields({
          query: 'string?',
          pageToken: 'string?',
          category: 'string?',
          unread: 'boolean?',
          mailbox: 'string?',
        }),
      )
      .query(async ({ input }): Promise<MailPage> => {
        const options = {
          query: input.query,
          pageToken: input.pageToken,
          category: asMailCategory(input.category),
          unread: input.unread,
          mailbox: asMailbox(input.mailbox),
        }
        // Cached AND current: the delta brings the cached list up to date, so
        // this is fast without ever being stale.
        const data = await googleReads()
        return data === null ? listThreads(googleApi(), options) : data.threads(options)
      }),

    /**
     * The meeting a thread is about, or `null`.
     *
     * Asked by the reader, and only for a thread whose summary says it carries
     * an invite — so the two or three requests behind this are paid for by
     * someone who opened a meeting, never by drawing a list. `null` is the
     * answer for "no invite", "not on your calendar" and "already over" alike;
     * see `resolveThreadMeeting` for why they are deliberately not
     * distinguished.
     *
     * **Not cached.** A join link is exactly the kind of fact that gets
     * rewritten when a meeting is moved, and a stale one sends the user to an
     * empty room. Same reasoning as `agenda` above.
     */
    meeting: t.procedure
      .input(fields({ id: 'string' }))
      .query(async ({ input }): Promise<ThreadMeeting | null> => {
        return await resolveThreadMeeting(googleApi(), input.id, {
          overrides: await calendarOverrides(),
        })
      }),

    /**
     * One thread. Each message carries `body` (plain text) and `html` (the raw
     * HTML part, or null).
     *
     * **`html` is unsanitized and crosses IPC that way.** That is the design,
     * not an oversight: the renderer sanitizes it with DOMPurify
     * (`renderer/src/lib/mail-html.ts`) because that is the process with a DOM.
     * Nothing may render it before that call. See `google/gmail.ts`.
     */
    thread: t.procedure
      .input(fields({ id: 'string' }))
      .query(({ input }): Promise<MailThread> => readThread(googleApi(), input.id)),

    /**
     * The four writes (D68) — the only procedures here that change anything at
     * Google.
     *
     * Each goes through `googleData` rather than calling `gmail.ts` directly,
     * because the cache has to move with the mailbox: a thread marked read at
     * Google and still bold on disk is a list that disagrees with itself until
     * the next full sync. `googleData` owns that ordering.
     *
     * **The agent reaches these same four methods** (D70) — the decision D68 §6
     * left untaken has been taken. `createGoogleOpsServer` is handed the
     * methods, never `googleData` itself, so it still cannot read a cached
     * anything; and it calls the identical function this procedure calls, which
     * is what keeps the UI's list and the agent's view of the mailbox from
     * disagreeing. What the agent does *not* get here is any route to `send`
     * without the hook that always asks.
     */
    /**
     * Read, in **both** directions — like `setStarred` below it.
     *
     * It was `markRead`, one-way, because the only caller was "opening a thread
     * marks it read". Marking something unread again is a real triage move (it
     * is how a thread gets put back on the pile), and main has always supported
     * it: `setThreadRead` takes the direction, and the agent already uses both.
     * The renderer simply had no way to ask.
     *
     * `fields()` checks booleans and never coerces — the same reason the note on
     * `setStarred` gives, and the same failure it prevents: a coerced "false"
     * reads as true, so the un-direction silently does nothing.
     */
    setRead: t.procedure
      .input(fields({ id: 'string', read: 'boolean' }))
      .mutation(async ({ input }) => {
        await (await googleWrites()).setRead(input.id, input.read).catch(rethrowGoogle)
        return { ok: true as const }
      }),

    setStarred: t.procedure
      // `fields()` checks booleans and never coerces. That matters here: a
      // coerced "false" reads as true, which is how a star refuses to turn off.
      .input(fields({ id: 'string', starred: 'boolean' }))
      .mutation(async ({ input }) => {
        await (await googleWrites()).setStarred(input.id, input.starred).catch(rethrowGoogle)
        return { ok: true as const }
      }),

    archive: t.procedure
      .input(fields({ id: 'string' }))
      .mutation(async ({ input }) => {
        await (await googleWrites()).archive(input.id).catch(rethrowGoogle)
        return { ok: true as const }
      }),

    /** Trash, which Gmail keeps for 30 days. Not delete: permanent removal
     *  needs `https://mail.google.com/`, which Holi does not request. */
    trash: t.procedure
      .input(fields({ id: 'string' }))
      .mutation(async ({ input }) => {
        await (await googleWrites()).trash(input.id).catch(rethrowGoogle)
        return { ok: true as const }
      }),

    /**
     * The composer (D71).
     *
     * The reads go straight to Google like `thread` does — a drafts list is not
     * cached, and `readDraft` is the one call that answers "is this ours?".
     * The writes go through `googleWrites()` so a draft appearing or leaving
     * moves the cached thread with it.
     */
    drafts: t.procedure.query((): Promise<DraftSummary[]> => listDrafts(googleApi())),

    draft: t.procedure
      .input(fields({ id: 'string' }))
      .query(({ input }): Promise<DraftBody> => readDraft(googleApi(), input.id)),

    /**
     * Every address this account may send from.
     *
     * Through `googleData` so it is fetched once per account, with a direct
     * fetch as the fallback — same shape as `contacts`. Unlike `contacts` this
     * one can refuse: `listSendAs` throws on a missing scope rather than
     * answering an empty list, because an empty list would silently turn every
     * reply-all into one that copies the user on their own message.
     */
    sendAs: t.procedure.query(
      async (): Promise<string[]> => (await googleReads())?.sendAs() ?? listSendAs(googleApi()),
    ),

    saveDraft: t.procedure.input(composeInput).mutation(async ({ input }) => {
      return await (await googleWrites()).saveDraft(input).catch(rethrowGoogle)
    }),

    discardDraft: t.procedure
      .input(fields({ draftId: 'string', threadId: 'string?' }))
      .mutation(async ({ input }) => {
        await (await googleWrites()).discardDraft(input).catch(rethrowGoogle)
        return { ok: true as const }
      }),

    /**
     * Send.
     *
     * One procedure for every case: a `draftId` sends that draft, a `threadId`
     * sends into that conversation, and neither sends a new message.
     *
     * **This is deliberately not hook-gated, and the omission is the design.**
     * D70's gate intercepts the *agent's* `Bash`, because an agent sending mail
     * is an act the user did not individually authorise. A user pressing Send
     * has already authorised it — prompting here would be a dialog asking
     * permission for the click that opened it. The next reader will otherwise
     * assume this was forgotten.
     */
    send: t.procedure.input(composeInput).mutation(async ({ input }) => {
      return await (await googleWrites()).sendMail(input).catch(rethrowGoogle)
    }),

    /**
     * How much mail there is, for the list footer.
     *
     * **Exact**, from Gmail's own per-label bookkeeping — not the
     * `resultSizeEstimate` the category picker refuses to show, which is
     * approximate and so would put a number people trust in front of them and
     * be wrong. `null` when the request fails: the footer then says nothing
     * rather than guessing.
     */
    mailCounts: t.procedure.query((): Promise<MailCounts | null> => fetchMailCounts(googleApi())),

    /**
     * The address book, for `@`-completion.
     *
     * A corpus to filter locally, not a search endpoint — so it is fetched
     * whole, and `googleData` holds it for the life of the connected account.
     * Without that hold every `MailView` mount cost up to four People requests
     * for a dropdown. Falls back to a direct fetch when the cache is absent,
     * like every other read here. `listContacts` never throws, so a cold or
     * unpermitted contacts API leaves completion running off the senders in
     * loaded threads instead of breaking the dropdown.
     */
    contacts: t.procedure.query(
      async (): Promise<MailAddress[]> =>
        (await googleReads())?.contacts() ?? listContacts(googleApi()),
    ),

    /**
     * Unread per Gmail tab, for the category picker.
     *
     * Its own procedure rather than part of `mailCounts` because it is paid
     * for differently: five requests, and only when the picker is opened. See
     * `fetchCategoryUnread` for why these are counted rather than estimated,
     * and why `labels.get` is the wrong source despite being one request.
     */
    categoryCounts: t.procedure.query((): Promise<CategoryCounts> => fetchCategoryCounts(googleApi())),

    /**
     * The senders whose remote images always load.
     *
     * Read by the mail reader to decide whether to block, and by settings to
     * say how many standing exceptions exist — a permission the user cannot
     * see is not one they can revoke.
     */
    imageSenders: t.procedure.query(async (): Promise<string[]> => (await deps.imagePrefs?.read()) ?? []),

    allowImagesFrom: t.procedure
      .input(fields({ sender: 'string' }))
      .mutation(async ({ input }) => {
        await imagePrefs().allow(input.sender)
        return { ok: true as const }
      }),

    forgetImageSenders: t.procedure.mutation(async () => {
      await imagePrefs().clear()
      return { ok: true as const }
    }),
  })

  /**
   * Google's own verdict, in a code that survives the trip to the renderer.
   *
   * `GoogleApiError.code` distinguishes "that scope was never granted" from
   * "you are rate limited" — the difference between an action the user can take
   * and one they must not be sent on. It does not survive serialization: an
   * error crossing the IPC seam keeps only its message and its tRPC code
   * (`main/trpc-call.ts`), so without this mapping the renderer is left
   * matching on prose. This codebase has made that mistake once already, in
   * `ipc-link.ts`'s own note — vault settings blamed a missing sign-in for what
   * was really a 404.
   *
   * The messages still say what they said, so a caller that has not been taught
   * the codes reads the same sentence it read before.
   */
  function rethrowGoogle(error: unknown): never {
    if (!(error instanceof GoogleApiError)) throw error
    const codes: Record<GoogleErrorCode, TRPCError['code']> = {
      reconnect: 'UNAUTHORIZED',
      scope: 'FORBIDDEN',
      'rate-limit': 'TOO_MANY_REQUESTS',
      'not-found': 'NOT_FOUND',
      unknown: 'INTERNAL_SERVER_ERROR',
    }
    throw new TRPCError({ code: codes[error.code], message: error.message, cause: error })
  }

  function imagePrefs(): ImagePrefsStore {
    if (deps.imagePrefs === undefined) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'the Google connector is not configured',
      })
    }
    return deps.imagePrefs
  }

  /** No store configured means no explicit choices — every calendar follows the
   *  default rule rather than the agenda coming back empty. */
  async function calendarOverrides(): Promise<CalendarOverrides> {
    return (await deps.calendarPrefs?.read()) ?? {}
  }

  /**
   * The write surface, or a refusal.
   *
   * Reads degrade gracefully when `googleData` is absent — they go straight to
   * Google, which is how the pillar shipped. A write cannot: without the cache
   * there is nothing to keep in step, and succeeding at Google while the list on
   * screen still says otherwise is worse than saying no.
   */
  /** The active vault's data layer, or null — reads degrade to Google directly. */
  async function googleReads(): Promise<GoogleData | null> {
    return (await deps.googleDataFor?.(activeRemote())) ?? null
  }

  async function googleWrites(): Promise<GoogleData> {
    const data = await googleReads()
    if (data === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'the Google connector is not configured',
      })
    }
    return data
  }

  function googleAccounts(): GoogleAccountsManager {
    if (deps.googleAccounts === undefined) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'the Google connector is not configured',
      })
    }
    return deps.googleAccounts
  }

  /** The vault whose Google account these procedures speak for (D87). The
   *  renderer resolves by ACTIVE vault, which is correct here: the UI shows one
   *  vault at a time. The agent resolves by its ops bearer instead. */
  function activeRemote(): string {
    const remote = deps.host.active()?.remote
    if (remote === undefined) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no vault is open' })
    }
    return remote
  }

  /**
   * The active vault, or null.
   *
   * `status` and `accounts` use this rather than `activeRemote()` because **no
   * vault open is not an error for them**: the renderer asks once on mount, and
   * at startup that can land before the vault has finished opening. A throw
   * there is a transient failure the renderer records as an answer, and the
   * picker then stays empty until a reload — which is exactly how it behaved
   * when this was written the other way.
   */
  function activeRemoteOrNull(): string | null {
    return deps.host.active()?.remote ?? null
  }

  /** The active vault's session, or a precondition failure — the same refusal
   *  an unconfigured connector gives, because "this vault has no account" is
   *  the same thing to a caller that needs one. */
  async function activeGoogleSession(): Promise<GoogleSession> {
    const session = await googleAccounts().sessionFor(activeRemote())
    if (session === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'this vault has no Google account connected',
      })
    }
    return session
  }

  /**
   * A Google client bound to the session's token **getter**, never a token.
   *
   * Built per call rather than held: the object is nothing but a closure, and a
   * cached one would outlive a disconnect. The getter is what refreshes and
   * single-flights (D67 — main is the sole token authority).
   */
  function googleApi(): GoogleApi {
    // Resolved inside the getter, not here: that keeps every call site
    // synchronous AND means the object cannot outlive a vault switch any more
    // than it could outlive a disconnect.
    return new GoogleApi({ accessToken: () => activeGoogleSession().then((s) => s.getAccessToken()) })
  }

  return t.router({
    auth,
    github,
    vaults,
    notes,
    tasks,
    sync,
    history,
    pdf,
    theme,
    settings,
    google,
    apps,
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
