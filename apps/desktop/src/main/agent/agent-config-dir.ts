/**
 * Holi's own Claude Code config directory (D72).
 *
 * A vault agent used to be a plain Claude Code session with the machine's
 * `~/.claude` underneath it, so it inherited that machine's skills, plugins,
 * marketplaces, MCP servers and claude.ai connectors — none of which a vault
 * declared and none of which Holi knows exist. `CLAUDE_CONFIG_DIR` is the only
 * lever that reaches all of them at once (project settings cannot disable
 * user-scope skills or plugins), and this module provisions what it points at.
 *
 * **One directory per vault** (D86), at `userData/agent-config/<vault-slug>/`.
 *
 * This reverses D72's shared directory, and the reversal is narrow. D72 was right
 * that per-vault *history* comes free — Claude Code keys transcripts, prompt
 * history and project config by working directory (`projects/<cwd-slug>/`), so a
 * shared directory never mixed those. What it did not weigh was **capability**:
 * `plugins/` — marketplaces and installed plugins, 444 files on a real install —
 * is keyed by nothing at all, so a plugin installed while working in one vault
 * was reachable by the agent in every vault. So was user-scope `settings.json`.
 *
 * The price is real and unchanged: credentials are keyed to the config directory
 * (a symlinked `.claude.json` does not carry them, and the keychain entry is
 * suffixed per directory), so this costs a `/login` per vault. It is paid
 * **lazily** — the panel asks the first time the agent is opened in that vault,
 * never during onboarding — and it buys a vault agent that gets nothing from
 * another vault except the Claude Code binary.
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

/**
 * The directory name a vault's config lives under, from its remote (D86).
 *
 * Stable and filesystem-safe, because it is the address of a login and of a
 * transcript store: a name that drifts orphans both.
 *
 * The readable half follows Claude Code's own convention for the same problem
 * (`projects/-Users-nicolaibthomsen-Holi-nthomsencph-privat`) — every character
 * outside `[A-Za-z0-9]` becomes a dash. That alone is **not injective**, though:
 * `syv/better-holi` and `syv-better/holi` both sanitize to `syv-better-holi`,
 * and two vaults quietly sharing one config directory is the exact plugin leak
 * this decision exists to close. So eight hex of a hash of the *remote* rides
 * along, and the collision stops being possible rather than merely unlikely.
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
 * The settings text this directory should have, or **null** if it already
 * carries what Holi requires (or cannot be parsed).
 *
 * Key-wise, the same rule and for the same reason as the vault's
 * `settingsWithRequired`: this file accumulates the user's own choices — their
 * `/login`, a model preference — and rewriting it wholesale on every launch
 * would discard them. It is a *different* required set, though, and so not that
 * function: the vault's includes hook commands whose paths are relative to a
 * vault, which mean nothing at user scope.
 *
 * **Two keys, two rules**, and the difference is what each one is:
 *
 * - `disableClaudeAiConnectors` is a **default**, written only when absent. It is
 *   a second layer under the vault's own copy of the same key, so a vault whose
 *   `.claude/settings.json` was deleted or never merged still gets no cloud
 *   connectors — and a user who deliberately wrote `false` is not overruled.
 * - `theme` **tracks a setting**, so it is written on every spawn and the last
 *   write wins. Claude Code ships `"auto"`, meaning *detect the terminal
 *   background*, and inside Holi's embedded PTY there is nothing reliable to
 *   detect: the agent stayed dark while D85 took the app light. Holi answers the
 *   question instead of leaving it to be guessed.
 */
function settingsWithRequired(existing: string | null, theme?: AgentTheme): string | null {
  if (existing === null || existing.trim() === '') {
    const seed: Record<string, unknown> = { disableClaudeAiConnectors: true }
    if (theme) seed.theme = theme
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

  return changed ? JSON.stringify(settings, null, 2) + '\n' : null
}

/**
 * Create and top up **this vault's** config directory, returning its absolute path.
 *
 * Run on **every spawn**, not on first run and no longer once per app launch: a
 * seed that only runs at creation is a migration that never happens (D70's
 * lesson, learned when the send gate shipped as an inert file in every vault
 * that already existed), and per launch is now simply wrong — the active vault
 * changes while the app runs, and `theme` has to track a setting the user can
 * flip without restarting.
 *
 * `projects/`, `sessions/` and `.claude.json` are deliberately NOT created —
 * Claude Code owns those and makes them itself; pre-creating them would be
 * guessing at another program's schema.
 */
export async function ensureAgentConfigDir(
  userDataDir: string,
  remote: string,
  opts: { theme?: AgentTheme } = {},
): Promise<string> {
  const configDir = join(userDataDir, AGENT_CONFIG_DIR_NAME, agentConfigSlug(remote))
  await mkdir(configDir, { recursive: true })

  const path = join(configDir, SETTINGS)
  const next = settingsWithRequired(await readFile(path, 'utf8').catch(() => null), opts.theme)
  if (next !== null) await writeFile(path, next, 'utf8')

  return configDir
}

/**
 * Is this config directory signed in?
 *
 * `<configDir>/.claude.json` is where Claude Code records the account, under an
 * `oauthAccount` key. Reading it is the whole check — **never scrape the PTY for
 * this** (standing decision, and unnecessary: the answer is a key in a JSON file).
 *
 * A **missing** file is the fresh-directory case, which is exactly the one that
 * has to be surfaced. An **unparseable** one reads as signed in: it is not
 * evidence of anything, and telling a logged-in user to `/login` is worse than
 * staying quiet.
 */
export async function isAgentSignedIn(configDir: string): Promise<boolean> {
  const raw = await readFile(join(configDir, CLAUDE_JSON), 'utf8').catch(() => null)
  if (raw === null) return false

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
    return (parsed as Record<string, unknown>).oauthAccount !== undefined
  } catch {
    return true
  }
}

/** Everything a spawn needs to know about the vault's config directory. */
export interface AgentConfigResolution {
  /** Absolute path, handed to the child as `$CLAUDE_CONFIG_DIR`. */
  dir: string
  /** False → the panel owes the user the `/login` instruction before Claude
   *  prints its own bare `Not logged in`. */
  signedIn: boolean
}

/**
 * Everything the spawn path needs, in one call: provision the vault's config
 * directory, stamp the theme it should open in, and say whether it is signed in.
 *
 * The mode comes from the same pair D85 uses for `data-theme` — the vault's
 * `colorScheme` setting and what the OS currently reports, through the same pure
 * `resolveColorMode`. Resolving it twice, two ways, is how `system` ends up
 * meaning one thing to the app and another to the agent.
 *
 * `systemPrefersDark` is **injected** rather than read here: this module sits on
 * `agent-manager`'s path, which must load under vitest, so no runtime `electron`
 * import may appear in it. The caller owns `nativeTheme`.
 */
export async function resolveVaultAgentConfig(args: {
  userDataDir: string
  remote: string
  /** The vault's clone dir — where `colorScheme` is read from. */
  root: string
  systemPrefersDark: boolean
}): Promise<AgentConfigResolution> {
  const { colorScheme } = await readVaultSettings(args.root)
  const theme = resolveColorMode(colorScheme, args.systemPrefersDark)
  const dir = await ensureAgentConfigDir(args.userDataDir, args.remote, { theme })
  return { dir, signedIn: await isAgentSignedIn(dir) }
}

/** Staging for the migration below. A directory cannot be renamed into itself. */
const MIGRATING_DIR_NAME = `${AGENT_CONFIG_DIR_NAME}.migrating`

/**
 * Which registered vault does the shared directory actually belong to?
 *
 * **Not the most recently opened one**, which is what the first version of this
 * asked and what a real install proved wrong: `lastOpenedAt` answers "which vault
 * did you last look at", and looking at a vault does not open an agent in it. On
 * the install this was measured against, the head of the registry was a vault
 * created minutes earlier and never worked in, while the login and every
 * transcript in the directory belonged to one that had been used for days.
 *
 * The directory says so itself. Claude Code keys `.claude.json`'s `projects{}` by
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
 * `userData/agent-config/` is already logged in and already holds one vault's
 * transcripts. Leaving it stranded would cost the vault someone actually uses
 * both, on upgrade, for nothing. So it is **renamed** into that vault's slot.
 *
 * The 2026-08-14 spec refused to *copy* transcripts between directories, on the
 * grounds that rewriting another program's state store is a bad bet. This is a
 * different operation and a much safer one: two same-volume renames of a whole
 * directory, which never open a file inside it. The 444-file `plugins/` tree
 * rides along, which is right — it is where those plugins were installed.
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
  const source = (await stat(staging).then((s) => s.isDirectory(), () => false)) ? staging : parent
  const owner =
    usedByVault(await readFile(join(source, CLAUDE_JSON), 'utf8').catch(() => null), vaults) ??
    vaults[0]?.remote ??
    null
  if (owner === null) return null // nowhere to put it
  const slot = join(parent, agentConfigSlug(owner))

  const exists = (path: string) => stat(path).then(() => true, () => false)
  /** Someone has already been here (a downgrade, then an upgrade). Their
   *  directory is the live one; never bury it under an older copy. */
  const taken = () => exists(slot)

  const interrupted = await stat(staging).then((s) => s.isDirectory(), () => false)
  if (!interrupted) {
    // Every install that ever ran `ensureAgentConfigDir` has this file, and the
    // per-vault layout has only subdirectories — so its presence IS the old shape.
    const isFlat = await stat(join(parent, SETTINGS)).then((s) => s.isFile(), () => false)
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
