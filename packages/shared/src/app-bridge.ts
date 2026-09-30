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

/**
 * Everything an app can ask for: read-only notes and tasks, "open this note in
 * Holi", and its own store (records in its bundle's `data/`). No other writes
 * (docs/features/vault-apps.md), and no theme
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
