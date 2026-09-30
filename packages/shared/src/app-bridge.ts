/**
 * The wire between a vault app and Holi.
 *
 * A vault app runs in a frame with an **opaque** origin (`sandbox="allow-scripts"`
 * and deliberately no `allow-same-origin`), so it has no ambient access to
 * anything: no `localStorage`, no cookies, no reach into the renderer's DOM. Its
 * one route to the vault is `postMessage` to its parent, and this module is the
 * vocabulary of that route, shared so the shim injected in main, the dispatch
 * in the renderer, and the `apps.*` procedures cannot drift apart.
 *
 * The refusals are NOT here: enforcement lives in main (`apps.*`), because the
 * process rendering untrusted app code must not also decide what it may read.
 */

import { isSingletonSurface, SINGLETON_SURFACES, type SingletonSurface } from './surfaces'

/**
 * Everything an app can ask for: reads of what Holi knows (notes, tasks,
 * recents, sync, search, settings, members, history, agent sessions, and, when
 * the app opts in with `dangerously-allow` and the user approves, calendar and
 * mail), "open this in Holi", its own store (records in its bundle's `data/`),
 * and completing a task. No other writes (docs/features/vault-apps.md), and no theme
 * getter: the theme is injected as CSS custom properties when the entry document
 * is served, so an app reads it with `var(--primary)`.
 */
export const APP_METHODS = [
  'docs.list',
  'docs.read',
  'tasks.list',
  'open',
  'store.get',
  'store.put',
  'store.delete',
  'store.list',
  'recents',
  'docs.render',
  'search',
  'settings',
  'members',
  'history',
  'sync.status',
  'agent.sessions',
  'calendar.events',
  'mail.threads',
  'tasks.complete',
] as const

export type AppMethod = (typeof APP_METHODS)[number]

/** The methods the renderer answers itself, because only it can do them
 *  (open a tab). Every other method is a main-side capability. */
export const RENDERER_METHODS = ['open'] as const satisfies readonly AppMethod[]

export type MainAppMethod = Exclude<AppMethod, (typeof RENDERER_METHODS)[number]>

/** One call, from the app's shim to the renderer. `id` is the app's own
 *  correlation token and means nothing outside the frame's pending map. */
export interface AppRequest {
  id: string
  method: AppMethod
  params?: unknown
}

/** The answer, back to the frame. A refusal is a value, not a thrown error:
 *  the app must be able to render "this is not available" rather than break. */
export type AppResponse =
  { id: string; ok: true; value: unknown } | { id: string; ok: false; error: string }

/** What `holi.open` accepts besides a path: Holi's own views, all of them. */
export const APP_SURFACES = SINGLETON_SURFACES

export type AppSurface = SingletonSurface

export const isAppSurface = isSingletonSurface

/**
 * What `holi.on(topic, fn)` can hear, besides `store:<collection>`. A push
 * says only that something changed: the app reads it again through the
 * bridge, so every refusal still applies, and there is no second read path.
 */
export const APP_TOPICS = ['docs', 'tasks', 'sync', 'agent', 'recents', 'history'] as const

export type AppTopic = (typeof APP_TOPICS)[number]

const STORE_TOPIC = 'store:'

/** The topic a collection's changes are pushed on. */
export function storeTopic(collection: string): string {
  return `${STORE_TOPIC}${collection}`
}

export function isAppTopic(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if ((APP_TOPICS as readonly string[]).includes(value)) return true
  return (
    value.startsWith(STORE_TOPIC) &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value.slice(STORE_TOPIC.length))
  )
}

/** A push, from the renderer to the frame. It has no `id`, which is how the
 *  shim tells it from a reply, and no payload. */
export interface AppPush {
  push: string
}
