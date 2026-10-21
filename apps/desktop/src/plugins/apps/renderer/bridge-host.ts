/**
 * The renderer's end of an app's bridge: what answers a frame that holds an
 * app's code. `AppFrame` is one such frame, and a slash command's hidden frame
 * (`commands.ts`) is another; both answer through this, so an app's code is
 * told the same things wherever it runs.
 *
 * Identity is the caller's job: it hands over only messages whose
 * `event.source` is the frame it mounted, and it names the bundle it mounted.
 * What a call may reach is decided in main (`apps.call`).
 */
import { isSurfaceName } from '@holi/shared'
import { APP_METHODS, type AppMethod, type AppResponse } from '../shared/bridge'
import {
  openPathAtom,
  openSurfaceAtom,
  snapshotAtom,
  surfacesAtom,
  type PluginStore,
} from '@/plugin-api'
import { APP_LOG_LEVELS } from '../shared/store'
import { appsCap } from './apps-cap'

function isAppMethod(value: unknown): value is AppMethod {
  return typeof value === 'string' && (APP_METHODS as readonly string[]).includes(value)
}

/** A string field out of a call's params, or null when there isn't one. */
function fieldOf(params: unknown, key: 'target'): string | null {
  if (params === null || typeof params !== 'object') return null
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/**
 * `holi.open(target)`: a registered view by name wins over a file of the same
 * name; else a vault file, or an app's bundle as that app. `open` is the one
 * call only this process can answer.
 */
export function openTarget(store: PluginStore, params: unknown): { ok: true } {
  const target = fieldOf(params, 'target')
  if (target === null) throw new Error('open needs a path or a view')
  if (store.get(surfacesAtom).has(target)) {
    store.set(openSurfaceAtom, target)
    return { ok: true }
  }
  // A bare name that is no view and no file at the vault's root is a view
  // this vault does not have, such as one whose plugin is off.
  const snapshot = store.get(snapshotAtom)
  const isFile = [...snapshot.docs, ...snapshot.files].some((f) => f.path === target)
  if (isSurfaceName(target) && !isFile) throw new Error(`no such view: ${target}`)
  // An app's bundle is a folder: it opens as the app, not as a file.
  store.set(openPathAtom, target, 'preview')
  return { ok: true }
}

/** One bridge call from `bundle`'s code, answered: `open` here, every other
 *  method by main through the app door. */
export async function answerCall(
  store: PluginStore,
  remote: string | null,
  bundle: string,
  method: AppMethod,
  params: unknown,
): Promise<unknown> {
  if (remote === null) throw new Error('no vault is open')
  if (method === 'open') return openTarget(store, params)
  return await appsCap.call(remote, { bundle, method, params })
}

/**
 * A message from `bundle`'s frame: a line for its log, or a bridge call,
 * answered through `reply`. False when it was neither, so the caller can look
 * for messages of its own.
 */
export function hostBridgeMessage(
  data: unknown,
  ctx: {
    store: PluginStore
    remote: string | null
    bundle: string
    reply: (response: AppResponse) => void
  },
): boolean {
  const { store, remote, bundle, reply } = ctx
  if (data === null || typeof data !== 'object') return false
  const msg = data as {
    id?: unknown
    method?: unknown
    params?: unknown
    log?: { level?: unknown; text?: unknown }
  }
  // A line for the app's log: no answer, and a failure to write it is not
  // the app's to hear about. Main checks it again, with the bundle. Never
  // a `load` line, which is `AppFrame`'s own, so an app cannot move where
  // `holi apps console` starts reading.
  if (typeof msg.log === 'object' && msg.log !== null) {
    const { text } = msg.log
    const level = APP_LOG_LEVELS.find((l) => l !== 'load' && l === msg.log?.level)
    if (remote !== null && level !== undefined && typeof text === 'string') {
      appsCap.log(remote, { bundle, level, text }).catch(() => {})
    }
    return true
  }
  if (typeof msg.id !== 'string') return false
  const id = msg.id
  if (!isAppMethod(msg.method)) {
    // Refused as a value rather than dropped: an app that asked for
    // something that does not exist should be able to say so, and a call
    // that never answers is indistinguishable from Holi having hung.
    reply({ id, ok: false, error: `no such method: ${String(msg.method)}` })
    return true
  }
  answerCall(store, remote, bundle, msg.method, msg.params).then(
    (value) => reply({ id, ok: true, value }),
    (err: unknown) => {
      const code = refusalCodeOf(err)
      reply({ id, ok: false, error: (err as Error).message, ...(code ? { code } : {}) })
    },
  )
  return true
}

/** tRPC's verdict, as `ipcLink` rebuilt it onto `err.data.code`. */
function refusalCodeOf(err: unknown): string | null {
  const data = (err as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : null
}
