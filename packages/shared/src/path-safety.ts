/**
 * Path safety: the vault sandbox boundary (docs/architecture.md §Security
 * boundaries).
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

/** Machine-local paths that sync and export layers must never treat as
 * committed vault content, identified **solely** by the `.local.` marker in the
 * file's name or in any folder above it (`.holi/settings/app.local.yaml`,
 * `USER.local.md`, and everything in a personal app, `Home.local.app/…`).
 *
 * The marker is the whole rule on purpose: a file's git-vs-local status
 * must be legible from its path, never a special-cased exception. A folder
 * counts because git already says so: `*.local.*` has no slash, so it matches
 * a directory and ignores everything under it. */
export function isLocalOnlyPath(path: string): boolean {
  return path.split('/').some((segment) => /\.local\./.test(segment))
}

/**
 * The `.gitignore` lines corresponding, exactly, to `isLocalOnlyPath`.
 *
 * **These two must not drift, which is why they live together.** The sync
 * engine commits with `git add -A`, so this list, written into every vault's
 * `.gitignore`, is the only thing standing between a machine-local file and a
 * commit published to every collaborator.
 */
export const LOCAL_ONLY_IGNORE_LINES: readonly string[] = ['*.local.*']

/**
 * The sentinel that says a clone IS a Holi vault, and the durable on-disk twin
 * of the `holi-vault` GitHub topic.
 *
 * **Extensionless, and its EXISTENCE is the signal**: a flag, not a document
 * (like `py.typed` or `.gitkeep`). It still carries a single line, the format
 * version, so a future migration has something to branch on.
 *
 * At the top of `.holi/` rather than in `settings/` or `state/`: it is neither
 * a choice somebody made nor machine state.
 */
export const VAULT_MARKER_FILE = '.holi/vault'

/**
 * The shared, committed config files whose contents configure the whole vault:
 * `.holi/settings/app.yaml` (Holi) and `.claude/settings.json` (the agent). A
 * merge conflict in either can leave the vault misconfigured while it lasts, so
 * the sync UI surfaces it louder than a note conflict
 * (docs/features/vaults-sync.md). The `*.local.*` overrides are absent on
 * purpose: they never sync, so they cannot conflict.
 */
export const VAULT_CONFIG_FILES: readonly string[] = [
  '.holi/settings/app.yaml',
  '.claude/settings.json',
]

/** Whether a vault-relative path is one of `VAULT_CONFIG_FILES`: an exact
 * match, so `notes/settings.json` or `.holi/settings/app.local.yaml` is not one. */
export function isVaultConfigPath(path: string): boolean {
  return VAULT_CONFIG_FILES.includes(path)
}

/**
 * Whether a vault-relative path is "hidden" in the explorer: true iff any
 * `/`-segment starts with a dot (`.gitignore`, `.holi/…`, a nested `sub/.foo`).
 * Display-only, and unrelated to `isLocalOnlyPath`, which is about what git must
 * not commit.
 */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.'))
}

/**
 * The marker file that keeps an otherwise-empty folder alive, since git tracks no
 * empty directory. It is a `dirs` signal, never a file leaf: being dot-prefixed it
 * is itself hidden, so the tree shows the *folder* from `dirs` rather than from
 * this file. */
export const GITKEEP = '.gitkeep'

/** Whether a path is a folder keep-marker (its basename is `.gitkeep`). */
export function isKeepFile(path: string): boolean {
  return (path.split('/').at(-1) ?? path) === GITKEEP
}

/**
 * The files that configure the assistant rather than hold content: the shared
 * instructions, the personal user model, and everything under `.claude/`.
 *
 * A vault app may neither read nor write them: that would be untrusted code
 * reading the user's memory, or rewriting `.claude/hooks/google-send-gate.mjs`,
 * the hook that asks before mail leaves.
 *
 * The rest of `.holi/` is deliberately absent: that is Holi's own config, not
 * the agent's. `.holi/memory/` is the one agent subtree under it (`MEMORY_DIR`).
 */
export const AGENT_SURFACE_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'USER.local.md',
]

/** Where the vault's memory lives: under `.holi/` with Holi's other vault
 *  files, so the agent's notes to itself stay out of the user's notes. It is
 *  hidden in the tree like the rest of `.holi/`, and committed and synced like
 *  `.holi/settings/app.yaml`; only `.local.` files in it stay on one machine.
 *
 *  Declared here rather than in `memory-index.ts` because `isAgentSurfacePath`
 *  below needs it and that module imports this one. */
export const MEMORY_DIR = '.holi/memory'

/** Whether a vault-relative path is part of the agent surface. The four named
 *  files match **exactly** (like `isVaultConfigPath`, so `notes/AGENTS.md` is an
 *  ordinary note someone wrote); `.claude/` and `.holi/memory/` match as whole
 *  subtrees.
 *
 *  **`.holi/memory/` is `MEMORY.md` subdivided**: what the user told the
 *  assistant does not become readable to untrusted app code by spreading it
 *  over more files. Root-anchored, so `notes/memory/x.md` stays an ordinary note.
 *
 *  **Git hooks are deliberately absent:** Holi's `pre-commit` lives in
 *  `.git/hooks/`, which the vault store never lists (`IGNORED_DIRS`), so it is
 *  unreachable through the app bridge by construction. A hook seeded into the
 *  tracked tree WOULD need to be here. */
export function isAgentSurfacePath(path: string): boolean {
  return (
    AGENT_SURFACE_FILES.includes(path) ||
    path.startsWith('.claude/') ||
    path.startsWith(`${MEMORY_DIR}/`)
  )
}

/** Where Holi keeps this machine's running state inside a vault: logs, the
 *  agent's per-turn files, and the loopback endpoints with their tokens. */
export const MACHINE_STATE_DIR = '.holi/state'

/** Whether a vault-relative path is machine state. A vault app may never read
 *  it, list it or learn its names: a bridge token there would let untrusted app
 *  code drive Holi as the agent does. Root-anchored, like the agent surface. */
export function isMachineStatePath(path: string): boolean {
  return path.startsWith(`${MACHINE_STATE_DIR}/`)
}
