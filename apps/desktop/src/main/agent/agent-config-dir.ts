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
 * **One directory, shared by every vault.** Per-vault directories were the first
 * instinct and are worse: credentials are keyed to the config directory, so each
 * one would cost its own `/login` — while the thing they appear to buy, separate
 * session history, comes free anyway, because Claude Code keys transcripts by
 * working directory (`projects/<cwd-slug>/`).
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
 * Only `disableClaudeAiConnectors`, and only when absent. It is a second layer
 * under the vault's own copy of the same key, so a vault whose
 * `.claude/settings.json` was deleted or never merged still gets no cloud
 * connectors — and a user who deliberately wrote `false` is not overruled once
 * a launch.
 */
function settingsWithRequired(existing: string | null): string | null {
  if (existing === null || existing.trim() === '') {
    return JSON.stringify({ disableClaudeAiConnectors: true }, null, 2) + '\n'
  }

  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(existing)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    settings = parsed as Record<string, unknown>
  } catch {
    return null // the user's file; unparseable JSON is not ours to "fix"
  }

  if (settings.disableClaudeAiConnectors !== undefined) return null
  settings.disableClaudeAiConnectors = true
  return JSON.stringify(settings, null, 2) + '\n'
}

/**
 * Create and top up the shared config directory, returning its absolute path.
 *
 * Run on **every** launch, not on first run: a seed that only runs at creation
 * is a migration that never happens (D70's lesson, learned when the send gate
 * shipped as an inert file in every vault that already existed), and this
 * directory will grow keys later.
 *
 * `projects/`, `sessions/` and `.claude.json` are deliberately NOT created —
 * Claude Code owns those and makes them itself; pre-creating them would be
 * guessing at another program's schema.
 */
export async function ensureAgentConfigDir(userDataDir: string): Promise<string> {
  const configDir = join(userDataDir, AGENT_CONFIG_DIR_NAME)
  await mkdir(configDir, { recursive: true })

  const path = join(configDir, SETTINGS)
  const next = settingsWithRequired(await readFile(path, 'utf8').catch(() => null))
  if (next !== null) await writeFile(path, next, 'utf8')

  return configDir
}
