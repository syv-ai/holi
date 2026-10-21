/**
 * The domain. Every identity in here is a **path** or a **remote**: there
 * are no generated ids.
 */

export type DocKind = 'note' | 'daily'

/** Lines of a note, 1-based and inclusive: a selection, as the agent is told it
 *  and as `Read` numbers them. */
export interface LineRange {
  startLine: number
  endLine: number
}

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
  /**
   * A whole-text write to one of its files from outside the plugin (a vault
   * app's `docs.write`), checked before it lands: throws, saying why, when
   * the write would change what only the plugin's own capabilities may (a
   * task's fields). `current` is the file's text, null for one not there yet.
   */
  checkNoteWrite?(path: string, current: string | null, next: string): void
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
