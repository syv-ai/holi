/**
 * The domain. Every identity in here is a **path** or a **remote**: there
 * are no generated ids.
 */

export type TaskStatus = 'todo' | 'doing' | 'done'
export type Priority = 'low' | 'medium' | 'high'
export type DocKind = 'note' | 'daily'

/**
 * A vault: a GitHub repo cloned under the Holi-managed root.
 *
 * `remote` (`owner/repo`) is the identity: two machines cloning the same repo
 * hold the same vault at different `path`s. The entry itself is machine-local:
 * a second laptop starts with an empty registry and adds its own.
 */
export interface VaultEntry {
  /** `owner/repo`: the identity. */
  remote: string
  /** Absolute path of the clone on this machine. */
  path: string
  /** Display name; defaults to the repo name. */
  name: string
  lastOpenedAt: string
}

/**
 * A note. The **path is the identity**, so there is no id and no `vaultId`: a
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
  /** File mtime, ISO. There is no createdAt: git history is the record of that. */
  updatedAt: string
}

/** A non-markdown file the vault carries. Not a note: it has no `kind`, no
 *  frontmatter, and never participates in wiki-links; the scanner keeps it out
 *  of `docs` so backrefs/rename stay markdown. */
export interface FileMeta {
  /** Vault-relative, '/'-separated. */
  path: string
  /** File mtime, ISO. */
  updatedAt: string
}

/** A repo collaborator, straight from the GitHub API. Holi defines no roles. */
export interface Collaborator {
  /** GitHub's numeric account id, stable across a login rename. */
  accountId: number
  login: string
  avatarUrl?: string
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read'
}

// `SyncState` is in `sync-state.ts`, with its label; main's `computeState`
// decides which one is in force.

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export type RecurrenceWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface Recurrence {
  frequency: RecurrenceFrequency
  interval: number
  weekdays?: RecurrenceWeekday[]
  /** YYYY-MM-DD. Occurrences after this date stop the roll-forward. */
  endDate?: string
}

/**
 * A task: a `task.<name>.md` file, parsed.
 *
 * The **path is the identity**, and its **containing folder is its swim lane**,
 * so there is no `area` field. There is no `id` (nothing to join on), no
 * `version` (git arbitrates between machines), and no `related[]` (a task links
 * to things by writing wiki-links in its body).
 */
export interface Task {
  /** Vault-relative, '/'-separated, e.g. `projects/q2/task.fix-login.md`. */
  path: string
  /** The body's first heading at any level, falling back to the filename.
   *  Never empty, and never stored: `serializeTaskFile` writes no `title`. */
  title: string
  status: TaskStatus
  /** A stamp: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM` when the task is due at a
   *  time. The absence of a time is meaningful: due that day, not at midnight
   *  on it. */
  due?: string
  priority?: Priority
  tags: string[]
  /**
   * Who the task is for: GitHub logins of the vault's members, without the
   * `@`. Absent when it is no one's in particular, which is every member's:
   * its reminder then reaches everyone running Holi. A login is a name, not
   * an identity (an account can be renamed), the same trade GitHub's own
   * `@mentions` make.
   */
  assignees?: string[]
  /** When to be notified, as a stamp: an absolute moment, never an offset
   *  from `due`. A stamp with no time fires at `ANCHOR_HOUR`. Anything
   *  that is not a stamp is inert: it is carried through the file untouched and
   *  never fires. */
  reminder?: string
  recurrence?: Recurrence
  /**
   * The card's rank within its board cell: a sparse number, not a position
   * (docs/features/tasks.md). Absent sorts last, which is where a task the
   * agent just wrote belongs.
   *
   * In the file rather than a side file because the file is the whole task.
   */
  order?: number
  /** The markdown body. */
  description: string
  /**
   * Frontmatter keys this version of Holi does not understand, carried through
   * untouched.
   *
   * Editing a task rewrites the whole file, so without this a drag would silently
   * eat any key a human or another tool put there on purpose. Absent rather than
   * `{}` when everything was understood: an empty map must serialize identically
   * to never having had one.
   */
  extra?: Record<string, unknown>
}

/** A claimed file that would not parse. */
export interface BrokenFile {
  path: string
  error: string
}

/** What a claim's `parse` makes of one file: whatever it likes, with its path. */
export interface ClaimedItem {
  path: string
}

/**
 * What one plugin's claim made of the files it owns (`SnapshotClaim`). A file
 * that would not parse is reported in `broken` rather than dropped: one
 * omitted from its view is indistinguishable from data loss.
 */
export interface ClaimedFiles<T extends ClaimedItem = ClaimedItem> {
  items: T[]
  broken: BrokenFile[]
}

/**
 * A plugin owning a kind of markdown file in the snapshot
 * (docs/architecture.md, Plugins). Main's scanner parses every file `match`
 * accepts with `parse`, which returns the item or throws to report the file
 * broken, and keeps those files out of `docs`. `normalize` is the file's
 * canonical form, applied by the `normalize-md` commit transform and
 * recognised by the editor as Holi's own tidy, so both must use the same
 * claims.
 */
export interface SnapshotClaim {
  match(path: string): boolean
  parse(text: string, path: string): ClaimedItem
  normalize?(text: string): string
}

/**
 * Everything the vault holds, read fresh off disk.
 *
 * There is no index and nothing derived: the board, the tree and the editor all
 * read this one shape, so there is no second source to disagree with it.
 */
export interface VaultSnapshot {
  docs: DocMeta[]
  /** The files each enabled plugin claims, parsed, by plugin id. Every
   *  claiming plugin has an entry, empty or not. */
  claimed: Record<string, ClaimedFiles>
  /** Non-markdown files, kept separate from notes so link-aware ops stay md-only. */
  files: FileMeta[]
  /** Real directories on disk. The tree renders these directly, so a folder shows
   *  even when its contents are all filtered out of the lists above (its only
   *  files are tasks, or hidden) or it is empty but for a `.gitkeep`. Git tracks
   *  no empty directory; the keep-file is what makes an empty one survive a clone. */
  dirs: string[]
  /** `.holi/settings/icons.yaml` resolved: vault-relative path → a single emoji, and the
   *  only place an icon lives (see `icon-map.ts`). */
  icons: Record<string, string>
  /**
   * The paths git ignores, so the tree can dim them the way every IDE does.
   *
   * Answered by `git check-ignore` rather than by a rule in the renderer,
   * because **the name does not tell you**: `*.local.*` is only the seeded
   * rule, and a vault may ignore anything (an older vault carries a bare
   * `USER.md` line).
   *
   * Files **and** directories. Empty whenever git could not be asked, which the
   * tree renders as "nothing known to be ignored" rather than as an error.
   */
  ignored: string[]
}

/**
 * A snapshot of nothing, for the two callers that need one before a scan has
 * run and for the many tests that care about one field.
 *
 * A factory rather than a frozen const: every field is a fresh mutable
 * container, so a caller pushing to a shared `[]` cannot corrupt another.
 * Spread it (`{...emptyVaultSnapshot(), docs}`) rather than writing the shape
 * out, so a new field does not have to be added to every literal.
 */
export const emptyVaultSnapshot = (): VaultSnapshot => ({
  docs: [],
  claimed: {},
  files: [],
  dirs: [],
  icons: {},
  ignored: [],
})

/** What the plugin `id` claimed in `snapshot`; empty when it claims nothing. */
export function claimedFiles(snapshot: VaultSnapshot, id: string): ClaimedFiles {
  return snapshot.claimed[id] ?? { items: [], broken: [] }
}

/** The lane a task sits in: its containing folder, '' for the vault root. */
export function taskArea(task: Pick<Task, 'path'>): string {
  const cut = task.path.lastIndexOf('/')
  return cut === -1 ? '' : task.path.slice(0, cut)
}
