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
import {
  appBundleOf,
  isAgentSurfacePath,
  isAppBundlePath,
  isAppDataPath,
  vaultRelPath,
  type MainAppMethod,
  type Task,
  type VaultSnapshot,
} from '@holi/shared'
import { absPathFor } from '../vault/vault-files'
import { storeCheck, storeDelete, storeGet, storeList, storePut } from './app-store'
import { CapabilityError } from './capability-error'

export { CapabilityError }

export type Door = 'app' | 'cli'

export interface CapabilityContext {
  remote: string
  /** The vault clone's root on this machine. */
  root: string
  /** The calling app's bundle at the app door; null at the CLI door. */
  bundle: string | null
  snapshot(): Promise<VaultSnapshot>
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
    run: async (ctx, { path }): Promise<string> => {
      if (isAgentSurfacePath(path)) throw new CapabilityError('FORBIDDEN', path)
      let rel
      try {
        rel = vaultRelPath(path)
      } catch (err) {
        throw new CapabilityError('BAD_REQUEST', (err as Error).message)
      }
      // Any app's records, its own included: the store is the only way in, so
      // one app cannot read another's data, a personal app's least of all.
      const bundle = appBundleOf(rel)
      if (bundle !== null && isAppDataPath(rel.slice(bundle.length + 1))) {
        throw new CapabilityError('FORBIDDEN', path)
      }
      const text = await readFile(absPathFor(ctx.root, rel), 'utf8').catch(() => null)
      if (text === null) throw new CapabilityError('NOT_FOUND', path)
      return text
    },
    text: (body) => body,
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
