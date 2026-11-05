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
 * The `ask` rules are the *undoable* tier and are NOT the wall: allow-always
 * past them is fine, each has a one-click undo. The wall for send, reply,
 * respond and a mutating `api` call is the hook, which overrides both this list
 * and a prior "don't ask again". A maintained inline hook in this merged
 * fragment covers existing vaults whose frozen shipped gate predates those
 * verbs; the shipped gate supplies the detailed current parser and prompt.
 * Claude Code reads `holi google send:*` as a prefix, so each verb, and each
 * `api` method but GET, is its own rule.
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

// Existing vaults may have an older shipped hook. Embed the exact maintained
// implementation into the merged settings so those vaults receive the same
// parser and fail-closed policy without requiring a shipped-file update.
const GATE_SOURCE = folder.shipped['.claude/hooks/google-send-gate.mjs']
if (GATE_SOURCE === undefined) throw new Error('Google send gate seed is missing')
const INLINE_GATE_SOURCE = GATE_SOURCE.replace(
  'const raw = await readStdin()',
  "const raw = process.env.HOLI_HOOK_STDIN ?? ''",
)
const INLINE_GATE_IMPORT = `data:text/javascript;base64,${Buffer.from(INLINE_GATE_SOURCE).toString('base64')}`
const LEGACY_CONSENT_HOOK = `node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.env.HOLI_HOOK_STDIN=s;import('${INLINE_GATE_IMPORT}')})"`

const SETTINGS: SettingsFragment = {
  hooks: [
    { event: 'PreToolUse', matcher: 'Bash', command: LEGACY_CONSENT_HOOK },
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
