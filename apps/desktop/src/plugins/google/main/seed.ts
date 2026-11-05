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

// Kept inline in merged settings so an older vault's frozen hook gets the same
// shell normalization and command-boundary handling for newly gated verbs.
const LEGACY_CONSENT_SOURCE = `
let input = ''
process.stdin.on('data', chunk => input += chunk).on('end', () => {
  const ask = () => console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'This Google action can reach another person; confirm it in the native permission prompt.'}}))
  try {
    const command = JSON.parse(input).tool_input?.command ?? ''
    let words = '', quote = ''
    for (let i = 0; i < command.length; i++) {
      const c = command[i]
      if (quote) {
        if (c === quote) quote = ''
        else if (c === '\\\\' && command[i + 1] === '\\n') i++
        else words += c === ' ' ? '\\uE000' : c
      } else if (c === '\\'' || c === '\"') quote = c
      else if (c === '\\\\') { if (command[i + 1] === '\\n') i++; else words += command[++i] ?? '' }
      else words += c
    }
    const re = /(?:^|[|;&(\\n])\\s*(?:command[ \\t]+)?(?:\\$\\{?HOLI_BIN\\}?|\\/[^|;&(\\n]*?\\bholi|[^\\s|;&(\\n]*\\bholi)[ \\t]+google[ \\t]+([A-Za-z-]+)\\b(?:[ \\t]+([^\\s|;&(]*))?/g
    for (const match of words.matchAll(re)) {
      const verb = match[1], method = match[2]
      if (['send','reply','forward','respond'].includes(verb) || (verb === 'api' && method !== 'GET')) { ask(); return }
    }
  } catch { ask() }
})`
const LEGACY_CONSENT_HOOK = `node -e "eval(Buffer.from('${Buffer.from(LEGACY_CONSENT_SOURCE).toString('base64')}', 'base64').toString())"`

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
