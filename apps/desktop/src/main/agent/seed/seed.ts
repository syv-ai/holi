/**
 * What the agent seeds into a vault: its hooks and skills (`vault/shipped/`
 * beside this module) and the `.claude/settings.json` it owns and merges
 * (`claude-settings.ts`).
 *
 * The Google, vault-apps and tasks hooks, skills and settings ride here too
 * for now, each as its own fragment, until each becomes its own plugin.
 */
import { shellReadBridgeEnv } from '../../bridge/env-file'
import { seedFolder } from '../../vault/seed/folder'
import type { SeedContribution } from '../../vault/seed/types'
import { hookScript, mergeClaudeSettings, type SettingsFragment } from './claude-settings'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

export const SETTINGS = '.claude/settings.json'

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
export const STATUS_LINE = [
  'input=$(cat)',
  `printf '%s' "$input" | jq -j '[.model.display_name, (.context_window.used_percentage // empty | round | tostring + "% context")] | map(select(. != null and . != "")) | join(" · ")'`,
  `if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then ${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('; ')}; if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$input" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/statusline?t=$HOLI_BRIDGE_TOKEN&job=\${CLAUDE_JOB_DIR##*/}" >/dev/null 2>&1 & fi; fi`,
  'true',
].join('; ')

/** Claude Code's bundled skills a vault agent has no use for: code review,
 *  app launching, API and workflow authoring, Claude Code configuration, and
 *  importing another assistant's memory (a vault's memory is `memory/`). */
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
   * that door so `memory/` is the one place to look.
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
    // `memory/index.md` is regenerated on every commit, so an edit to it is
    // always lost. Refused up front, with the reason.
    { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit', script: 'memory-index-guard' },
  ],
  permissions: {
    // Network egress: the user still approves each one, it just does not
    // slip through unasked.
    ask: ['Bash(curl:*)', 'Bash(wget:*)'],
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

/**
 * Google: the send gate, and the undoable writes asked about.
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
 * send and reply rules here cover a vault whose hook file was removed.
 */
const GOOGLE_SETTINGS: SettingsFragment = {
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

/**
 * Vault apps: the validator, advisory only (it reports and exits 0), so the
 * agent gets feedback instead of a syntax error surfacing as a blank tab.
 * Matched on the writing tools rather than on the path, because the matcher
 * grammar cannot see a path; the hook returns at once outside a `<name>.app/`.
 */
const APPS_SETTINGS: SettingsFragment = {
  hooks: [{ event: 'PostToolUse', matcher: 'Write|Edit|MultiEdit', script: 'vault-app-check' }],
}

/** Tasks: Claude Code's todo tools, whose "tasks" are not the vault's
 *  `task.*.md`. TaskStop stays: it stops background shells. */
const TASKS_SETTINGS: SettingsFragment = {
  permissions: { deny: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'] },
}

/** The agent's `settings.json` for what is on disk, given every
 *  contribution's fragments and which hook scripts the vault has. */
export const agentSettings = (
  existing: string | null,
  fragments: readonly SettingsFragment[],
  has: (rel: string) => boolean,
): string | null => mergeClaudeSettings(existing, SETTINGS_BASE, fragments, has)

export const agentSeed: SeedContribution = {
  id: 'agent',
  once: folder.once,
  shipped: folder.shipped,
  fragments: { [SETTINGS]: [AGENT_SETTINGS, GOOGLE_SETTINGS, APPS_SETTINGS, TASKS_SETTINGS] },
  merge: {
    [SETTINGS]: async (existing, fragments, has) => {
      const all = fragments as SettingsFragment[]
      const present = new Set<string>()
      for (const hook of all.flatMap((f) => f.hooks ?? [])) {
        if (await has(hookScript(hook.script))) present.add(hookScript(hook.script))
      }
      return agentSettings(existing, all, (rel) => present.has(rel))
    },
  },
}
