/**
 * What Claude Code seeds into a vault: its hooks and skills (`vault/shipped/`
 * beside this module) and the `.claude/settings.json` it owns and merges
 * (`settings.ts`). It owns `.claude/`, so every other plugin's files and
 * fragments there wait until the agent runs.
 */
import {
  seedFolder,
  shellJobId,
  shellReadBridgeEnv,
  type SeedContribution,
  type SettingsFragment,
} from '../../../../main/plugin-api'
import { hookScript, mergeClaudeSettings } from './settings'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

const SETTINGS = '.claude/settings.json'

/**
 * The status line: one inline command, as Claude Code's own docs show, so a
 * vault needs no script for it and every vault gets it on its next open.
 *
 * `jq` prints the footer (`Opus 5.5 · 42% context`, the model alone before the
 * first message); it ships with macOS. Inside a Holi background session the
 * same JSON goes to the bridge, found through the vault's `bridge.local.env`
 * (parsed, never sourced) and keyed by the job id, the way `turn-signal.mjs`
 * does it. The post is detached with its output discarded, so a slow or absent
 * Holi never holds up the footer, and outside Holi the command only prints.
 */
const LEGACY_STATUS_LINE = [
  'input=$(cat)',
  `printf '%s' "$input" | jq -j '[.model.display_name, (.context_window.used_percentage // empty | round | tostring + "% context")] | map(select(. != null and . != "")) | join(" · ")'`,
  `if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then ${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('; ')}; if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$input" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/statusline?t=$HOLI_BRIDGE_TOKEN&job=\${CLAUDE_JOB_DIR##*/}" >/dev/null 2>&1 & fi; fi`,
  'true',
].join('; ')

const STATUS_FORMATTER = `let s=\"\";process.stdin.setEncoding(\"utf8\");process.stdin.on(\"data\",c=>s+=c);process.stdin.on(\"end\",()=>{try{const x=JSON.parse(s);const m=x?.model?.display_name;const n=x?.context_window?.used_percentage;const a=[];if(typeof m===\"string\"&&m)a.push(m);if(typeof n===\"number\"&&Number.isFinite(n))a.push(Math.floor(n+0.5)+\"% context\");process.stdout.write(a.join(\" · \"))}catch{}})`

/** @public exported for its test */
export const STATUS_LINE = [
  'input=$(cat)',
  `if command -v jq >/dev/null 2>&1; then printf '%s' "$input" | jq -j '[.model.display_name, (.context_window.used_percentage // empty | round | tostring + "% context")] | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null; else printf '%s' "$input" | node -e '${STATUS_FORMATTER}'; fi`,
  `${shellJobId('win32')}; case "$job" in ???????? ) case "$job" in *[!0-9a-f]* ) job= ;; esac ;; *) job= ;; esac; if [ -n "$job" ]; then ${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('; ')}; if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$input" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/statusline?t=$HOLI_BRIDGE_TOKEN&job=$job" >/dev/null 2>&1 & fi; fi`,
  'true',
].join('; ')

/** Claude Code's bundled skills a vault agent has no use for: code review,
 *  app launching, API and workflow authoring, Claude Code configuration, and
 *  importing another assistant's memory (a vault's memory is `.holi/memory/`). */
const OFF_SKILLS = [
  'code-review',
  'simplify',
  'security-review',
  'run',
  'init',
  'claude-api',
  'workflow-authoring',
  'update-config',
  'fewer-permission-prompts',
  'keybindings-help',
  'import-memory',
  // Claude Code's cloud routines: they run in Anthropic's cloud, away from
  // this machine's vault, Holi and its Google account. A vault's scheduled
  // agents are Holi's (the `scheduled-agents` skill).
  'schedule',
]

/**
 * The agent's own keys, each merged only when absent: a vault that sets one
 * back keeps its choice.
 */
const SETTINGS_BASE = {
  /**
   * No claude.ai cloud connectors in a vault.
   *
   * A claude.ai **Gmail** connector routes around every guarantee Holi
   * makes about mail: main is the sole token authority, the send gate
   * is a hook on `Bash`, and the cache is patched by Holi's own writes.
   * None of those apply to a tool Holi never sees.
   *
   * `true` in *any* source wins, so this checked-in project file opts the
   * vault out and a user-level `false` cannot undo it. It does not touch
   * skills or plugins inherited from `~/.claude`.
   */
  disableClaudeAiConnectors: true,
  /**
   * One memory surface, not two.
   *
   * Claude Code's own auto-memory lives outside the vault, never syncs, and
   * is the surface its system prompt steers the agent to. This key closes
   * that door so `.holi/memory/` is the one place to look.
   *
   * **Off rather than redirected.** `autoMemoryDirectory` is ignored in
   * projectSettings, and its format addresses memories by `[[slug]]` where
   * Holi's address them by vault path.
   */
  autoMemoryEnabled: false,
  /**
   * A quieter Claude Code: no session recap after being away, no greyed
   * next-prompt suggestion in the input. Not `/config`: it writes user
   * settings, which the project's value outranks.
   */
  awaySummaryEnabled: false,
  promptSuggestionEnabled: false,
  /**
   * The footer: the model and how much of the context window is used
   * (`STATUS_LINE`), which reads the same in any Claude Code. Inside Holi
   * it also hands the reading to the session's row. Replacing Claude
   * Code's footer drops its own hints (`esc to interrupt`); a machine that
   * wants them back sets its own `statusLine` in `settings.local.json`,
   * which outranks this one.
   */
  statusLine: { type: 'command', command: STATUS_LINE },
  /**
   * Background sessions edit the vault itself.
   *
   * Claude Code otherwise moves a dispatched session into a git worktree
   * under `.claude/worktrees/` before it edits: its work stays invisible to
   * the vault until merged, and the `.local.` files are not there at all.
   * Holi's sync, turn review and merge flow all assume one working tree.
   */
  worktree: { bgIsolation: 'none' },
  /** Claude Code's bundled skills that are about working on code, off. A
   *  skill the vault sets back to `"on"` keeps its entry. */
  skillOverrides: Object.fromEntries(OFF_SKILLS.map((name) => [name, 'off'])),
}

/** The agent's own hooks and rules. */
const AGENT_SETTINGS: SettingsFragment = {
  // Google's leftovers, retired here because only an enabled plugin's fragment
  // is merged, and a vault with Google switched off needs them gone too.
  retired: {
    // The two copies of the gate Holi wrote inline. An `ask` from any hook wins,
    // so each would keep prompting whatever the current gate says; but in a
    // vault whose shipped gate predates `respond` and `api`, one is all that
    // asks about those, so it stays until `holi skills update` brings the gate.
    hooks: {
      sha256: [
        'c6d21ee4a373b314cb3631d9513b85b7dac647cb4870bdc88d6ba874f52e65d2',
        '9a78405b52906801ba40755988142fe67ffce3cb67b6eecfbf289fad92b05c07',
      ],
      replacedBy: hookScript('google-send-gate'),
      holding: ['respond:', 'api:'],
    },
    // These reach nobody and have an undo.
    ask: [
      'Bash(holi google archive:*)',
      'Bash(holi google trash:*)',
      'Bash(holi google unschedule:*)',
    ],
  },
  hooks: [
    // Injects the focused note's path into each prompt.
    { event: 'UserPromptSubmit', script: 'user-prompt-submit' },
    // The turn bracket: tells Holi a turn started or ended so it can pause
    // sync while the agent works. The script finds Holi through the vault's
    // `bridge.local.env` and names the session by its job id, because a
    // background session's environment is Claude Code's supervisor's, not
    // Holi's. A silent no-op outside Holi. Hook commands are not the agent's
    // Bash tool, so `permissions.ask` does not gate them.
    { event: 'UserPromptSubmit', script: 'turn-signal', args: ['start'] },
    { event: 'Stop', script: 'turn-signal', args: ['end'] },
    // What this vault remembers, once per session. Fires on startup, resume
    // AND compact: after a compact the agent has just forgotten it has
    // memory at all.
    { event: 'SessionStart', script: 'memory-overview' },
    // Where the session takes messages, as soon as it runs: Holi can then add
    // one to a session that has not had a turn yet. The turn's start says it
    // again, which covers a script older than this entry.
    { event: 'SessionStart', script: 'turn-signal', args: ['session'] },
    // `.holi/memory/index.md` is regenerated on every commit, so an edit to it is
    // always lost. Refused up front, with the reason.
    { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit', script: 'memory-index-guard' },
  ],
  permissions: {
    // Network egress: the user still approves each one, it just does not
    // slip through unasked. The automations plugin adds its own rules.
    ask: ['Bash(curl:*)', 'Bash(wget:*)'],
    // The memory lint, `holi comments list` and `holi agent version` only
    // read, so they run unasked.
    // `holi agent notify` is an inbox entry, a banner and a log line on this
    // machine, `holi agent log` the line alone. Asking first would stop an
    // unattended run at a prompt nobody sees, which is the opposite of telling
    // them. Writing a comment asks, since teammates see it.
    allow: [
      'Bash(node .claude/skills/memory/lint.mjs:*)',
      'Bash(holi agent notify:*)',
      'Bash(holi agent log:*)',
      'Bash(holi agent version:*)',
      'Bash(holi comments list:*)',
    ],
    // Claude Code tools with no job in a vault: notebooks, plan mode,
    // worktrees (one working tree is what sync assumes), code-review
    // reporting, and SendFeedback, which reaches Anthropic rather than Holi
    // (the holi-feedback skill is the route to Holi). A deny outranks an
    // allow in every scope, so a vault that wants one back removes it here.
    deny: [
      'NotebookEdit',
      'EnterPlanMode',
      'ExitPlanMode',
      'EnterWorktree',
      'ExitWorktree',
      'ReportFindings',
      'SendFeedback',
      'EndConversation',
    ],
  },
}

/** The agent's `settings.json` for what is on disk, given every
 *  contribution's fragments and which hook scripts the vault has.
 * @public exported for its test
 */
export const agentSettings = (
  existing: string | null,
  fragments: readonly SettingsFragment[],
  has: (rel: string) => boolean,
  read?: (rel: string) => string | null,
): string | null => {
  let migrated = existing
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as { statusLine?: unknown }).statusLine !== null &&
        typeof (parsed as { statusLine?: unknown }).statusLine === 'object'
      ) {
        const statusLine = (parsed as { statusLine: { type?: unknown; command?: unknown } })
          .statusLine
        if (statusLine.type === 'command' && statusLine.command === LEGACY_STATUS_LINE) {
          statusLine.command = STATUS_LINE
          migrated = JSON.stringify(parsed)
        }
      }
    } catch {
      // Keep malformed settings untouched; Claude Code owns their interpretation.
    }
  }
  return mergeClaudeSettings(migrated, SETTINGS_BASE, fragments, has, read)
}

export const claudeSeed: SeedContribution = {
  id: 'agent',
  owns: ['.claude/'],
  once: folder.once,
  shipped: folder.shipped,
  fragments: { [SETTINGS]: [AGENT_SETTINGS] },
  merge: {
    [SETTINGS]: async (existing, fragments, has, read) => {
      const all = fragments as SettingsFragment[]
      const present = new Set<string>()
      for (const hook of all.flatMap((f) => f.hooks ?? [])) {
        if ('script' in hook && (await has(hookScript(hook.script)))) {
          present.add(hookScript(hook.script))
        }
      }
      const replacements = new Map<string, string | null>()
      for (const hooks of all.flatMap((f) => f.retired?.hooks ?? [])) {
        replacements.set(hooks.replacedBy, await read(hooks.replacedBy))
      }
      return agentSettings(
        existing,
        all,
        (rel) => present.has(rel),
        (rel) => replacements.get(rel) ?? null,
      )
    },
  },
}
