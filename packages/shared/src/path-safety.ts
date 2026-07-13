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
