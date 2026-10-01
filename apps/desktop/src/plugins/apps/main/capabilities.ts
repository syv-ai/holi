/**
 * Vault apps' capabilities (docs/features/vault-apps.md): `apps.*`, which is
 * Holi's own UI driving an app (its bridge calls, approvals and log) and the
 * agent's `holi apps open` and `holi apps init`; and `store.*`, an app's own
 * records, reached by the app through its bridge and by the agent through
 * `holi store`.
 *
 * **`apps.call` is how a frame's call reaches main**, and it opens only the
 * UI door: `AppFrame` forwards each bridge call through it, naming the bundle
 * it mounted, and it hands the call to the app door. A frame's own calls go
 * through the app door, whose allowlist is what was registered for it, so no
 * method name an app sends can reach `apps.call` or `apps.grant`: an app can
 * neither call on another's behalf nor approve itself.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { appBundleOf, isAppBundlePath } from '@holi/shared'
import { type AppLogLevel } from '../shared/store'
import {
  cap,
  CapabilityError,
  paramsObject,
  pathParams,
  stringParam,
  type AppContext,
  type AppDoor,
  type CapabilityContext,
} from '../../../main/plugin-api'
import {
  bundleAuthorship,
  commitLogin,
  manifestOf,
  type AppGrants,
  type BundleCommit,
} from './grants'
import { writeAppLog } from './log'
import { initAppOp, openAppOp } from './ops'
import { storeCheck, storeDelete, storeGet, storeList, storePut } from './store'

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

/** A `bundle` param from Holi's own UI, which must name an app. */
function bundleParam(p: Record<string, unknown>): string {
  const bundle = stringParam(p, 'bundle')
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

const LOG_LEVELS: readonly AppLogLevel[] = ['error', 'warn', 'info']

export interface AppCapabilitiesDeps {
  /** The apps' events: `open` asks the renderer to open (or reload) a
   *  bundle's tab in the active pane, if that vault is the one on screen. */
  events: Pick<AppContext, 'emit'>
  /** The app door, which the apps code opened. Read when a call arrives. */
  appDoor(): AppDoor
  /** This machine's approvals of apps' `dangerously-allow` reads. */
  grants: AppGrants
}

export const appsCapabilities = (deps: AppCapabilitiesDeps) => ({
  /**
   * One bridge call from the frame `AppFrame` mounted for `bundle`, through
   * the app door. Not a write itself: the call it carries refreshes the vault
   * when it writes.
   */
  'apps.call': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      return { bundle: bundleParam(p), method: stringParam(p, 'method'), params: p.params }
    },
    run: async (ctx, { bundle, method, params }) =>
      (await deps.appDoor().call(ctx.remote, bundle, method, params)).value,
  }),

  /** Which of the app's `dangerously-allow` reads this person has approved
   *  on this machine: what `AppFrame` asks before it mounts the frame. */
  'apps.grants': cap({
    doors: ['ui'],
    params: (raw) => ({ bundle: bundleParam(paramsObject(raw)) }),
    run: async (ctx, { bundle }) => {
      const status = await deps.grants.status(ctx.remote, ctx.root, bundle)
      // Only asked when there is something to approve: it names the code.
      if (!status.affordances.some((a) => !a.granted)) {
        return { ...status, reasons: {}, added: null, lastChange: null }
      }
      // The app's own words for why, shown quoted beside the ask.
      const reasons = (await manifestOf(ctx.root, bundle))?.allowReasons ?? {}
      const { added, last } = await bundleAuthorship(ctx.root, bundle)
      const logins = (await ctx.core.members().catch(() => [])).map((m) => m.login)
      const withLogin = (c: BundleCommit | null) =>
        c === null ? null : { ...c, login: commitLogin(c, logins) }
      return { ...status, reasons, added: withLogin(added), lastChange: withLogin(last) }
    },
  }),

  /** The person approved the dialog. UI door only, so an app can never
   *  approve itself. False: the app changed since the dialog was shown, so
   *  ask again. */
  'apps.grant': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      const affordances = p.affordances
      if (!Array.isArray(affordances) || !affordances.every((a) => typeof a === 'string')) {
        throw new CapabilityError('BAD_REQUEST', 'affordances must be strings')
      }
      return {
        bundle: bundleParam(p),
        codeHash: stringParam(p, 'codeHash'),
        affordances: affordances as string[],
      }
    },
    run: (ctx, { bundle, affordances, codeHash }) =>
      deps.grants.grant(ctx.remote, ctx.root, bundle, affordances, codeHash),
  }),

  /**
   * One line of an app's log, from its frame: what it reported going wrong
   * (`app-log.ts`). Not a write: the log is machine-local and the vault's
   * cache does not need to hear about it.
   */
  'apps.log': cap({
    doors: ['ui'],
    params: (raw) => {
      const p = paramsObject(raw)
      const level = LOG_LEVELS.find((l) => l === p.level)
      if (level === undefined) throw new CapabilityError('BAD_REQUEST', 'not a log entry')
      return { bundle: bundleParam(p), level, text: typeof p.text === 'string' ? p.text : '' }
    },
    run: async (ctx, { bundle, level, text }) => {
      await writeAppLog(ctx.root, bundle, { level, text })
      return true
    },
  }),

  /** Open a finished app's tab, or reload it. Reversible: the tab closes. */
  'apps.open': cap({
    doors: ['cli'],
    cli: {
      args: ['path'],
      summary: 'open a finished app in a tab, or reload it if it is already open',
    },
    params: pathParams,
    run: async (ctx, { path }) => {
      const result = await openAppOp(ctx.root, path)
      // The tab opens only once the app is known to be openable: a refusal
      // that still opened a tab would show the agent a blank frame and tell it
      // the reason at the same time.
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      deps.events.emit(ctx.remote, 'open', { bundle: result.bundle })
      return { bundle: result.bundle }
    },
    text: ({ bundle }) => `opened ${bundle}`,
  }),

  /** Scaffold a bundle, or finish one by writing its manifest: the agent's
   *  `holi apps init`, the explorer's New App and the tree's "Finish this
   *  app". Never overwrites, so it is safe to run twice. */
  'apps.init': cap({
    doors: ['ui', 'cli'],
    cli: { args: ['path'], summary: 'scaffold <path>, a folder ending in .app' },
    writes: true,
    params: pathParams,
    run: async (ctx, { path }) => {
      const result = await initAppOp(ctx.root, path)
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      return { created: result.created }
    },
    text: ({ created }) =>
      created.length === 0 ? 'nothing to create' : created.map((p) => `created ${p}`).join('\n'),
  }),
})

export type AppsCapabilities = ReturnType<typeof appsCapabilities>

export const storeCapabilities = () => ({
  'store.list': cap({
    doors: ['app', 'cli'],
    cli: { args: ['bundle', 'collection'], summary: "an app's records, one per line" },
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
    cli: { args: ['bundle', 'collection', 'id'], summary: 'one record' },
    params: (raw) => {
      const base = storeParams(raw)
      return { ...base, id: stringParam(base.p, 'id') }
    },
    run: (ctx, { bundle, collection, id }) =>
      storeGet(ctx.root, bundleOf(ctx, bundle), collection, id),
  }),

  'store.put': cap({
    doors: ['app', 'cli'],
    cli: {
      args: ['bundle', 'collection', 'value', 'id?'],
      summary: 'write a record, checked against its schema; prints its id',
    },
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
    cli: { args: ['bundle', 'collection', 'id'], summary: 'delete a record' },
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
    cli: { args: ['path'], summary: 'problems with a data file you wrote by hand' },
    params: pathParams,
    run: async (ctx, { path }) => {
      // The hook passes the path the agent's tool wrote, which may be absolute.
      const rel = path.startsWith(`${ctx.root}/`) ? path.slice(ctx.root.length + 1) : path
      const bundle = appBundleOf(rel)
      if (bundle === null) throw new CapabilityError('BAD_REQUEST', `not inside an app: ${path}`)
      return storeCheck(ctx.root, bundle, rel.slice(bundle.length + 1))
    },
    text: (problems) => problems.join('\n'),
  }),
})
