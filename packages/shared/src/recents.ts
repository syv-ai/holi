/**
 * What a recent names. The list itself is the renderer's (`state/recents.ts`),
 * reported to main so a vault app can read it through the bridge.
 */
export type RecentKind = 'path' | 'session' | 'terminal' | 'surface' | 'command'

export interface RecentEntry {
  kind: RecentKind
  /** A vault-relative path, a session's job id, an agent terminal's id, a
   *  surface's name, or a command id, by `kind`. */
  key: string
  /** Which one of a surface that is one tab per thing: a vault app's bundle
   *  path for the surface `app`. */
  id?: string
}

export const RECENTS_CAP = 50
