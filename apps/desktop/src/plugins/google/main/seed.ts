/**
 * What Google seeds into a vault (`vault/` beside this module): the send gate
 * hook and the gmail-calendar skill, shipped, and the agent's settings for
 * them.
 *
 * The gate matches Bash broadly and decides for itself, rather than relying on
 * an `if` condition: the agent can spell the command three ways, and a
 * condition that misses one fails OPEN while still reading like protection.
 * The hook defers on everything it does not recognise, so the cost is one
 * child process per Bash call. The same gate covers Gmail's MCP tools, for a
 * vault whose user re-enables a claude.ai connector.
 *
 * The `ask` rules are the *undoable* tier and are NOT the wall: allow-always
 * past them is fine, each has a one-click undo. The wall for send and reply is
 * the hook, which overrides both this list and a prior "don't ask again". The
 * send and reply rules here cover a vault whose hook file was removed. Claude
 * Code reads `holi google send:*` as a prefix, so each verb is its own rule.
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
      'Bash(holi google archive:*)',
      'Bash(holi google trash:*)',
      'Bash(holi google unschedule:*)',
      'Bash(holi google send:*)',
      'Bash(holi google reply:*)',
    ],
  },
}

export const googleSeed: SeedContribution = {
  id: 'google',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { '.claude/settings.json': [SETTINGS] },
}
