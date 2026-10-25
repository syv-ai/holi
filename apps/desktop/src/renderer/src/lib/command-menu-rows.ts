/**
 * What the ⌘K command menu lists, and in what order. Pure, so a node test and
 * the screen agree: cmdk runs with `shouldFilter={false}` and renders exactly
 * what these return (`docs/features/command-palette.md`).
 *
 * Two kinds of row. A **place** is something that opens: a vault path (a note
 * or any other file) or a vault app. An **action** is something that runs:
 * a view to go to, or a live shortcut from `lib/shortcuts.ts`.
 *
 * With nothing typed, places are the vault's paths by modified time. With a
 * query, every row is scored by `command-score` (the scorer cmdk bundles) on
 * its name and then, at half weight, on its path, so a folder name still
 * finds the file inside it. A cap keeps a vault of thousands of files from
 * mounting thousands of items.
 */
import commandScore from 'command-score'
import { isHiddenPath, type VaultSnapshot } from '@holi/shared'

export interface PlaceRow {
  /** What opens it: the vault path, or the app bundle's path. */
  key: string
  kind: 'doc' | 'file' | 'app'
  name: string
  /** The folder, when it is not at the root. */
  detail?: string
  /** The vault's emoji for that path. */
  emoji?: string
  /** A git-ignored path: shown, dimmed. */
  dim?: boolean
  /** ISO mtime: the order of the untyped list. */
  updatedAt?: string
  /** A text match: the words around it, shown in place of the folder. */
  snippet?: string
}

export interface ActionRow {
  id: string
  label: string
  /** Other words that find it: "settings" for Open settings, "theme". */
  keywords?: readonly string[]
}

export const ROW_CAP = 50

/** How many paths the untyped list shows under Recent. */
export const RECENT_CAP = 6

function splitPath(path: string): { name: string; detail?: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { name: path } : { name: path.slice(slash + 1), detail: path.slice(0, slash) }
}

/** A markdown note is named without its `.md`, as the tree shows it. */
function noteName(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/** Every place: the vault's visible paths, then its apps (`instances`, each
 *  app bundle's path with its label). */
export function buildPlaces(
  snapshot: VaultSnapshot,
  apps: readonly { id: string; label: string }[] = [],
): PlaceRow[] {
  const ignored = new Set(snapshot.ignored)
  const path = (key: string, kind: 'doc' | 'file', updatedAt: string): PlaceRow => {
    const { name, detail } = splitPath(key)
    const emoji = snapshot.icons[key]
    return {
      key,
      kind,
      name: kind === 'doc' ? noteName(name) : name,
      ...(detail === undefined ? {} : { detail }),
      ...(emoji === undefined ? {} : { emoji }),
      ...(ignored.has(key) ? { dim: true } : {}),
      updatedAt,
    }
  }
  return [
    ...snapshot.docs
      .filter((d) => !isHiddenPath(d.path))
      .map((d) => path(d.path, 'doc', d.updatedAt)),
    ...snapshot.files
      .filter((f) => !isHiddenPath(f.path))
      .map((f) => path(f.path, 'file', f.updatedAt)),
    ...apps.map(({ id, label }): PlaceRow => {
      const { detail } = splitPath(id)
      return { key: id, kind: 'app', name: label, ...(detail === undefined ? {} : { detail }) }
    }),
  ]
}

/** A place against a query: its name first, then its path at half weight.
 *  `0` is no match. */
function scorePlace(row: PlaceRow, query: string): number {
  const byName = commandScore(row.name, query)
  return byName > 0 ? byName : commandScore(row.key, query) * 0.5
}

/** The places to show: the newest paths when nothing is typed, else the
 *  matches, best first. */
export function rankPlaces(rows: readonly PlaceRow[], query: string, cap = ROW_CAP): PlaceRow[] {
  const q = query.trim()
  if (q === '') {
    return rows
      .filter((r) => r.kind !== 'app')
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, RECENT_CAP)
  }
  return rows
    .map((row) => ({ row, score: scorePlace(row, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
    .slice(0, cap)
    .map(({ row }) => row)
}

/**
 * The notes whose text matched, after the name matches: in the order main
 * found them, only paths the menu lists by name too (so a hidden path stays
 * hidden), none the name rows already show.
 */
export function textPlaces(
  rows: readonly PlaceRow[],
  shown: readonly PlaceRow[],
  hits: readonly { path: string; snippet?: string }[],
  cap = ROW_CAP,
): PlaceRow[] {
  const byPath = new Map(rows.filter((r) => r.kind === 'doc').map((r) => [r.key, r]))
  const seen = new Set(shown.map((r) => r.key))
  const out: PlaceRow[] = []
  for (const hit of hits) {
    const row = byPath.get(hit.path)
    if (row === undefined || seen.has(hit.path)) continue
    seen.add(hit.path)
    out.push(hit.snippet === undefined ? row : { ...row, snippet: hit.snippet })
    if (out.length >= cap) break
  }
  return out
}

/** Actions in their given order when nothing is typed; else scored on the
 *  label, then on the keywords at half weight. */
export function rankActions<A extends ActionRow>(actions: readonly A[], query: string): A[] {
  const q = query.trim()
  if (q === '') return [...actions]
  const score = (a: A): number => {
    const byLabel = commandScore(a.label, q)
    if (byLabel > 0) return byLabel
    return Math.max(0, ...(a.keywords ?? []).map((k) => commandScore(k, q))) * 0.5
  }
  return actions
    .map((action) => ({ action, score: score(action) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ action }) => action)
}

/** The text after a leading `>`, trimmed: the menu lists actions only, as
 *  VS Code's box does. Null when the query does not start with one. */
export function actionQuery(query: string): string | null {
  return query.startsWith('>') ? query.slice(1).trimStart() : null
}
