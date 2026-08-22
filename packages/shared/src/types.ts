/**
 * The domain, after D60. Every identity in here is a **path** or a **remote** —
 * there are no server-assigned ids, because there is no server to assign them.
 */

export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'low' | 'medium' | 'high'
export type DocKind = 'note' | 'daily'

/**
 * A vault: a GitHub repo cloned under the Holi-managed root.
 *
 * `remote` (`owner/repo`) is the identity — two machines cloning the same repo
 * hold the same vault at different `path`s. The entry itself is machine-local:
 * a second laptop starts with an empty registry and adds its own.
 */
export interface VaultEntry {
  /** `owner/repo` — the identity. */
  remote: string
  /** Absolute path of the clone on this machine. */
  path: string
  /** Display name; defaults to the repo name. */
  name: string
  lastOpenedAt: string
}

/**
 * A note. The **path is the identity**, so there is no id and no `vaultId` — a
 * DocMeta is only ever read in the context of one open vault.
 *
 * `kind` is derived from the file's own frontmatter (`type: daily-note`), never
 * from its filename: a hand-authored note that merely looks like a date must not
 * be swept as a system-created daily.
 */
export interface DocMeta {
  /** Vault-relative, '/'-separated. */
  path: string
  kind: DocKind
  /** File mtime, ISO. There is no createdAt — git history is the record of that. */
  updatedAt: string
}

/** A non-markdown file the vault carries (spec §Arbitrary files). Not a note —
 *  it has no `kind`, no frontmatter, and never participates in wiki-links; the
 *  scanner keeps it out of `docs` precisely so backrefs/rename stay markdown. */
export interface FileMeta {
  /** Vault-relative, '/'-separated. */
  path: string
  /** File mtime, ISO. */
  updatedAt: string
}

/** A repo collaborator, straight from the GitHub API. Holi defines no roles. */
export interface Collaborator {
  /** GitHub's numeric account id — stable across a login rename. */
  accountId: number
  login: string
  avatarUrl?: string
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read'
}

// `SyncState` is not defined here. Main computes the vault's sync state, so the
// live union lives next to `computeState` in the desktop app
// (`main/vault/active-vault.ts`); a second copy here only drifted — it still
// carried the removed `ahead` kind. Deleted 2026-07-25 (D60/D61).

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type RecurrenceWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface Recurrence {
  frequency: RecurrenceFrequency
  interval: number
  weekdays?: RecurrenceWeekday[]
  /** YYYY-MM-DD — occurrences after this date stop the roll-forward. */
  endDate?: string
}

/**
 * A task: a `task.<name>.md` file, parsed.
 *
 * The **path is the identity**, and its **containing folder is its swim lane** —
 * which is why there is no `area` field. There is no `id` (nothing to join on),
 * no `version` (nothing to race with; git arbitrates between machines), and no
 * `related[]` (a task links to things by writing wiki-links in its body).
 */
export interface Task {
  /** Vault-relative, '/'-separated, e.g. `projects/q2/task.fix-login.md`. */
  path: string
  /** From frontmatter, falling back to the filename. Never empty. */
  title: string
  status: TaskStatus
  /** A stamp: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when the task is due at a
   *  time. The absence of a time is meaningful — due that day, not at midnight
   *  on it. */
  due?: string
  priority?: Priority
  tags: string[]
  /** When to be notified, as a stamp — an absolute moment, never an offset
   *  from `due` (D79). A stamp with no time fires at `ANCHOR_HOUR`. Anything
   *  that is not a stamp is inert: it is carried through the file untouched and
   *  never fires. */
  reminder?: string
  recurrence?: Recurrence
  /**
   * The card's rank within its board cell — a sparse number, not a position
   * (`prd/tasks.md` §Board UX). Absent sorts last, which is where a task the
   * agent just wrote belongs: at the bottom, not at a random height.
   *
   * It is the one key in a task file that means nothing to a human reading it,
   * and it is here rather than in a side file because order is a fact about a
   * task and the file is the whole task.
   */
  order?: number
  /** The markdown body. */
  description: string
  /**
   * Frontmatter keys this version of Holi does not understand, carried through
   * untouched.
   *
   * Editing a task rewrites the whole file, so without this a drag would silently
   * eat a pre-D60 `id`/`area` — or any key a human or another tool put there on
   * purpose. Absent rather than `{}` when everything was understood: an empty map
   * must serialize identically to never having had one.
   */
  extra?: Record<string, unknown>
}

/** A `task.*.md` that would not parse. */
export interface BrokenTask {
  path: string
  error: string
}

/**
 * Everything the vault holds, read fresh off disk.
 *
 * There is no index and nothing derived: the board, the tree and the editor all
 * read this one shape, so there is no second source to disagree with it.
 * `broken` is part of the snapshot rather than swallowed by the scan — a task
 * file omitted from the board is indistinguishable from data loss.
 */
export interface VaultSnapshot {
  docs: DocMeta[]
  tasks: Task[]
  broken: BrokenTask[]
  /** Non-markdown files, kept separate from notes so link-aware ops stay md-only. */
  files: FileMeta[]
  /** Real directories on disk. The tree renders these directly, so a folder shows
   *  even when its contents are all filtered out of the lists above (its only
   *  files are tasks, or hidden) or it is empty but for a `.gitkeep`. Git tracks
   *  no empty directory; the keep-file is what makes an empty one survive a clone. */
  dirs: string[]
  /** `.holi/icons.json` resolved: vault-relative path → a single emoji, and the
   *  only place an icon lives. Covers notes, folders and binaries alike, which
   *  is why a note's frontmatter is NOT a second source (see `icon-map.ts`). */
  icons: Record<string, string>
}

/** The lane a task sits in: its containing folder, '' for the vault root. */
export function taskArea(task: Pick<Task, 'path'>): string {
  const cut = task.path.lastIndexOf('/')
  return cut === -1 ? '' : task.path.slice(0, cut)
}
