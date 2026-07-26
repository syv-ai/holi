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
 * vault content: `*.local.*` basenames (`.holi/settings.local.json`,
 * `CLAUDE.local.md`, `.holi/context.local.json`) and the personal root
 * `USER.md` (agent PRD §Config layering). */
export function isLocalOnlyPath(path: string): boolean {
  if (path === 'USER.md') return true
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
export const LOCAL_ONLY_IGNORE_LINES: readonly string[] = ['USER.md', '*.local.*']

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
