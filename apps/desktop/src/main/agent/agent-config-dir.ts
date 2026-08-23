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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Under `userData/`, beside `vaults.json`, `google-cache.db` and the rest. */
export const AGENT_CONFIG_DIR_NAME = 'agent-config'

const SETTINGS = 'settings.json'

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
