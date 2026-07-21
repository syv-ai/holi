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

/** A repo collaborator, straight from the GitHub API. Holi defines no roles. */
export interface Collaborator {
  /** GitHub's numeric account id — stable across a login rename. */
  accountId: number
  login: string
  avatarUrl?: string
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read'
}

/** What a vault is doing. Exactly one of these is true at a time, and it must
 * never claim to be up to date when it isn't. */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'ahead'; commits: number }
  | { kind: 'pulling' }
  | { kind: 'offline'; commits: number }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling'; paths: string[] }

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
  /** YYYY-MM-DD */
  due?: string
  priority?: Priority
  tags: string[]
  /** Nd | Nw | YYYY-MM-DDTHH:MM */
  reminder?: string
  recurrence?: Recurrence
  /** The markdown body. */
  description: string
}

/** The lane a task sits in: its containing folder, '' for the vault root. */
export function taskArea(task: Pick<Task, 'path'>): string {
  const cut = task.path.lastIndexOf('/')
  return cut === -1 ? '' : task.path.slice(0, cut)
}
