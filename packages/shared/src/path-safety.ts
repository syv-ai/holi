/**
 * Path safety — the vault sandbox boundary (architecture §9, ported test-first
 * from the old Rust `models/path.rs` / `vault_fs::resolve_relative`).
 *
 * This module is pure and browser-safe. The fs-canonicalizing half lives in
 * `path-safety-node.ts` (subpath export `@holi/shared/path-safety-node`).
 */

declare const brand: unique symbol

/** A validated, normalized vault-relative path (e.g. `projects/q2/roadmap.md`). */
export type VaultRelPath = string & { readonly [brand]: 'VaultRelPath' }

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathSafetyError'
  }
}

/** Validate a raw string as a vault-relative path. Throws PathSafetyError. */
export function vaultRelPath(raw: string): VaultRelPath {
  if (raw === '') {
    throw new PathSafetyError('relative path is empty')
  }
  if (raw.includes('\0')) {
    throw new PathSafetyError('relative path contains NUL')
  }
  if (raw.includes('\\')) {
    throw new PathSafetyError(`path contains backslash (use '/'): ${raw}`)
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new PathSafetyError(`expected relative path, got absolute: ${raw}`)
  }
  const segments = raw.split('/').filter((seg) => seg !== '' && seg !== '.')
  if (segments.includes('..')) {
    throw new PathSafetyError(`relative path contains '..': ${raw}`)
  }
  if (segments.length === 0) {
    throw new PathSafetyError(`relative path is empty after normalization: ${raw}`)
  }
  return segments.join('/') as VaultRelPath
}

/** Machine-local paths that sync/mirror/export layers must never treat as
 * committed vault content — identified **solely** by the `.local.` marker in the
 * basename (`.holi/settings.local.json`, `.holi/context.local.json`,
 * `.holi/theme.local.json`, `CLAUDE.local.md`, `USER.local.md`).
 *
 * The marker is the whole rule on purpose: a file's git-vs-local status must be
 * legible from its name, never a special-cased exception. (This is why the
 * personal user model is `USER.local.md`, not a magically-ignored `USER.md`.) */
export function isLocalOnlyPath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path
  return /\.local\./.test(base)
}

/**
 * The `.gitignore` lines corresponding, exactly, to `isLocalOnlyPath`.
 *
 * **These two must not drift, which is why they live together.** The vault
 * store honours `isLocalOnlyPath`, but git has never heard of it — and the sync
 * engine commits with `git add -A`. So this list, written into every vault's
 * `.gitignore`, is the only thing standing between a machine-local file and a
 * commit published to every collaborator. A line missing here is a private file
 * in someone else's clone.
 */
export const LOCAL_ONLY_IGNORE_LINES: readonly string[] = ['*.local.*']

/**
 * The shared, committed config files whose contents configure the whole vault:
 * `.holi/settings.json` (Holi) and `.claude/settings.json` (the agent). A merge
 * conflict in either is a conflict in *config*, not content, and can leave the
 * vault misconfigured while it lasts — so the sync UI surfaces it louder than an
 * ordinary note conflict (vaults-sync.md §Edge cases). The machine-local
 * `*.local.json` overrides are absent on purpose: they never sync, so they
 * cannot conflict.
 */
export const VAULT_CONFIG_FILES: readonly string[] = ['.holi/settings.json', '.claude/settings.json']

/** Whether a vault-relative path is one of the shared config files
 * (`VAULT_CONFIG_FILES`) — an exact match, so a same-named file elsewhere in the
 * tree (`notes/settings.json`) or a local override (`.holi/settings.local.json`)
 * is not one. */
export function isVaultConfigPath(path: string): boolean {
  return VAULT_CONFIG_FILES.includes(path)
}

/**
 * Whether a vault-relative path is "hidden" in the explorer — true iff any
 * `/`-segment starts with a dot (`.gitignore`, `.holi/…`, `.claude/…`, a nested
 * `sub/.foo`). Display-only: the file tree's show/hide toggle keys off this, and
 * the managed non-dot files (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`) are
 * deliberately never hidden. Unrelated to `isLocalOnlyPath`, which is about what
 * git must not commit; this is about what the tree shows.
 */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'))
}

/**
 * The marker file that keeps an otherwise-empty folder alive. Git tracks no empty
 * directory, so creating a folder drops one of these; the scanner reads it only
 * to know the directory exists (it is surfaced as a `dirs` entry, never as a file
 * leaf). `.gitkeep` is the conventional name, and being dot-prefixed it is itself
 * hidden — which is exactly why the tree shows the *folder* from `dirs`, not from
 * this file (a folder kept alive by a hidden file would otherwise appear only
 * under show-hidden). */
export const GITKEEP = '.gitkeep'

/** Whether a path is a folder keep-marker (its basename is `.gitkeep`). */
export function isKeepFile(path: string): boolean {
  return (path.split('/').at(-1) ?? path) === GITKEEP
}
