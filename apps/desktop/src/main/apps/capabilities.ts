/**
 * What a vault app, and the agent, can ask Holi for: one registry, two doors.
 *
 * **The app door** is the `window.holi` bridge: `postMessage` from the
 * sandboxed frame to `AppFrame`, which forwards into `apps.bridge`. **The CLI
 * door** is `holi <group> <verb>` over the hook server's loopback port. Each
 * capability is written once, with its refusals, and says which doors may
 * reach it, so what an app sees and what the agent can inspect cannot drift.
 *
 * **The allowlist is this file.** A door dispatches only into an entry that
 * names it; nothing else in main is reachable by method name. `apps.register`,
 * the launchers' own mutation, is deliberately not an entry.
 *
 * **Refusals live here, in main**, because the process rendering untrusted app
 * code must not be the one deciding what it may read. An app never names
 * itself: at the app door `ctx.bundle` is the bundle `AppFrame` mounted, and a
 * `bundle` param is ignored. At the CLI door the agent names the bundle.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import {
  appBundleOf,
  isAgentSurfacePath,
  isAppBundlePath,
  isAppDataPath,
  syncLabel,
  vaultRelPath,
  type AppAffordance,
  type MainAppMethod,
  type RecentEntry,
  type SyncState,
  type Task,
  type VaultRelPath,
  type VaultSnapshot,
} from '@holi/shared'
import type { SessionSummary } from '../agent/claude-sessions'
import { readVaultSettings } from '../vault/settings'
import { taskDoneOp } from '../vault/task-done'
import { absPathFor } from '../vault/vault-files'
import { isSearchable, searchVault, type SearchHit } from './app-search'
import { storeCheck, storeDelete, storeGet, storeList, storePut } from './app-store'
import { CapabilityError } from './capability-error'
import type { CapabilityServices } from './capability-services'
import { renderNote } from './render-note'

export { CapabilityError }

export type Door = 'app' | 'cli'

export interface CapabilityContext {
  remote: string
  /** The vault clone's root on this machine. */
  root: string
  /** The calling app's bundle at the app door; null at the CLI door. */
  bundle: string | null
  snapshot(): Promise<VaultSnapshot>
  /** What the running app knows beyond the files: one factory builds these
   *  for both doors (`capability-services.ts`). */
  services: CapabilityServices
}

export interface Capability<P = unknown, R = unknown> {
  doors: readonly Door[]
  /** Changes the vault, so the open vault's cache is refreshed after it. */
  writes?: true
  /** Reads untrusted params, or throws a `CapabilityError('BAD_REQUEST')`. */
  params(raw: unknown): P
  run(ctx: CapabilityContext, params: P): Promise<R>
  /** The CLI's readable form of a result. Absent: pretty JSON. */
  text?(result: R): string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCapability = Capability<any, any>

/** Params as a plain object; an absent one is `{}`. */
export function paramsObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CapabilityError('BAD_REQUEST', 'params must be an object')
  }
  return raw as Record<string, unknown>
}

/** A required string param. */
export function stringParam(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value === '') {
    throw new CapabilityError('BAD_REQUEST', `${key} is required`)
  }
  return value
}

function cap<P, R>(c: Capability<P, R>): Capability<P, R> {
  return c
}

const noParams = (): Record<string, never> => ({})

/**
 * The bundle a store call is about: the calling frame's at the app door, where
 * a `bundle` param is ignored so one app cannot address another's data, and
 * the one the agent named at the CLI door.
 */
function bundleOf(ctx: CapabilityContext, named: unknown): string {
  const bundle = ctx.bundle ?? (typeof named === 'string' ? named : '')
  if (!isAppBundlePath(bundle)) throw new CapabilityError('BAD_REQUEST', `not an app: ${bundle}`)
  return bundle
}

/** `collection`, plus `bundle` for the CLI door (resolved in `run`). */
function storeParams(raw: unknown) {
  const p = paramsObject(raw)
  return { bundle: p.bundle, collection: stringParam(p, 'collection'), p }
}

/** `path` if a read may reach it, else null. */
function readableOrNull(path: string): VaultRelPath | null {
  try {
    return readablePath(path)
  } catch {
    return null
  }
}

/** A value from the app is an object already; from the CLI it is JSON text. */
function valueParam(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new CapabilityError('BAD_REQUEST', 'value is not valid JSON')
  }
}

const compact = (value: unknown) => JSON.stringify(value)

/** An optional non-negative integer param, clamped to `max`. A CLI field
 *  arrives as text, so a numeric string counts. */
function limitParam(raw: Record<string, unknown>, key: string, fallback: number, max: number) {
  const value = raw[key]
  if (value === undefined || value === '') return fallback
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new CapabilityError('BAD_REQUEST', `${key} must be a positive integer`)
  }
  return Math.min(n, max)
}

/**
 * The note a read may reach, or a refusal: not the agent surface, a real
 * vault path, and not any app's records, its own included (the store is the
 * only way in, so one app cannot read another's data, a personal app's least
 * of all). `docs.read`, `docs.render` and `tasks.complete` share it.
 */
function readablePath(path: string): VaultRelPath {
  if (isAgentSurfacePath(path)) throw new CapabilityError('FORBIDDEN', path)
  let rel
  try {
    rel = vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
  // Checked again on the normalised path: `./memory/x.md` is `memory/x.md`.
  if (isAgentSurfacePath(rel)) throw new CapabilityError('FORBIDDEN', path)
  const bundle = appBundleOf(rel)
  if (bundle !== null && isAppDataPath(rel.slice(bundle.length + 1))) {
    throw new CapabilityError('FORBIDDEN', path)
  }
  return rel
}

/**
 * `readablePath`, and a path the vault's snapshot holds, exactly. The snapshot
 * is built from `readdir`, so its paths have the case they have on disk: on a
 * case-insensitive filesystem (macOS) `Memory/x.md` opens `memory/x.md`, and a
 * check of the name as typed would wave it through. Matching the snapshot makes
 * the refusals see the real name.
 */
async function knownPath(ctx: CapabilityContext, path: string): Promise<VaultRelPath> {
  const rel = readablePath(path)
  const snapshot = await ctx.snapshot()
  const known =
    snapshot.docs.some((d) => d.path === rel) ||
    snapshot.files.some((f) => f.path === rel) ||
    snapshot.tasks.some((t) => t.path === rel)
  if (!known) throw new CapabilityError('NOT_FOUND', path)
  return rel
}

async function readNote(ctx: CapabilityContext, path: string): Promise<string> {
  const rel = await knownPath(ctx, path)
  const text = await readFile(absPathFor(ctx.root, rel), 'utf8').catch(() => null)
  if (text === null) throw new CapabilityError('NOT_FOUND', path)
  return text
}

/** A GitHub or Google failure, as a refusal the app can render. */
async function unavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof CapabilityError) throw err
    throw new CapabilityError('UNAVAILABLE', (err as Error).message)
  }
}

/**
 * The gate on a read of one person's Google data: the app must declare the
 * affordance in `dangerously-allow`, and the person must have approved it on
 * this machine (`app-grants.ts`). Only the app door reaches these entries.
 */
async function requireGrant(ctx: CapabilityContext, affordance: AppAffordance): Promise<void> {
  const bundle = bundleOf(ctx, null)
  const status = (await ctx.services.grants.status(ctx.remote, ctx.root, bundle)).affordances.find(
    (s) => s.affordance === affordance,
  )
  if (status === undefined) {
    throw new CapabilityError(
      'FORBIDDEN',
      `add "dangerously-allow: [${affordance}]" to ${bundle}/app.yaml to read ${affordance}`,
    )
  }
  if (!status.granted) {
    throw new CapabilityError('FORBIDDEN', `reading ${affordance} is not approved on this machine`)
  }
}

/** Recents an app may see: things it can name or open, never the agent surface. */
const APP_RECENT_KINDS: ReadonlySet<RecentEntry['kind']> = new Set([
  'path',
  'app',
  'surface',
  'session',
])

/** The nav's words for the state, and the conflicting paths, which the nav's
 *  banner carries. */
function syncText(state: SyncState | null): string {
  if (state === null) return 'not open'
  const text = syncLabel(state).text
  return state.kind === 'conflict' || state.kind === 'reconciling'
    ? [text, ...state.paths].join('\n')
    : text
}

/** Longest calendar window an app may ask for in one call. */
const MAX_AGENDA_DAYS = 92

const ENTRIES = {
  'docs.list': cap({
    doors: ['app', 'cli'],
    params: noParams,
    // The listing, not just the read: an app that cannot open a memory but can
    // see every memory's path has still been told what the vault remembers.
    run: async (ctx): Promise<VaultSnapshot['docs']> =>
      (await ctx.snapshot()).docs.filter((d) => !isAgentSurfacePath(d.path)),
    text: (docs) => docs.map((d) => d.path).join('\n'),
  }),

  'docs.read': cap({
    doors: ['app', 'cli'],
    params: (raw) => ({ path: stringParam(paramsObject(raw), 'path') }),
    run: (ctx, { path }): Promise<string> => readNote(ctx, path),
    text: (body) => body,
  }),

  'docs.render': cap({
    doors: ['app', 'cli'],
    params: (raw) => ({ path: stringParam(paramsObject(raw), 'path') }),
    run: async (ctx, { path }): Promise<string> => renderNote(await readNote(ctx, path)),
    text: (html) => html,
  }),

  search: cap({
    // The app door only, like `settings` and `history`: the agent has Grep,
    // Read and git, and a CLI twin would be a second way to do the same.
    doors: ['app'],
    params: (raw) => {
      const q = stringParam(paramsObject(raw), 'q').trim()
      if (q === '' || q.length > 200) {
        throw new CapabilityError('BAD_REQUEST', 'q must be 1 to 200 characters')
      }
      return { q }
    },
    run: async (ctx, { q }): Promise<SearchHit[]> =>
      searchVault(ctx.root, (await ctx.snapshot()).docs, q, isSearchable),
    text: (hits) => hits.map((h) => `${h.path}\t${h.snippet ?? ''}`).join('\n'),
  }),

  recents: cap({
    // Both: "the note I had open before this one" is what the agent cannot
    // find with its own tools.
    doors: ['app', 'cli'],
    params: noParams,
    run: async (ctx): Promise<RecentEntry[]> =>
      ctx.services
        .recents()
        .filter((e) => APP_RECENT_KINDS.has(e.kind))
        .filter((e) => (e.kind === 'path' || e.kind === 'app' ? readableOrNull(e.key) : true)),
    text: (entries) => entries.map((e) => `${e.kind}\t${e.key}`).join('\n'),
  }),

  settings: cap({
    doors: ['app'],
    params: noParams,
    run: async (ctx) => {
      const { warnings: _warnings, ...settings } = await readVaultSettings(ctx.root)
      return settings
    },
  }),

  members: cap({
    doors: ['app', 'cli'],
    params: noParams,
    // Login and avatar only: an app has no use for who may push.
    run: (ctx) =>
      unavailable(async () =>
        (await ctx.services.members()).map((m) => ({
          login: m.login,
          ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
        })),
      ),
    text: (members) => members.map((m) => m.login).join('\n'),
  }),

  history: cap({
    doors: ['app'],
    params: (raw) => {
      const p = paramsObject(raw)
      const path = p.path === undefined || p.path === '' ? undefined : stringParam(p, 'path')
      return { path, limit: limitParam(p, 'limit', 50, 200) }
    },
    run: async (ctx, { path, limit }) => {
      const repo = ctx.services.repo()
      if (path !== undefined) {
        // A deleted file's history is still history, so the snapshot is not
        // asked here; `--literal-pathspecs` and git's own case-sensitive match
        // are what keep `Memory/x.md` from naming `memory/x.md`.
        const rel = readablePath(path)
        return (await repo.log({ path: rel, limit })).map(({ sha, subject, date, author }) => ({
          sha,
          subject,
          date,
          author,
        }))
      }
      // The vault's history, with each commit's files. A commit that touched
      // only the agent surface (a memory, the index regen) is not shown at all,
      // and the surface's paths are dropped from the rest: an app that cannot
      // read a memory must not learn from history that one was written.
      const [commits, touched] = await Promise.all([repo.log({ limit }), repo.commitFiles(limit)])
      const filesBySha = new Map(touched.map((t) => [t.sha, t.files]))
      return commits.flatMap(({ sha, subject, date, author }) => {
        // A commit the file listing did not cover (one landed between the two
        // runs) is dropped rather than shown with no files to vouch for it.
        const all = filesBySha.get(sha)
        if (all === undefined) return []
        const files = all.filter((f) => readableOrNull(f) !== null)
        if (all.length > 0 && files.length === 0) return []
        return [{ sha, subject, date, author, files }]
      })
    },
    text: (commits) => commits.map((c) => `${c.date}\t${c.author}\t${c.subject}`).join('\n'),
  }),

  'sync.status': cap({
    doors: ['app', 'cli'],
    params: noParams,
    run: async (ctx): Promise<SyncState | null> => {
      const state = ctx.services.syncState()
      // An app is not told the names of conflicting agent-surface files; the
      // agent, at the CLI door, is.
      if (ctx.bundle === null || state === null) return state
      if (state.kind !== 'conflict' && state.kind !== 'reconciling') return state
      return { ...state, paths: state.paths.filter((p) => readableOrNull(p) !== null) }
    },
    text: syncText,
  }),

  'agent.sessions': cap({
    doors: ['app', 'cli'],
    params: noParams,
    run: async (ctx): Promise<SessionSummary[]> => ctx.services.sessions(),
    text: (sessions) => sessions.map((s) => `${s.state}\t${s.name}`).join('\n'),
  }),

  'calendar.events': cap({
    // The app door only: the agent has `holi-google`, and its own gate.
    doors: ['app'],
    params: (raw) => {
      const p = paramsObject(raw)
      const from = stringParam(p, 'from')
      const to = stringParam(p, 'to')
      const start = Date.parse(from)
      const end = Date.parse(to)
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
        throw new CapabilityError('BAD_REQUEST', 'from and to must be instants, from before to')
      }
      if (end - start > MAX_AGENDA_DAYS * 24 * 60 * 60 * 1000) {
        throw new CapabilityError('BAD_REQUEST', `at most ${MAX_AGENDA_DAYS} days at a time`)
      }
      return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() }
    },
    run: async (ctx, window) => {
      await requireGrant(ctx, 'calendar')
      const events = await unavailable(() => ctx.services.agenda(window))
      if (events === null) throw new CapabilityError('UNAVAILABLE', 'no Google account connected')
      return events
    },
  }),

  'mail.threads': cap({
    doors: ['app'],
    params: (raw) => {
      const p = paramsObject(raw)
      if (p.query !== undefined && typeof p.query !== 'string') {
        throw new CapabilityError('BAD_REQUEST', 'query must be a string')
      }
      return { query: p.query === undefined || p.query === '' ? undefined : p.query }
    },
    run: async (ctx, { query }) => {
      await requireGrant(ctx, 'mail')
      const page = await unavailable(() =>
        ctx.services.threads(query === undefined ? {} : { query }),
      )
      if (page === null) throw new CapabilityError('UNAVAILABLE', 'no Google account connected')
      return page.threads
    },
  }),

  'tasks.complete': cap({
    doors: ['app', 'cli'],
    writes: true,
    params: (raw) => ({ path: stringParam(paramsObject(raw), 'path') }),
    run: async (ctx, { path }) => {
      // The agent may name the task by its absolute path, as its tools do.
      const rel = await knownPath(
        ctx,
        isAbsolute(path) ? relative(ctx.root, path) : path.replace(/^\.\//, ''),
      )
      const result = await taskDoneOp(ctx.root, rel, ctx.services.today())
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      return result
    },
    text: (r) => (r.status === 'done' ? `done: ${r.path}` : `next: ${r.path} due ${r.due}`),
  }),

  'tasks.list': cap({
    doors: ['app', 'cli'],
    params: noParams,
    run: async (ctx): Promise<Task[]> => (await ctx.snapshot()).tasks,
    text: (tasks) => tasks.map((t) => `${t.status}\t${t.title}\t${t.path}`).join('\n'),
  }),

  'store.list': cap({
    doors: ['app', 'cli'],
    params: storeParams,
    run: (ctx, { bundle, collection }) => storeList(ctx.root, bundleOf(ctx, bundle), collection),
    text: ({ records, skipped }) =>
      [
        ...records.map((r) => `${r.id}  ${compact(r.value)}`),
        ...skipped.map((name) => `skipped: ${name}`),
      ].join('\n'),
  }),

  'store.get': cap({
    doors: ['app', 'cli'],
    params: (raw) => {
      const base = storeParams(raw)
      return { ...base, id: stringParam(base.p, 'id') }
    },
    run: (ctx, { bundle, collection, id }) =>
      storeGet(ctx.root, bundleOf(ctx, bundle), collection, id),
  }),

  'store.put': cap({
    doors: ['app', 'cli'],
    writes: true,
    params: (raw) => {
      const base = storeParams(raw)
      const id = base.p.id
      if (id !== undefined && typeof id !== 'string') {
        throw new CapabilityError('BAD_REQUEST', 'id must be a string')
      }
      return { ...base, id: id === '' ? undefined : id, value: valueParam(base.p.value) }
    },
    run: (ctx, { bundle, collection, id, value }) =>
      storePut(ctx.root, bundleOf(ctx, bundle), collection, id, value),
    text: (id) => id,
  }),

  'store.delete': cap({
    doors: ['app', 'cli'],
    writes: true,
    params: (raw) => {
      const base = storeParams(raw)
      return { ...base, id: stringParam(base.p, 'id') }
    },
    run: (ctx, { bundle, collection, id }) =>
      storeDelete(ctx.root, bundleOf(ctx, bundle), collection, id),
    text: (deleted) => (deleted ? 'deleted' : 'no such record'),
  }),

  /** The check hook's question: is this hand-written data file valid? */
  'store.check': cap({
    doors: ['cli'],
    params: (raw) => ({ path: stringParam(paramsObject(raw), 'path') }),
    run: async (ctx, { path }) => {
      // The hook passes the path the agent's tool wrote, which may be absolute.
      const rel = path.startsWith(`${ctx.root}/`) ? path.slice(ctx.root.length + 1) : path
      const bundle = appBundleOf(rel)
      if (bundle === null) throw new CapabilityError('BAD_REQUEST', `not inside an app: ${path}`)
      return storeCheck(ctx.root, bundle, rel.slice(bundle.length + 1))
    },
    text: (problems) => problems.join('\n'),
  }),
}

/** Every method the frame's bridge may call and main answers has an entry:
 *  leaving one out is a type error here rather than a hung promise in an app. */
const exhaustive: Record<MainAppMethod, AnyCapability> = ENTRIES
void exhaustive

export const CAPABILITIES: Readonly<Record<string, AnyCapability>> = ENTRIES

/**
 * Run one capability through one door: the whole of both doors' dispatch.
 * An unknown name, or one that does not open to this door, is refused as
 * "no such method", which is what it is from where the caller stands.
 */
export async function runCapability(
  name: string,
  door: Door,
  ctx: CapabilityContext,
  rawParams: unknown,
): Promise<{ value: unknown; text: string; writes: boolean }> {
  const entry = Object.hasOwn(CAPABILITIES, name) ? CAPABILITIES[name] : undefined
  if (entry === undefined || !entry.doors.includes(door)) {
    throw new CapabilityError('BAD_REQUEST', `no such method: ${name}`)
  }
  const value = await entry.run(ctx, entry.params(rawParams))
  return {
    value,
    text: entry.text !== undefined ? entry.text(value) : JSON.stringify(value, null, 2),
    writes: entry.writes === true,
  }
}
