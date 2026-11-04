/** A tab onto a surface from the registry (`state/plugins.ts`): Home, the
 *  board, settings, a plugin's view, a vault app. `id` names which one, for a
 *  surface that is one tab per thing (an app's is its bundle's path); without
 *  it there is one of the surface, ever. */
export interface SurfaceTab {
  kind: 'surface'
  surface: string
  id?: string
}

/**
 * A tab is either a note, by path, or a surface (one per thing when it has an
 * id, such as an app or an agent terminal).
 *
 * The `preview` flag is VS Code's two-state model: a preview tab (italic) is the
 * single one that a single-click *replaces* rather than adding to, so browsing a
 * vault costs one tab. Absent or false means pinned.
 */
export type Tab = { kind: 'note'; path: string; preview?: boolean } | SurfaceTab
