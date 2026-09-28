/**
 * Holi's own Claude Code config directory (D72).
 *
 * Without it a vault agent would inherit the machine's `~/.claude`: its skills,
 * plugins, marketplaces, MCP servers and claude.ai connectors. `CLAUDE_CONFIG_DIR`
 * is the only lever that reaches all of them at once (project settings cannot
 * disable user-scope skills or plugins), and this module provisions what it
 * points at.
 *
 * **One directory per vault** (D86), at `userData/agent-config/<vault-slug>/`.
 * Transcripts are keyed by cwd anyway, but `plugins/` and user-scope
 * `settings.json` are keyed by nothing, so a shared directory would let a plugin
 * installed in one vault reach every vault.
 *
 * The price: credentials are keyed to the config directory (the keychain entry
 * is suffixed per directory), so this costs a `/login` per vault, paid lazily
 * the first time the agent is opened there.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveColorMode } from '@holi/shared'
import { readVaultSettings } from '../vault/settings'

/** Under `userData/`, beside `vaults.json`, `google-cache.db` and the rest. */
export const AGENT_CONFIG_DIR_NAME = 'agent-config'

const SETTINGS = 'settings.json'
/** Claude Code's own state file. Holi reads it and never writes it. */
const CLAUDE_JSON = '.claude.json'
/** Holi's, and named as Holi's: this directory has had an agent in it. */
const SPAWNED_MARKER = '.holi-spawned'

/**
 * The directory name a vault's config lives under, from its remote (D86).
 *
 * Stable and filesystem-safe, because it is the address of a login and of a
 * transcript store: a name that drifts orphans both.
 *
 * The readable half follows Claude Code's own `projects/<cwd-slug>` convention:
 * every character outside `[A-Za-z0-9]` becomes a dash. That alone is **not injective** (`syv/better-holi` and `syv-better/holi` collide),
 * and two vaults sharing one directory is the plugin leak this exists to close,
 * so eight hex of a hash of the *remote* rides along.
 */
export function agentConfigSlug(remote: string): string {
  const readable = remote
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const hash = createHash('sha1').update(remote).digest('hex').slice(0, 8)
  // A remote of pure punctuation leaves nothing readable; the hash is the name.
  return readable === '' ? hash : `${readable}-${hash}`
}

/** What Holi resolved the app's colour mode to (D85's `activeModeAtom`). */
export type AgentTheme = 'dark' | 'light'

/**
 * A path as one word for `sh`. Only used to recognise the status line Holi
 * used to install, whose command was the quoted script path.
 */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** Where Holi's old `holi-statusline` script lived (D101, retired by D110). */
function retiredStatusLine(userDataDir: string): string {
  return join(userDataDir, 'bin', 'holi-statusline')
}

/** What a spawn stamps into the config directory's `settings.json`. */
export interface ConfigDirStamp {
  theme?: AgentTheme
  /**
   * Variables every session on this directory gets, through Claude Code's own
   * settings `env` block (D110). A background session's environment is the
   * supervisor's, not Holi's, but a settings `env` block reaches every session,
   * a pre-warmed one included. Only static paths go here: anything that changes
   * per app run lives in `holi.env` (see `endpoint-file.ts`).
   */
  env?: Record<string, string>
  /** Holi's retired status-line script path. A `statusLine` running exactly
   *  that is removed; anyone else's is left alone. */
  retiredStatusLine?: string
}

/**
 * The settings text this directory should have, or **null** if it already
 * carries what Holi requires (or cannot be parsed).
 *
 * Key-wise, like the vault's `settingsWithRequired`: this file accumulates the
 * user's own choices, and rewriting it wholesale would discard them. A different
 * required set, because the vault's hook commands mean nothing at user scope.
 *
 * - `disableClaudeAiConnectors` is a **default**, written only when absent. It is
 *   a second layer under the vault's own copy of the same key, so a vault whose
 *   `.claude/settings.json` was deleted still gets no cloud connectors, and a
 *   user who deliberately wrote `false` is not overruled.
 * - `theme` **tracks a setting**, so it is written whenever it differs. Claude
 *   Code's `"auto"` detects the terminal background, and inside Holi's embedded
 *   PTY there is nothing reliable to detect.
 * - `env` keys Holi names **track paths** that move with the app, so they are
 *   written whenever they differ. The user's own `env` keys stay.
 *
 * Written here rather than into the vault's own `.claude/settings.json`, which
 * syncs: a path on this machine means nothing on a teammate's.
 */
function settingsWithRequired(existing: string | null, stamp: ConfigDirStamp = {}): string | null {
  const { theme, env, retiredStatusLine: retired } = stamp
  if (existing === null || existing.trim() === '') {
    const seed: Record<string, unknown> = { disableClaudeAiConnectors: true }
    if (theme) seed.theme = theme
    if (env && Object.keys(env).length > 0) seed.env = { ...env }
    return JSON.stringify(seed, null, 2) + '\n'
  }

  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(existing)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    settings = parsed as Record<string, unknown>
  } catch {
    return null // the user's file; unparseable JSON is not ours to "fix"
  }

  let changed = false
  if (settings.disableClaudeAiConnectors === undefined) {
    settings.disableClaudeAiConnectors = true
    changed = true
  }
  if (theme && settings.theme !== theme) {
    settings.theme = theme
    changed = true
  }
  if (env) {
    const current =
      settings.env !== null && typeof settings.env === 'object' && !Array.isArray(settings.env)
        ? (settings.env as Record<string, unknown>)
        : {}
    const differs = Object.entries(env).some(([key, value]) => current[key] !== value)
    if (differs) {
      settings.env = { ...current, ...env }
      changed = true
    }
  }
  /**
   * The status line Holi used to install (D101). Session names now come from
   * Claude Code's own listing, and the script it ran reached Holi through an
   * environment a background session never has. Only Holi's own command goes.
   */
  if (retired !== undefined) {
    const current = settings.statusLine
    if (
      current !== null &&
      typeof current === 'object' &&
      (current as Record<string, unknown>).command === shellQuote(retired)
    ) {
      delete settings.statusLine
      changed = true
    }
  }

  return changed ? JSON.stringify(settings, null, 2) + '\n' : null
}

/**
 * Create and top up **this vault's** config directory, returning its absolute path.
 *
 * Run whenever Holi opens a terminal in the vault: a seed that only runs at
 * creation is a migration that never happens, the active vault changes while
 * the app runs, and `theme` has to track a setting the user can flip without
 * restarting.
 *
 * `projects/`, `sessions/` and `.claude.json` are deliberately NOT created:
 * Claude Code owns those, and pre-creating them would guess at its schema.
 */
export async function ensureAgentConfigDir(
  userDataDir: string,
  remote: string,
  stamp: ConfigDirStamp = {},
): Promise<string> {
  const configDir = join(userDataDir, AGENT_CONFIG_DIR_NAME, agentConfigSlug(remote))
  await mkdir(configDir, { recursive: true })

  const path = join(configDir, SETTINGS)
  const next = settingsWithRequired(await readFile(path, 'utf8').catch(() => null), stamp)
  if (next !== null) await writeFile(path, next, 'utf8')

  return configDir
}

/**
 * Has Holi ever spawned an agent in this config directory? Consumes the answer:
 * true once, false forever after.
 *
 * Drives the notice that a vault needs its own `/login`, and is deliberately
 * **Holi's own marker rather than a reading of Claude Code's state**.
 * `oauthAccount` in `<dir>/.claude.json` records an account, not whether the
 * keychain credential behind it is reachable, so it can say "signed in" while
 * the session prints `Not logged in`.
 *
 * The marker is a **proxy, not a heuristic**: credentials are keyed to the config
 * directory, so a directory Holi has never spawned in cannot be signed in.
 *
 * Never scrapes the PTY for any of this.
 */
export async function takeFirstSpawn(configDir: string): Promise<boolean> {
  const marker = join(configDir, SPAWNED_MARKER)
  if (
    await stat(marker).then(
      () => true,
      () => false,
    )
  )
    return false
  await writeFile(marker, '', 'utf8')
  return true
}

/** Everything a spawn needs to know about the vault's config directory. */
export interface AgentConfigResolution {
  /** Absolute path, handed to the child as `$CLAUDE_CONFIG_DIR`. */
  dir: string
}

/**
 * Everything the spawn path needs, in one call: provision the vault's config
 * directory and stamp the theme it should open in. The sign-in marker is left
 * alone (`takeFirstSpawn`): it is taken by the first terminal, not the open.
 *
 * The mode comes from the same pair D85 uses for `data-theme` (the vault's
 * `colorScheme` and the OS preference), through the same `resolveColorMode`, so
 * `system` cannot mean one thing to the app and another to the agent.
 *
 * `systemPrefersDark` is **injected** rather than read here: this module sits on
 * `agent-sessions`' path, which must load under vitest, so no runtime `electron`
 * import may appear in it. The caller owns `nativeTheme`.
 */
export async function resolveVaultAgentConfig(args: {
  userDataDir: string
  remote: string
  /** The vault's clone dir — where `colorScheme` is read from. */
  root: string
  systemPrefersDark: boolean
  /** Static paths every session should see (`ConfigDirStamp.env`). */
  env?: Record<string, string>
}): Promise<AgentConfigResolution> {
  const { colorScheme } = await readVaultSettings(args.root)
  const theme = resolveColorMode(colorScheme, args.systemPrefersDark)
  const dir = await ensureAgentConfigDir(args.userDataDir, args.remote, {
    theme,
    ...(args.env === undefined ? {} : { env: args.env }),
    retiredStatusLine: retiredStatusLine(args.userDataDir),
  })
  return { dir }
}

/** Staging for the migration below. A directory cannot be renamed into itself. */
const MIGRATING_DIR_NAME = `${AGENT_CONFIG_DIR_NAME}.migrating`

/**
 * Which registered vault does the shared directory actually belong to?
 *
 * **Not the most recently opened one**: looking at a vault does not open an
 * agent in it. The directory says so itself. Claude Code keys `.claude.json`'s `projects{}` by
 * **absolute working directory**, so a key matching a registered clone path is
 * that vault having run the agent. Registry order is `lastOpenedAt` descending,
 * so scanning it in order breaks a tie towards the more recent vault.
 *
 * Null only when no vault matches — a directory no agent ever ran in, which has
 * no history to strand, so the caller may fall back to anything at all.
 */
function usedByVault(
  claudeJson: string | null,
  vaults: readonly { remote: string; path: string }[],
): string | null {
  if (claudeJson === null) return null
  let projects: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(claudeJson)
    if (typeof parsed !== 'object' || parsed === null) return null
    const raw = (parsed as Record<string, unknown>).projects
    if (typeof raw !== 'object' || raw === null) return null
    projects = raw as Record<string, unknown>
  } catch {
    return null
  }

  const worked = new Set(Object.keys(projects))
  return vaults.find((v) => worked.has(v.path))?.remote ?? null
}

/**
 * One-shot: the shared directory D72 left behind becomes a vault's own.
 *
 * `userData/agent-config/` may hold one vault's transcripts and plugin set, so it
 * is **renamed** into that vault's slot rather than stranded.
 *
 * **What it carries is files.** The **credential is not in the directory**: it is
 * a macOS keychain entry that Claude Code owns, so treat a re-login after the
 * move as possible rather than as a bug.
 *
 * Renames, never copies: two same-volume renames of a whole directory never
 * open a file inside another program's state store.
 *
 * Idempotent by construction: after a move there is no top-level `settings.json`
 * left to find. Interruptible too — a crash between the renames leaves the
 * staging directory, which the next run picks up and finishes.
 *
 * `vaults` is the registry as `list()` hands it over, `lastOpenedAt` descending.
 * Returns the remote it was given to, or null when nothing moved.
 */
export async function migrateSharedAgentConfig(
  userDataDir: string,
  vaults: readonly { remote: string; path: string }[],
): Promise<string | null> {
  const parent = join(userDataDir, AGENT_CONFIG_DIR_NAME)
  const staging = join(userDataDir, MIGRATING_DIR_NAME)

  // Read the evidence BEFORE anything moves — afterwards the paths are stale.
  const source = (await stat(staging).then(
    (s) => s.isDirectory(),
    () => false,
  ))
    ? staging
    : parent
  const owner =
    usedByVault(await readFile(join(source, CLAUDE_JSON), 'utf8').catch(() => null), vaults) ??
    vaults[0]?.remote ??
    null
  if (owner === null) return null // nowhere to put it
  const slot = join(parent, agentConfigSlug(owner))

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )
  /** Someone has already been here (a downgrade, then an upgrade). Their
   *  directory is the live one; never bury it under an older copy. */
  const taken = () => exists(slot)

  const interrupted = await stat(staging).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!interrupted) {
    // Every install that ever ran `ensureAgentConfigDir` has this file, and the
    // per-vault layout has only subdirectories — so its presence IS the old shape.
    const isFlat = await stat(join(parent, SETTINGS)).then(
      (s) => s.isFile(),
      () => false,
    )
    if (!isFlat) return null
    // Checked BEFORE the rename, not after: the rename carries the slot into the
    // staging directory, and a check on the far side would find nothing and bury
    // the live directory inside itself.
    if (await taken()) return null
    await rename(parent, staging)
  }

  await mkdir(parent, { recursive: true })
  // The interrupted path skipped the check above; a slot here means someone
  // rebuilt the parent while the staging directory sat orphaned. Leave both.
  if (await taken()) return null
  await rename(staging, slot)
  return owner
}
