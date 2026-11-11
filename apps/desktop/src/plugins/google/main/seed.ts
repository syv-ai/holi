/**
 * What Google seeds into a vault (`vault/` beside this module): the send gate
 * hook and the gmail-calendar skill, shipped, and the agent's settings for
 * them.
 *
 * The gate matches Bash broadly and decides for itself, rather than relying on
 * an `if` condition: the agent can spell the command three ways, and a
 * condition that misses one fails OPEN while still reading like protection.
 * The hook has no opinion on anything it does not recognise, so the cost is one
 * child process per Bash call. The same gate covers Gmail's MCP tools, for a
 * vault whose user re-enables a claude.ai connector.
 *
 * The wall for send, reply, respond and a mutating `api` call is the hook, whose
 * `ask` overrides allow rules and a prior "don't ask again". The `ask` rules
 * stand in for it in a vault whose shipped hook predates a verb, until
 * `holi skills update`. Claude Code reads `holi google send:*` as a prefix, so
 * each verb, and each `api` method but GET, is its own rule.
 */
import { seedFolder, type SeedContribution, type SettingsFragment } from '../../../main/plugin-api'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

const SETTINGS: SettingsFragment = {
  hooks: [
    { event: 'PreToolUse', matcher: 'Bash', script: 'google-send-gate' },
    { event: 'PreToolUse', matcher: 'mcp__.*[Gg]mail.*', script: 'google-send-gate' },
  ],
  permissions: {
    ask: [
      'Bash(holi google send:*)',
      'Bash(holi google reply:*)',
      'Bash(holi google respond:*)',
      'Bash(holi google api POST:*)',
      'Bash(holi google api PUT:*)',
      'Bash(holi google api PATCH:*)',
      'Bash(holi google api DELETE:*)',
    ],
  },
}

export const googleSeed: SeedContribution = {
  id: 'google',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { '.claude/settings.json': [SETTINGS] },
}
