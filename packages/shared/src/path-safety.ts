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
 * basename (`.holi/settings/app.local.json`, `.holi/state/context.local.json`,
 * `.holi/settings/theme.local.json`, `CLAUDE.local.md`, `USER.local.md`).
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
 * The sentinel that says a clone IS a Holi vault, and the durable on-disk twin
 * of the `holi-vault` GitHub topic.
 *
 * **Extensionless, and its EXISTENCE is the signal.** It used to be
 * `.holi/vault` holding `{"version": 1}` — a shape nothing ever parsed,
 * because the only reader asks whether the file can be read at all. An
 * extension promises a document you open; this is a flag, and the convention
 * for one is a bare name (`py.typed`, `.gitkeep`, `.nvmrc`).
 *
 * It still carries a single line — the format version — so a future migration
 * has something to branch on. That costs nothing and an empty file throws the
 * option away.
 *
 * At the top of `.holi/` rather than in `settings/` or `state/`: it is neither
 * a choice somebody made nor machine state, and a marker buried a level down is
 * a worse marker.
 */
export const VAULT_MARKER_FILE = '.holi/vault'

/**
 * The shared, committed config files whose contents configure the whole vault:
 * `.holi/settings/app.json` (Holi) and `.claude/settings.json` (the agent). A
 * merge conflict in either is a conflict in *config*, not content, and can leave
 * the vault misconfigured while it lasts — so the sync UI surfaces it louder than
 * an ordinary note conflict (vaults-sync.md §Edge cases). The machine-local
 * `*.local.json` overrides are absent on purpose: they never sync, so they
 * cannot conflict.
 */
export const VAULT_CONFIG_FILES: readonly string[] = [
  '.holi/settings/app.json',
  '.claude/settings.json',
]

/** Whether a vault-relative path is one of the shared config files
 * (`VAULT_CONFIG_FILES`) — an exact match, so a same-named file elsewhere in the
 * tree (`notes/settings.json`) or a local override (`.holi/settings/app.local.json`)
 * is not one. */
export function isVaultConfigPath(path: string): boolean {
  return VAULT_CONFIG_FILES.includes(path)
}

/**
 * The synced files Claude Code loads **once at launch**, so a change to any of
 * them under a live agent session is only picked up by restarting it — which is
 * what the AgentPanel's "shared config changed; restart to pick it up" nudge is
 * for (agent.md). Settings plus the always-loaded memory: `.claude/settings.json`
 * (overlaps `VAULT_CONFIG_FILES` — it is both sync-conflict-worthy and
 * restart-worthy), `CLAUDE.md`, and the `AGENTS.md` it shims to.
 *
 * Deliberately NOT here: `.holi/settings/app.json` (Holi's config, not the agent's),
 * `*.local.*` overrides (never synced, so a collaborator's pull can't change
 * them), and hooks/skills (external scripts re-read per invocation, not cached at
 * launch — no restart needed).
 */
export const AGENT_CONFIG_FILES: readonly string[] = [
  '.claude/settings.json',
  'CLAUDE.md',
  'AGENTS.md',
]

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

/**
 * The files that configure the assistant rather than hold content: the shared
 * instructions, the personal user model, and everything under `.claude/`.
 *
 * A vault app may neither read nor write them. `.claude/hooks/google-send-gate.mjs`
 * IS the mail send gate (D70), so a readable-or-writable agent surface is an app
 * escalating to the agent — a page from an untrusted directory reading the
 * user's memory, or rewriting the hook that asks before mail leaves.
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

/** Where the vault's memory lives (D89). **Content, not plumbing** — at the
 *  root rather than under `.holi/`, because the thing the user most wants to
 *  read and correct should not be a file they have to unhide first.
 *
 *  Declared here rather than in `memory-index.ts`, where the rest of the memory
 *  rules live, because `isAgentSurfacePath` below needs it and that module needs
 *  `isLocalOnlyPath` from this one. The constant is the lower fact of the two. */
export const MEMORY_DIR = 'memory'

/** Whether a vault-relative path is part of the agent surface. The four named
 *  files match **exactly** (like `isVaultConfigPath`, so `notes/AGENTS.md` is an
 *  ordinary note someone wrote); `.claude/` and `memory/` match as whole
 *  subtrees.
 *
 *  **`memory/` is `MEMORY.md` subdivided** (D89). A vault app hosts untrusted
 *  code, and what the user told the assistant does not become readable by
 *  spreading it over more files. A prefix rather than an exact name because it
 *  is a directory, which also means `notes/memory/x.md` stays an ordinary note.
 *
 *  **This is load-bearing for `scaffold-md` as well as for vault apps.**
 *  `wantsScaffold` refuses the agent surface, so adding `memory/` here is also
 *  what stops the scaffolder prepending a `created:`/`tags:` block to a memory
 *  file — whose frontmatter is `type` and `description` — and, worse, to the
 *  generated `memory/index.md`, which the indexer would then rewrite straight
 *  back on the same commit.
 *
 *  **Git hooks are deliberately absent, because they are not vault content.**
 *  Holi's `pre-commit` lives in `.git/hooks/`, which git never commits and the
 *  vault store never lists (`IGNORED_DIRS`) — so it is unreachable through the
 *  app bridge by construction rather than by rule. A hook seeded into the
 *  tracked tree WOULD need to be here, and that is one of the reasons it is not
 *  seeded there. */
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
 * `holi-app://` URL — hosts are case-folded by every URL parser, so `My_App`
 * and `my_app` would collide, and a mixed-case directory would 404 in a way
 * that looks like a path bug rather than a naming one. The grammar is
 * restricted instead: anything else is simply not an app.
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

/** An app's own folder, `.holi/apps/<id>` — and nothing inside it. `appIdFromPath`
 *  answers "which app does this belong to", which is true of every file in the
 *  app; this answers "is this the app", which is what the tree needs to know to
 *  draw the folder as an app rather than a folder. */
export function isAppRootPath(path: string): boolean {
  const id = appIdFromPath(path)
  return id !== null && path === `${APPS_DIR}/${id}`
}
