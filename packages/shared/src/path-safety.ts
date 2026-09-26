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
 * basename (`.holi/settings/app.local.yaml`, `.holi/state/context.local.json`,
 * `.holi/settings/theme.local.css`, `CLAUDE.local.md`, `USER.local.md`).
 *
 * The marker is the whole rule on purpose (D65): a file's git-vs-local status
 * must be legible from its name, never a special-cased exception. */
export function isLocalOnlyPath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path
  return /\.local\./.test(base)
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
 * The synced files Claude Code loads **once at launch**, so a change to any of
 * them under a live agent session is only picked up by restarting it, which is
 * what the "shared config changed; restart to pick it up" notice is for
 * (docs/features/agent-config.md).
 *
 * Deliberately NOT here: `.holi/settings/app.yaml` (Holi's config, not the
 * agent's), `*.local.*` overrides (never synced, so a pull can't change them),
 * and hooks/skills (re-read per invocation, so no restart is needed).
 */
export const AGENT_CONFIG_FILES: readonly string[] = [
  '.claude/settings.json',
  'CLAUDE.md',
  'AGENTS.md',
]

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
 * the hook that asks before mail leaves (D70).
 *
 * `.holi/` is deliberately absent: that is Holi's own config, not the agent's,
 * and it is where the app itself lives.
 */
export const AGENT_SURFACE_FILES: readonly string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'USER.local.md',
]

/** Where the vault's memory lives (D89). **Content, not plumbing**: at the root
 *  rather than under `.holi/`, so the user need not unhide it to read it.
 *
 *  Declared here rather than in `memory-index.ts` because `isAgentSurfacePath`
 *  below needs it and that module imports this one. */
export const MEMORY_DIR = 'memory'

/** Whether a vault-relative path is part of the agent surface. The four named
 *  files match **exactly** (like `isVaultConfigPath`, so `notes/AGENTS.md` is an
 *  ordinary note someone wrote); `.claude/` and `memory/` match as whole
 *  subtrees.
 *
 *  **`memory/` is `MEMORY.md` subdivided** (D89): what the user told the
 *  assistant does not become readable to untrusted app code by spreading it
 *  over more files. Root-anchored, so `notes/memory/x.md` stays an ordinary note.
 *
 *  **This is load-bearing for `scaffold-md` as well as for vault apps.**
 *  `wantsScaffold` refuses the agent surface, which stops the scaffolder
 *  prepending a `tags:` block to a memory file and to the generated
 *  `memory/index.md`.
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

/** Where vault apps live. Already hidden from the tree by `isHiddenPath`. */
export const APPS_DIR = '.holi/apps'

/**
 * Whether `id` may name an app.
 *
 * An app id is its directory name, and it becomes the **host** of a
 * `holi-app://` URL. Hosts are case-folded by every URL parser, so a mixed-case
 * directory would 404; the grammar is restricted instead, and anything else is
 * simply not an app.
 */
export function isValidAppId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id)
}

/** `.holi/apps/<id>/…` → `<id>`, or null when the path is not under `APPS_DIR`
 *  or the id is not one `isValidAppId` accepts. */
export function appIdFromPath(path: string): string | null {
  if (!path.startsWith(`${APPS_DIR}/`)) return null
  const id = path.split('/')[2]
  return id !== undefined && isValidAppId(id) ? id : null
}

/** An app's own folder, `.holi/apps/<id>`, and nothing inside it: "is this the
 *  app", which the tree needs to draw the folder as an app. */
export function isAppRootPath(path: string): boolean {
  const id = appIdFromPath(path)
  return id !== null && path === `${APPS_DIR}/${id}`
}
