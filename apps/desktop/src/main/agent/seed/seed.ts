/**
 * What the agent seeds into a vault: its hooks and skills (`vault/shipped/`
 * beside this module) and the `.claude/settings.json` it owns and merges.
 *
 * The Google, vault-apps and tasks hooks and skills ride here too for now, as
 * separate pieces, until each becomes its own plugin.
 */
import { shellReadBridgeEnv } from '../../bridge/env-file'
import { seedFolder } from '../../vault/seed/folder'
import type { SeedContribution } from '../../vault/seed/types'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

const hookCommand = (name: string) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.mjs"`

/**
 * A turn-bracket hook: tells Holi a turn started or ended so it can pause
 * sync while the agent works. The script finds Holi through the vault's
 * `bridge.local.env` and names the session by its job id, because a
 * background session's environment is Claude Code's supervisor's, not Holi's.
 * It is a silent no-op outside Holi. Hook commands are not the agent's Bash
 * tool, so `permissions.ask` does not gate it.
 */
const turnHook = (edge: 'start' | 'end') => `${hookCommand('turn-signal')} ${edge}`

/** What the turn hooks this vault used to carry look like: an inline `curl`
 *  on the per-session environment, which a background session never has. */
const isOldTurnHook = (command: string): boolean =>
  command.includes('/turn/start') || command.includes('/turn/end')

/**
 * The status line: one inline command, as Claude Code's own docs show, so a
 * vault needs no script for it and every vault gets it on its next open.
 *
 * `jq` prints the footer (`Opus 5.5 · 42% context`, the model alone before the
 * first message); it ships with macOS. Inside a Holi background session the
 * same JSON goes to the bridge, found through the vault's `bridge.local.env`
 * (parsed, never sourced) and keyed by the job id, the way `turn-signal.mjs`
 * does it. The post is detached with its
 * output discarded, so a slow or absent Holi never holds up the footer, and
 * outside Holi the command only prints.
 */
export const STATUS_LINE = [
  'input=$(cat)',
  `printf '%s' "$input" | jq -j '[.model.display_name, (.context_window.used_percentage // empty | round | tostring + "% context")] | map(select(. != null and . != "")) | join(" · ")'`,
  `if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then ${shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('; ')}; if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then printf '%s' "$input" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$HOLI_BRIDGE_PORT/statusline?t=$HOLI_BRIDGE_TOKEN&job=\${CLAUDE_JOB_DIR##*/}" >/dev/null 2>&1 & fi; fi`,
  'true',
].join('; ')

/** A status line Holi wrote: this one, or the script an earlier release
 *  shipped. Anything else is the vault's own. */
const isHolisStatusLine = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object') return false
  const command = (value as Record<string, unknown>).command
  return (
    typeof command === 'string' && (command === STATUS_LINE || command.includes('status-line.mjs'))
  )
}

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

const SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        // UserPromptSubmit injects the focused-note context AND signals turn
        // start; Stop signals turn end. That bracket already spans all tool use,
        // so PreToolUse is only for gating send, below.
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: hookCommand('user-prompt-submit') },
              { type: 'command', command: turnHook('start') },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: turnHook('end') }] }],
        // What this vault remembers, once per session. Fires on startup,
        // resume AND compact: after a compact the agent has just forgotten it
        // has memory at all.
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('memory-overview') }] }],
        // The vault-app validator. Advisory only (it reports and exits 0), so
        // the agent gets feedback instead of a syntax error surfacing as a
        // blank tab.
        //
        // Matched on the writing tools rather than on the path, because the
        // matcher grammar cannot see a path; the hook returns immediately for
        // anything outside a `<name>.app/` bundle.
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: hookCommand('vault-app-check') }],
          },
        ],
        // The send gate. It matches Bash broadly and decides for itself,
        // rather than relying on an `if` condition: the agent can spell the
        // command three ways, and a condition that misses one fails OPEN while
        // still reading like protection. The hook defers on everything it does
        // not recognise, so the cost of matching broadly is one child process
        // per Bash call.
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand('google-send-gate') }],
          },
          // The same gate, over Gmail's *MCP* tools. A `Bash` matcher sees only
          // Bash, and the agent will reach for a claude.ai Gmail connector
          // instead of `holi-google` when one is available.
          // `disableClaudeAiConnectors` below is the real fix; this covers a
          // vault whose user re-enables the connector.
          {
            matcher: 'mcp__.*[Gg]mail.*',
            hooks: [{ type: 'command', command: hookCommand('google-send-gate') }],
          },
          // `memory/index.md` is regenerated on every commit, so an edit to it
          // is always lost. Refused up front, with the reason.
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: hookCommand('memory-index-guard') }],
          },
        ],
      },
      /**
       * No claude.ai cloud connectors in a vault.
       *
       * A claude.ai **Gmail** connector routes around every guarantee Holi
       * makes about mail: main is the sole token authority, the send gate
       * is a hook on `Bash`, and the cache is patched by Holi's own writes.
       * None of those apply to a tool Holi never sees.
       *
       * Settable in any scope, and `true` in *any* source wins, so this checked-in
       * project file opts the vault out and a user-level `false` cannot undo it.
       * It does **not** touch skills or plugins inherited from `~/.claude` —
       * project settings cannot reach those, and that is a separate decision.
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
       * next-prompt suggestion in the input. Defaults only, merged when absent,
       * so a vault that wants either back sets it `true` here (or in
       * `settings.local.json` for one machine). Not `/config`: it writes user
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
      permissions: {
        // Seeded egress gating: the user still approves each one, they just
        // don't slip through unasked.
        //
        // The holi-google entries are the *undoable* tier and are NOT the
        // wall: allow-always past them is fine, each has a one-click undo. The
        // wall for send/reply is the PreToolUse hook above, which overrides both
        // this list and a prior "don't ask again". The send/reply entries here
        // cover a vault whose hook file was removed.
        ask: [
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(holi-google archive:*)',
          'Bash(holi-google trash:*)',
          'Bash(holi-google unschedule:*)',
          'Bash(holi-google send:*)',
          'Bash(holi-google reply:*)',
        ],
        // Read-only Holi commands, which ask nothing because they change
        // nothing. Merged into existing vaults like `ask` is.
        allow: ['Bash(holi pdf comments:*)'],
        // Claude Code tools with no job in a vault: notebooks, plan mode,
        // worktrees (one working tree is what sync assumes), code-review
        // reporting, SendFeedback, which reaches Anthropic rather than Holi
        // (the holi-feedback skill is the route to Holi), and the todo tools,
        // whose "tasks" are not the vault's `task.*.md`. TaskStop stays: it
        // stops background shells. Merged like `ask`. A deny outranks an allow
        // in every scope, so a vault that wants one back removes it here.
        deny: [
          'NotebookEdit',
          'EnterPlanMode',
          'ExitPlanMode',
          'EnterWorktree',
          'ExitWorktree',
          'ReportFindings',
          'SendFeedback',
          'EndConversation',
          'TaskCreate',
          'TaskGet',
          'TaskList',
          'TaskUpdate',
        ],
      },
      /**
       * Claude Code's bundled skills that are about working on code, off. Each
       * is merged only when the vault has no entry for it, so a vault that sets
       * one back to `"on"` keeps it.
       */
      skillOverrides: Object.fromEntries(OFF_SKILLS.map((name) => [name, 'off'])),
    },
    null,
    2,
  ) + '\n'

export const SETTINGS = '.claude/settings.json'

/**
 * The `.claude/settings.json` this vault should have, or **null** if it already
 * carries everything Holi requires (or cannot be parsed).
 *
 * **Merged rather than skipped, and that is a security property.** Most vaults
 * already have a `settings.json`, so write-if-absent would ship the send gate
 * as a hook script nothing invokes.
 *
 * Key-wise, the way `.gitignore` is line-wise: an adopted vault's own hooks and
 * permission rules are not ours to replace. Holi adds what it needs and touches
 * nothing else.
 *
 * A malformed file returns `null`: it is the user's, and unparseable JSON is not
 * something to "fix" by overwriting. The cost is an ungated vault.
 *
 * **A hook's entry goes in only where its script is** (`hasHook`, by script
 * name). Scripts are seeded at creation and updated on request, so a
 * hook a later release adds must not be wired on an open, before the update
 * that brings its script: it would fail on every prompt. `updateShipped` runs
 * this again after writing scripts, so the two arrive together.
 */
export function settingsWithRequired(
  existing: string | null,
  hasHook: (name: string) => boolean = () => true,
): string | null {
  if (existing === null || existing.trim() === '') return SETTINGS_JSON

  let settings: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(existing)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    settings = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const required = JSON.parse(SETTINGS_JSON) as {
    hooks: { PreToolUse: unknown[]; PostToolUse: unknown[]; SessionStart: unknown[] }
    worktree: { bgIsolation: string }
    permissions: { ask: string[]; allow: string[]; deny: string[] }
    skillOverrides: Record<string, string>
    disableClaudeAiConnectors: boolean
    autoMemoryEnabled: boolean
    awaySummaryEnabled: boolean
    statusLine: { type: string; command: string }
    promptSuggestionEnabled: boolean
  }
  let changed = false

  /**
   * No claude.ai cloud connectors. Merged as well as seeded, because **a seed
   * that only runs at creation is a migration that never happens**.
   *
   * Only when absent: a user who deliberately set it `false` is not overruled
   * on every open.
   */
  if (settings.disableClaudeAiConnectors === undefined) {
    settings.disableClaudeAiConnectors = required.disableClaudeAiConnectors
    changed = true
  }

  /**
   * One memory surface, merged for `disableClaudeAiConnectors`'s reason.
   *
   * **Only when absent.** A user who set it `true` wants Claude Code's own
   * auto-memory as well; the vault's `memory/` works either way.
   */
  if (settings.autoMemoryEnabled === undefined) {
    settings.autoMemoryEnabled = required.autoMemoryEnabled
    changed = true
  }

  /** Recap and prompt suggestions off, for the same reason and only when
   *  absent: `true` is a vault that wants them back. */
  for (const key of ['awaySummaryEnabled', 'promptSuggestionEnabled'] as const) {
    if (settings[key] === undefined) {
      settings[key] = required[key]
      changed = true
    }
  }

  // The gate. Matched by the script it runs rather than by deep-equality, so a
  // user who reordered or annotated the entry does not get a duplicate.
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const hasGate = JSON.stringify(preToolUse).includes('google-send-gate')
  if (!hasGate && hasHook('google-send-gate')) {
    hooks.PreToolUse = [
      ...preToolUse,
      ...required.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('google-send-gate')),
    ]
    settings.hooks = hooks
    changed = true
  }

  // The memory index guard, merged and matched the same way.
  if (
    !JSON.stringify(hooks.PreToolUse ?? []).includes('memory-index-guard') &&
    hasHook('memory-index-guard')
  ) {
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      ...required.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('memory-index-guard')),
    ]
    settings.hooks = hooks
    changed = true
  }

  // The vault-app validator, merged and matched the same way as the gate.
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []
  if (!JSON.stringify(postToolUse).includes('vault-app-check') && hasHook('vault-app-check')) {
    hooks.PostToolUse = [...postToolUse, ...required.hooks.PostToolUse]
    settings.hooks = hooks
    changed = true
  }

  // The session overview, matched the same way.
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []
  if (!JSON.stringify(sessionStart).includes('memory-overview') && hasHook('memory-overview')) {
    hooks.SessionStart = [...sessionStart, ...required.hooks.SessionStart]
    settings.hooks = hooks
    changed = true
  }

  /**
   * The turn bracket, which pauses sync while the agent works.
   *
   * **This is what reaches existing vaults.** Until now the bracket was only
   * seeded, never merged, so a vault that already had a `settings.json` never
   * got it. The old inline `curl` entries read a per-session environment a
   * background session never has, so they are removed rather than left to fail
   * quietly beside the new ones. A user's own hooks on these events stay.
   */
  for (const [event, edge] of [
    ['UserPromptSubmit', 'start'],
    ['Stop', 'end'],
  ] as const) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = withoutOldTurnHooks(entries)
    const hasSignal = JSON.stringify(kept).includes('turn-signal.mjs')
    const add = !hasSignal && hasHook('turn-signal')
    if (JSON.stringify(kept) !== JSON.stringify(entries) || add) {
      hooks[event] = add
        ? [...kept, { hooks: [{ type: 'command', command: turnHook(edge) }] }]
        : kept
      settings.hooks = hooks
      changed = true
    }
  }

  /** Written when absent or when it is Holi's and differs, so an earlier
   *  release's is replaced and a vault's own footer stays. */
  const statusLine = settings.statusLine
  if (
    (statusLine === undefined || isHolisStatusLine(statusLine)) &&
    JSON.stringify(statusLine) !== JSON.stringify(required.statusLine)
  ) {
    settings.statusLine = required.statusLine
    changed = true
  }

  /** Only when absent: a user who chose isolation keeps it, and loses Holi's
   *  view of that session's edits until it merges. */
  const worktree = (settings.worktree ?? {}) as Record<string, unknown>
  if (worktree.bgIsolation === undefined) {
    worktree.bgIsolation = required.worktree.bgIsolation
    settings.worktree = worktree
    changed = true
  }

  // The permission rules, added to whatever the user already asks about.
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>
  const ask = Array.isArray(permissions.ask) ? (permissions.ask as string[]) : []
  const missing = required.permissions.ask.filter((rule) => !ask.includes(rule))
  if (missing.length > 0) {
    permissions.ask = [...ask, ...missing]
    settings.permissions = permissions
    changed = true
  }

  // And the read-only commands that need no prompt.
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : []
  const missingAllow = required.permissions.allow.filter((rule) => !allow.includes(rule))
  if (missingAllow.length > 0) {
    permissions.allow = [...allow, ...missingAllow]
    settings.permissions = permissions
    changed = true
  }

  // And the tools a vault has no use for.
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : []
  const missingDeny = required.permissions.deny.filter((rule) => !deny.includes(rule))
  if (missingDeny.length > 0) {
    permissions.deny = [...deny, ...missingDeny]
    settings.permissions = permissions
    changed = true
  }

  // The skills that are off, one key at a time: a skill the vault turned back
  // on keeps its entry.
  const overrides =
    settings.skillOverrides !== null &&
    typeof settings.skillOverrides === 'object' &&
    !Array.isArray(settings.skillOverrides)
      ? (settings.skillOverrides as Record<string, unknown>)
      : {}
  const missingOverrides = Object.keys(required.skillOverrides).filter(
    (name) => overrides[name] === undefined,
  )
  if (missingOverrides.length > 0) {
    for (const name of missingOverrides) overrides[name] = required.skillOverrides[name]
    settings.skillOverrides = overrides
    changed = true
  }

  return changed ? JSON.stringify(settings, null, 2) + '\n' : null
}

/**
 * One hook event's entries with the old inline turn `curl` taken out. An entry
 * left with no hooks goes too; everything else, including an entry that shares
 * the old command with the user's own hook, keeps its other hooks.
 */
function withoutOldTurnHooks(entries: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !Array.isArray((entry as { hooks?: unknown }).hooks)
    ) {
      out.push(entry)
      continue
    }
    const inner = (entry as { hooks: unknown[] }).hooks
    const keptHooks = inner.filter((h) => {
      const command = (h as { command?: unknown } | null)?.command
      return typeof command !== 'string' || !isOldTurnHook(command)
    })
    if (keptHooks.length === inner.length) out.push(entry)
    else if (keptHooks.length > 0) out.push({ ...(entry as object), hooks: keptHooks })
  }
  return out
}

const HOOKS_DIR = '.claude/hooks/'

export const agentSeed: SeedContribution = {
  id: 'agent',
  once: folder.once,
  shipped: folder.shipped,
  merge: {
    [SETTINGS]: async (existing, has) => {
      const present = new Set<string>()
      for (const rel of Object.keys(folder.shipped)) {
        if (rel.startsWith(HOOKS_DIR) && (await has(rel))) {
          present.add(rel.slice(HOOKS_DIR.length).replace(/\.mjs$/, ''))
        }
      }
      return settingsWithRequired(existing, (name) => present.has(name))
    },
  },
}
