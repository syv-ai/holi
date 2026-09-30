/**
 * Holi's own views: the tabs that exist once each (a note or an app tab is of
 * something; these are not).
 *
 * The one list. The renderer's `SingletonTab` is this union, a vault app's
 * `holi.open('board')` accepts exactly these, and a landing is a subset of them.
 */
export const SINGLETON_SURFACES = [
  'home',
  'board',
  'agenda',
  'mail',
  'settings',
  'history',
] as const

export type SingletonSurface = (typeof SINGLETON_SURFACES)[number]

export function isSingletonSurface(value: unknown): value is SingletonSurface {
  return typeof value === 'string' && (SINGLETON_SURFACES as readonly string[]).includes(value)
}
