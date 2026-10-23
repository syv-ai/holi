/**
 * What a tab of the shell holds (docs/features/tabs-panes.md): a document, a
 * vault app, the board, a New tab, the Agents home, an agent session, a
 * sidebar app (Mail, Calendar) or Settings. A tab is this descriptor; the
 * shell keeps it as its key, one stable string, so tab lists stay plain
 * arrays of strings and a key can sit in a DOM attribute or a set.
 *
 * The keys:
 *
 * - a document is its vault path as it is (`Notes/Plan.md`), so a path is
 *   its own tab id across the shell, the tree and an open request;
 * - a vault app is its bundle's path (`Apps/Budget.app`): the `.app` suffix
 *   says which;
 * - every other view is `holi:<kind>`, with its parts after it:
 *   `holi:board`, `holi:new:3`, `holi:agents`, `holi:settings`,
 *   `holi:app:mail`, `holi:session:<owner>:<id>` (the id may hold colons);
 * - a document whose path would read as one of those (it starts with
 *   `holi:`, or ends in `.app` without being an app) is `holi:doc:<path>`,
 *   so every descriptor survives the trip.
 *
 * Pure, with no imports: the parse and the key are the rules, and the tests
 * hold them (`__tests__/tab-descriptor.test.tsx`).
 */

export type TabDescriptor =
  | { kind: "doc"; path: string }
  | { kind: "vault-app"; path: string }
  | { kind: "board" }
  /** A tab showing the empty view until something is picked in it,
   *  numbered so two of them are two tabs. */
  | { kind: "new"; n: number }
  /** The Agents mode's home: the new-session page. */
  | { kind: "agents-home" }
  /** A row of the Agents sidebar, by the selection it makes
   *  (`AgentsSelection`). */
  | { kind: "session"; owner: string; id: string }
  /** A sidebar app (Mail, Calendar), by its id. */
  | { kind: "app"; id: string }
  /** Settings: one tab, ever. Its section is the nav's own state
   *  (`settingsSectionAtom`), not the tab's. */
  | { kind: "settings" }

export type TabKind = TabDescriptor["kind"]

const SCHEME = "holi:"
const APP_SUFFIX = ".app"

/** A key for a view that is not a vault path. */
function view(...parts: (string | number)[]): string {
  return SCHEME + parts.join(":")
}

/** Whether a bare path would parse as something other than a document. */
function ambiguous(path: string): boolean {
  return path.startsWith(SCHEME) || path.endsWith(APP_SUFFIX)
}

/** The tab's key: stable, and parsed back by `parseTabKey`. */
export function tabKey(tab: TabDescriptor): string {
  switch (tab.kind) {
    case "doc":
      return ambiguous(tab.path) ? view("doc", tab.path) : tab.path
    case "vault-app":
      return tab.path
    case "board":
      return view("board")
    case "new":
      return view("new", tab.n)
    case "agents-home":
      return view("agents")
    case "session":
      return view("session", tab.owner, tab.id)
    case "app":
      return view("app", tab.id)
    case "settings":
      return view("settings")
  }
}

/** A key back into its descriptor; null for a `holi:` key that names no
 *  view this build knows, or one missing its parts. */
export function parseTabKey(key: string): TabDescriptor | null {
  if (key === "") return null
  if (!key.startsWith(SCHEME)) {
    return key.endsWith(APP_SUFFIX)
      ? { kind: "vault-app", path: key }
      : { kind: "doc", path: key }
  }
  const rest = key.slice(SCHEME.length)
  const colon = rest.indexOf(":")
  const kind = colon === -1 ? rest : rest.slice(0, colon)
  const tail = colon === -1 ? null : rest.slice(colon + 1)
  switch (kind) {
    case "board":
      return tail === null ? { kind: "board" } : null
    case "agents":
      return tail === null ? { kind: "agents-home" } : null
    case "settings":
      return tail === null ? { kind: "settings" } : null
    case "doc":
      return tail ? { kind: "doc", path: tail } : null
    case "new": {
      const n = Number(tail)
      return tail && /^\d+$/.test(tail) ? { kind: "new", n } : null
    }
    case "app":
      return tail ? { kind: "app", id: tail } : null
    case "session": {
      if (tail === null) return null
      const at = tail.indexOf(":")
      if (at <= 0 || at === tail.length - 1) return null
      return {
        kind: "session",
        owner: tail.slice(0, at),
        id: tail.slice(at + 1),
      }
    }
    default:
      return null
  }
}

/** The tab a vault path opens as: its app when it is a bundle, else the
 *  document. */
export function tabForPath(path: string): TabDescriptor {
  return path.endsWith(APP_SUFFIX)
    ? { kind: "vault-app", path }
    : { kind: "doc", path }
}

/** The key's kind, or null for one that does not parse. */
export function tabKindOf(key: string | null): TabKind | null {
  return key === null ? null : (parseTabKey(key)?.kind ?? null)
}

/** The vault path a tab shows, for a document or a vault app. */
export function tabPath(key: string | null): string | null {
  if (key === null) return null
  const tab = parseTabKey(key)
  return tab?.kind === "doc" || tab?.kind === "vault-app" ? tab.path : null
}

export const BOARD_KEY = tabKey({ kind: "board" })
export const SETTINGS_KEY = tabKey({ kind: "settings" })
export const AGENTS_HOME_KEY = tabKey({ kind: "agents-home" })

/** The key of a session tab, from the selection it makes. */
export function sessionKey(selection: { owner: string; id: string }): string {
  return tabKey({ kind: "session", owner: selection.owner, id: selection.id })
}
