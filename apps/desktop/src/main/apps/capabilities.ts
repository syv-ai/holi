/**
 * Vault apps' capabilities: an app's own records (`store.*`), reached by the
 * app through its bridge and by the agent through `holi store`.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { appBundleOf, isAppBundlePath } from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import { paramsObject, pathParams, stringParam } from '../capabilities/params'
import { cap, type CapabilityContext } from '../capabilities/registry'
import { storeCheck, storeDelete, storeGet, storeList, storePut } from './app-store'

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

/** The namespaces vault apps own. */
export const APP_NAMESPACES = ['apps', 'store'] as const

export const APP_CAPABILITIES = {
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
}
