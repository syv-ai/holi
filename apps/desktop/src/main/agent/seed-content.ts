/**
 * The files every vault carries: the `.gitignore` that keeps private
 * files private, the shared agent instructions (`AGENTS.md`, which Claude Code
 * reads natively, so there is no `CLAUDE.md`), and the per-turn context hook.
 *
 * **Seeding runs on vault creation, adoption AND every open** (`vaults.add`/
 * `vaults.create`/`vaults.open` → `ensureSeeded`), but
 * what it may do on an open is narrow. Holi's skills and hooks
 * (`SHIPPED_FILES`) are written only when the vault is created: after that they
 * are the vault's, and a newer version reaches them only through
 * `holi skills update`.
 *
 * **`.gitignore` is the exception.** An adopted repo usually already has one,
 * and the sync engine commits with `git add -A`, so create-if-missing would let
 * the first commit carry a `*.local.*` file to every collaborator. Its lines are
 * appended individually, from `LOCAL_ONLY_IGNORE_LINES`, so the ignore file and
 * the vault store's notion of "machine-local" cannot drift apart.
 *
 * `USER.local.md` is deliberately NOT seeded: it is machine-local (its name says
 * so), and the agent creates it when it first learns something about the user.
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyThemePatch,
  ICONS_FILE,
  LOCAL_ONLY_IGNORE_LINES,
  merge3,
  MEMORY_INDEX,
  MEMORY_INDEX_EMPTY,
  seedSettings,
  seedSettingsText,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  THEME_FILE,
  THEME_LOCAL_FILE,
  vaultRelPath,
  VAULT_MARKER_FILE,
} from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'
import { readSeedState, recordSeeded, untouched } from './seed-state'
import userPromptSubmitHook from './hooks/user-prompt-submit.mjs?raw'
import googleSendGateHook from './hooks/google-send-gate.mjs?raw'
import vaultAppCheckHook from './hooks/vault-app-check.mjs?raw'
import memoryOverviewHook from './hooks/memory-overview.mjs?raw'
import memoryIndexGuardHook from './hooks/memory-index-guard.mjs?raw'
import turnSignalHook from './hooks/turn-signal.mjs?raw'
import mdToPdfSkill from './skills/md-to-pdf/SKILL.md?raw'
import themeSkill from './skills/theme/SKILL.md?raw'
import gmailCalendarSkill from './skills/gmail-calendar/SKILL.md?raw'
import vaultAppsSkill from './skills/vault-apps/SKILL.md?raw'
import usingTasksSkill from './skills/using-tasks/SKILL.md?raw'
import memorySkill from './skills/memory/SKILL.md?raw'
import pdfCommentsSkill from './skills/pdf-comments/SKILL.md?raw'
import holiFeedbackSkill from './skills/holi-feedback/SKILL.md?raw'
import { BRAND_BINARIES } from './templates/_brand/binary-assets.generated'
import brandTyp from './templates/_brand/brand.typ?raw'
import figuresTyp from './templates/_brand/figures.typ?raw'
import contractManifest from './templates/contract/template.json?raw'
import contractTyp from './templates/contract/template.typ?raw'
import letterManifest from './templates/letter/template.json?raw'
import letterTyp from './templates/letter/template.typ?raw'
import memoManifest from './templates/memo/template.json?raw'
import memoTyp from './templates/memo/template.typ?raw'
import plainTemplateTyp from './templates/plain/template.typ?raw'
import proposalManifest from './templates/proposal/template.json?raw'
import proposalTyp from './templates/proposal/template.typ?raw'
import reportManifest from './templates/report/template.json?raw'
import reportTyp from './templates/report/template.typ?raw'

const AGENTS_MD = `# Agent rules

You are the assistant for a Holi vault: a private GitHub repo of files, mostly markdown. Images, PDFs and anything else are ordinary committed files. Links between files are path-based wiki-links: \`[[projects/q2/roadmap.md]]\`.

Holi, the app around this vault, is open source: https://github.com/syv-ai/holi. Its \`docs/\` say how Holi works. Feedback for the Holi team goes there as an issue, with the holi-feedback skill.

## Tasks

A task (a TODO in the vault) is a file named \`task.<slug>.md\`, in the folder it belongs to. Find them with \`**/task.*.md\`. Use the using-tasks skill to read or write one.

## Files

- Moving a file: links to it are rewritten on commit when git sees the rename. If you moved it another way, fix the links manually.
- A \`.local.\` in a filename keeps the file on this machine (gitignored). Anything personal goes in one.

## Sync

Holi commits every few seconds and pushes and pulls on its own. It pauses that loop for the length of your turn, so run git freely, merges included. It stays paused while you are off the default branch or mid-rebase.

## Memory

A memory is one fact in one file under \`memory/\`. Do not use a memory system of your own. Write one, with the memory skill, whenever you learn something this vault or its user will want again. \`memory/<name>.local.md\` stays on this machine, so personal facts go there. \`memory/index.md\` is generated on commit, and edits to it are discarded.
`

const hookCommand = (name: string) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.mjs"`

/**
 * A turn-bracket hook: tells Holi a turn started or ended so it can pause
 * sync while the agent works. The script finds Holi through `holi.env` in the
 * session's config dir and names the session by its job id, because a
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
 * same JSON goes to the hook server, found through `holi.env` and keyed by the
 * job id, the way `turn-signal.mjs` does it. The post is detached with its
 * output discarded, so a slow or absent Holi never holds up the footer, and
 * outside Holi the command only prints.
 */
const STATUS_LINE = [
  'input=$(cat)',
  `printf '%s' "$input" | jq -j '[.model.display_name, (.context_window.used_percentage // empty | round | tostring + "% context")] | map(select(. != null and . != "")) | join(" · ")'`,
  `if [ -n "\${CLAUDE_JOB_DIR:-}" ] && [ -f "\${CLAUDE_CONFIG_DIR:-}/holi.env" ]; then . "$CLAUDE_CONFIG_DIR/holi.env"; printf '%s' "$input" | curl -s -m 2 -o /dev/null -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:\${HOLI_HOOK_PORT:-0}/statusline?t=\${HOLI_HOOK_TOKEN:-}&job=\${CLAUDE_JOB_DIR##*/}" >/dev/null 2>&1 & fi`,
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
        // reporting, and SendFeedback, which reaches Anthropic rather than
        // Holi (the holi-feedback skill is the route to Holi). Merged like
        // `ask`. A deny outranks an allow in every scope, so a vault that
        // wants one back removes it here.
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

/**
 * The vault's own settings, seeded once and then the user's.
 *
 * Built from `VAULT_SETTING_DESCRIPTORS`, the same list that drives the
 * onboarding questions, so the two cannot drift apart.
 *
 * The `hooks` block says **which** pre-commit transforms run, and can never say
 * what one is: the script body ships in the binary and lives in
 * `.git/hooks/`, where nothing can push it onto anyone's laptop.
 *
 * `archive-done` is off because it moves task files, which changes what the
 * board shows; a transform that rearranges someone's work is opt-in.
 */
const HOLI_SETTINGS = seedSettingsText(seedSettings('committed'), 'committed')

/**
 * The machine-local half, such as which appearance this machine follows.
 * Gitignored by the seeded `*.local.*` rule, like `theme.local.css`.
 */
const HOLI_SETTINGS_LOCAL = seedSettingsText(seedSettings('local'), 'local')

/** One line: the vault format version. Not JSON, because nothing ever parsed
 *  it — `isVaultClone` asks only whether the file can be read. See
 *  `VAULT_MARKER_FILE` for why an extensionless flag rather than a document. */
const VAULT_MARKER = '1\n'

/** The Plain template's manifest: an unbranded layout with two optional fields
 * (Date, Recipient) that the Convert dialog renders as inputs and template.typ
 * prints as a small header. */
const PLAIN_MANIFEST =
  JSON.stringify(
    {
      name: 'Plain',
      description: 'A clean, unbranded document layout.',
      fields: [
        { key: 'date', label: 'Date', type: 'date', required: false },
        { key: 'recipient', label: 'Recipient', type: 'text', required: false },
      ],
    },
    null,
    2,
  ) + '\n'

/**
 * The vault's colour/chrome theme. Both files ship in every vault so
 * theming is discoverable: shared overrides go in `theme.css` (committed),
 * personal ones in `theme.local.css` (gitignored).
 *
 * **Seeded with the whole token vocabulary commented out, not empty**, so the
 * file itself names what can be set.
 */
const THEME_SKELETON = applyThemePatch(null, {})

/**
 * Holi's skills and hooks. **The vault's from the moment they are
 * written**, and written only when the vault is created: a vault works in any
 * Claude Code (the desktop app, the web, a plain CLI), so these are ordinary
 * committed files, and nothing Holi does on an open changes them.
 *
 * A Holi release may ship newer versions. They reach a vault only when its
 * user runs `holi skills update` (`updateShipped`), which replaces a file the
 * vault never touched, 3-way merges one it did, and hands a conflict to an
 * agent session.
 *
 * **Holi's side of a hook must stay backward-compatible.** A vault can run a
 * hook script from any earlier release indefinitely, so the hook server and
 * the endpoint file answer every older script, not only the one shipped now.
 */
export const SHIPPED_FILES: Record<string, string> = {
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
  '.claude/hooks/google-send-gate.mjs': googleSendGateHook,
  '.claude/hooks/vault-app-check.mjs': vaultAppCheckHook,
  '.claude/hooks/memory-overview.mjs': memoryOverviewHook,
  '.claude/hooks/memory-index-guard.mjs': memoryIndexGuardHook,
  '.claude/hooks/turn-signal.mjs': turnSignalHook,
  '.claude/skills/md-to-pdf/SKILL.md': mdToPdfSkill,
  '.claude/skills/theme/SKILL.md': themeSkill,
  '.claude/skills/gmail-calendar/SKILL.md': gmailCalendarSkill,
  '.claude/skills/vault-apps/SKILL.md': vaultAppsSkill,
  '.claude/skills/using-tasks/SKILL.md': usingTasksSkill,
  /**
   * How to write a memory.
   *
   * **A skill rather than more `AGENTS.md` prose**: a skill can be improved
   * later through `holi skills update`, and `AGENTS.md` cannot.
   */
  '.claude/skills/memory/SKILL.md': memorySkill,
  /** `holi pdf comments`: what it prints, and that it only reads. */
  '.claude/skills/pdf-comments/SKILL.md': pdfCommentsSkill,
  /** Feedback for the Holi team, as a GitHub issue. Also where an existing
   *  vault learns Holi's repo URL, which its frozen `AGENTS.md` does not say. */
  '.claude/skills/holi-feedback/SKILL.md': holiFeedbackSkill,
}

/**
 * The icons file: path to emoji, for things that cannot carry an icon in their
 * own frontmatter (folders, non-markdown files, agent-surface files where
 * frontmatter would become prompt text). Seeded empty so it is discoverable.
 */
const ICONS_SKELETON = '{}\n'

/**
 * **The user's the moment they exist.** Create-if-missing, forever: a hash
 * match is not permission to rewrite one of these, because `AGENTS.md` seeded
 * with our words is still the file the user was handed to write in.
 *
 * `.claude/settings.json` sits here but keeps its own third rule: it is MERGED
 * key-wise (see `settingsWithRequired`), because a seed that only runs at
 * creation is a migration that never happens.
 */
export const ONCE_FILES: Record<string, string> = {
  [VAULT_MARKER_FILE]: VAULT_MARKER,
  [SETTINGS_FILE]: HOLI_SETTINGS,
  '.holi/document-templates/plain/template.json': PLAIN_MANIFEST,
  '.holi/document-templates/plain/template.typ': plainTemplateTyp,
  // The branded set and its shared brand foundation. `_brand/` is skipped
  // by the template picker (underscore prefix); its binary fonts + logo are
  // seeded separately from BRAND_BINARIES below.
  '.holi/document-templates/_brand/brand.typ': brandTyp,
  '.holi/document-templates/_brand/figures.typ': figuresTyp,
  '.holi/document-templates/proposal/template.json': proposalManifest,
  '.holi/document-templates/proposal/template.typ': proposalTyp,
  '.holi/document-templates/report/template.json': reportManifest,
  '.holi/document-templates/report/template.typ': reportTyp,
  '.holi/document-templates/letter/template.json': letterManifest,
  '.holi/document-templates/letter/template.typ': letterTyp,
  '.holi/document-templates/memo/template.json': memoManifest,
  '.holi/document-templates/memo/template.typ': memoTyp,
  '.holi/document-templates/contract/template.json': contractManifest,
  '.holi/document-templates/contract/template.typ': contractTyp,
  [THEME_FILE]: THEME_SKELETON,
  [ICONS_FILE]: ICONS_SKELETON,
  // Seeded but gitignored (`*.local.*`) — the machine-local files, so the
  // personal-override slot exists by default. The `.gitignore` is written first
  // in `ensureSeeded`, so these are ignored before they land.
  [THEME_LOCAL_FILE]: THEME_SKELETON,
  [SETTINGS_LOCAL_FILE]: HOLI_SETTINGS_LOCAL,
  'AGENTS.md': AGENTS_MD,
  /**
   * The memory directory exists and is tracked from a vault's first commit,
   * in its empty-state form; after that the `memory-index` transform
   * owns the file.
   *
   * A ONCE_FILE and emphatically not a MANAGED_FILE: the transform rewrites it
   * on every commit that touches a memory, so a managed refresh on every open
   * would fight it.
   *
   * A vault's existing `MEMORY.md` is user content and is never moved
   * automatically; the session overview offers to split it when asked.
   */
  [MEMORY_INDEX]: MEMORY_INDEX_EMPTY,
  '.claude/settings.json': SETTINGS_JSON,
}

/** Both classes together, for callers that only ask "is this a file Holi
 *  seeds?". */
export const SEED_FILES: Record<string, string> = { ...ONCE_FILES, ...SHIPPED_FILES }

export const GITIGNORE = '.gitignore'

/**
 * The `.gitignore` text this vault should have, or **null** if it already has
 * every line it needs.
 *
 * Line-wise rather than whole-file, because an adopted repo's existing ignores
 * are not ours to replace. A missing trailing newline is added first, or the
 * append would produce `node_modules*.local.*`, which ignores nothing.
 */
export function gitignoreWithLocalOnly(existing: string | null): string | null {
  const present = new Set((existing ?? '').split('\n').map((l) => l.trim()))
  const missing = LOCAL_ONLY_IGNORE_LINES.filter((line) => !present.has(line))
  if (missing.length === 0) return null

  if (existing === null || existing.trim() === '') {
    return `# Machine-local — never committed. Managed by Holi.\n${missing.join('\n')}\n`
  }
  const base = existing.endsWith('\n') ? existing : `${existing}\n`
  return `${base}\n# Machine-local — never committed. Managed by Holi.\n${missing.join('\n')}\n`
}

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

/** What one run of `ensureSeeded` wrote. */
export interface SeedResult {
  written: string[]
}

const HOOKS_DIR = '.claude/hooks/'

/** Which of Holi's hook scripts the vault has, by name (`turn-signal`). */
async function hooksPresent(root: string): Promise<(name: string) => boolean> {
  const present = new Set<string>()
  for (const rel of Object.keys(SHIPPED_FILES)) {
    if (!rel.startsWith(HOOKS_DIR)) continue
    if ((await readFile(join(root, rel), 'utf8').catch(() => null)) !== null) {
      present.add(rel.slice(HOOKS_DIR.length).replace(/\.mjs$/, ''))
    }
  }
  return (name) => present.has(name)
}

async function mergeSettings(root: string): Promise<boolean> {
  const onDisk = await readFile(join(root, SETTINGS), 'utf8').catch(() => null)
  const next = settingsWithRequired(onDisk, await hooksPresent(root))
  if (next === null) return false
  await writeAtomic(root, vaultRelPath(SETTINGS), next)
  return true
}

/**
 * Write what a vault must have. Idempotent, and run on creation, adoption and
 * every open. Four rules:
 *
 *   - **`.gitignore`** first and on its own: everything below it is a file that
 *     would be committed, and until it exists nothing stops `git add -A` from
 *     taking a machine-local file with it.
 *   - **once** (`ONCE_FILES`): created if absent, never touched again.
 *   - **shipped** (`SHIPPED_FILES`): written **only when the vault is being
 *     created**, told by `.holi/vault` not existing yet, and recorded so a
 *     later `holi skills update` has a base to merge against. An open
 *     never writes one, so a skill the vault deleted stays deleted.
 *   - **`.claude/settings.json`**: merged key-wise (`settingsWithRequired`).
 */
export async function ensureSeeded(root: string): Promise<SeedResult> {
  const result: SeedResult = { written: [] }

  const existing = await readFile(join(root, GITIGNORE), 'utf8').catch(() => null)
  const next = gitignoreWithLocalOnly(existing)
  if (next !== null) {
    await writeAtomic(root, vaultRelPath(GITIGNORE), next)
    result.written.push(GITIGNORE)
  }

  // Read before the once-files below write it.
  const creating = (await readFile(join(root, VAULT_MARKER_FILE)).catch(() => null)) === null

  for (const [rel, content] of Object.entries(ONCE_FILES)) {
    // `settings.json` is MERGED rather than skipped when present: see
    // `settingsWithRequired` and the block below.
    if (rel === SETTINGS) continue
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    result.written.push(rel)
  }

  if (creating) {
    for (const [rel, content] of Object.entries(SHIPPED_FILES)) {
      if ((await readFile(join(root, rel), 'utf8').catch(() => null)) !== null) continue
      await writeAtomic(root, vaultRelPath(rel), content)
      await recordSeeded(root, rel, content)
      result.written.push(rel)
    }
  }

  if (await mergeSettings(root)) result.written.push(SETTINGS)

  // Brand binaries (Raleway fonts + logo), base64 in a generated module. Same
  // if-absent rule as the once text seeds, via the bytes overload of writeAtomic.
  for (const [rel, b64] of Object.entries(BRAND_BINARIES)) {
    const onDisk = await readFile(join(root, rel)).catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(root, vaultRelPath(rel), Buffer.from(b64, 'base64'))
    result.written.push(rel)
  }
  return result
}

/** What `holi skills update` did, one list per outcome, by vault path. */
export interface UpdateReport {
  /** The vault never changed it: replaced with the shipped version. */
  updated: string[]
  /** Shipped, and new to this vault. */
  added: string[]
  /** Both changed it, in different places: both kept. */
  merged: string[]
  /** For an agent: both changed the same lines, or there is no base to merge
   *  from. The shipped version is staged beside it (`stagedPath`). */
  conflicts: string[]
  /** Nothing new to bring: already the shipped version, or the vault's own
   *  changes on top of it. */
  current: string[]
  /** The vault deleted it after Holi seeded it: left deleted. */
  deleted: string[]
}

/**
 * Where a conflict's other versions wait for the agent: beside the file, with
 * `.shipped.local` or `.base.local` before its extension. `.local.` keeps them
 * on this machine and out of every commit.
 */
export function stagedPath(rel: string, which: 'shipped' | 'base'): string {
  const slash = rel.lastIndexOf('/')
  const dot = rel.lastIndexOf('.')
  return dot > slash
    ? `${rel.slice(0, dot)}.${which}.local${rel.slice(dot)}`
    : `${rel}.${which}.local`
}

async function removeStaged(root: string, rel: string): Promise<void> {
  for (const which of ['shipped', 'base'] as const) {
    await unlink(join(root, stagedPath(rel, which))).catch(() => undefined)
  }
}

/**
 * `holi skills update`: bring this release's skills and hooks to the vault.
 * Per file, against the base Holi recorded when it wrote it:
 *
 *   - already the shipped text: current;
 *   - absent: added if Holi never wrote it here, left alone if the vault
 *     deleted it;
 *   - untouched since Holi wrote it: replaced;
 *   - changed, with the base's text: 3-way merged, kept when it merges clean;
 *   - otherwise a conflict, the file left as it is and the shipped version
 *     (and the base, when there is one) staged beside it for an agent.
 *
 * A conflict records the shipped version as the base, since the agent resolves
 * against it. Until the agent deletes what was staged, the file stays a
 * conflict: merging the vault's unresolved text against that new base would
 * quietly keep it and drop Holi's changes. Settings are merged again at the
 * end: a script this added is wired in the same run.
 */
export async function updateShipped(root: string): Promise<UpdateReport> {
  const report: UpdateReport = {
    updated: [],
    added: [],
    merged: [],
    conflicts: [],
    current: [],
    deleted: [],
  }
  const state = await readSeedState(root)

  for (const [rel, shipped] of Object.entries(SHIPPED_FILES)) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    const record = state[rel]
    let write: string | null = null
    // A conflict handed off earlier and not yet resolved: the agent deletes
    // what was staged when it is done.
    const pending =
      (await readFile(join(root, stagedPath(rel, 'shipped'))).catch(() => null)) !== null

    if (onDisk === shipped) report.current.push(rel)
    else if (pending && onDisk !== null) {
      // Still the agent's: refresh what it merges from, and nothing else. The
      // base it was given stays, and the record already names this release.
      await writeAtomic(root, vaultRelPath(stagedPath(rel, 'shipped')), shipped)
      await recordSeeded(root, rel, shipped)
      report.conflicts.push(rel)
      continue
    } else if (onDisk === null) {
      if (record !== undefined) report.deleted.push(rel)
      else {
        write = shipped
        report.added.push(rel)
      }
    } else if (untouched(record, onDisk)) {
      write = shipped
      report.updated.push(rel)
    } else {
      const merge = record?.text === undefined ? null : merge3(record.text, onDisk, shipped)
      if (merge?.kind === 'merged') {
        // Only the vault's changes, on top of what it already had: nothing new
        // from Holi, so nothing to write or report.
        if (merge.text === onDisk) report.current.push(rel)
        else {
          write = merge.text
          report.merged.push(rel)
        }
      } else {
        await writeAtomic(root, vaultRelPath(stagedPath(rel, 'shipped')), shipped)
        if (record?.text !== undefined) {
          await writeAtomic(root, vaultRelPath(stagedPath(rel, 'base')), record.text)
        }
        // The agent's resolution is made against this release, so it is the
        // base the next update merges from.
        await recordSeeded(root, rel, shipped)
        report.conflicts.push(rel)
        continue
      }
    }

    if (write !== null) await writeAtomic(root, vaultRelPath(rel), write)
    // The shipped text is the base from here on, whatever the file now holds:
    // a merged file carries the vault's changes on top of it.
    if (onDisk !== null || write !== null) await recordSeeded(root, rel, shipped)
    await removeStaged(root, rel)
  }

  await mergeSettings(root)
  return report
}

/** What an update answers across the CLI and IPC: the report, and the
 *  session its conflicts were handed to, if any. */
export type SkillsUpdate =
  | { ok: true; report: UpdateReport; summary: string; terminalId?: string }
  | { ok: false; message: string }

/** The report in one line, for the notification and the CLI. */
export function describeUpdate(report: UpdateReport, sessionStarted: boolean): string {
  const parts = [
    [report.updated.length, 'updated'],
    [report.added.length, 'added'],
    [report.merged.length, 'merged'],
  ] as const
  const done = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)
  const conflicts = report.conflicts.length
  if (done.length === 0 && conflicts === 0) return 'Skills are up to date.'
  const head = done.length > 0 ? `Skills: ${done.join(', ')}.` : ''
  const tail =
    conflicts === 0
      ? ''
      : `${conflicts} ${conflicts === 1 ? 'needs' : 'need'} merging by hand` +
        (sessionStarted
          ? ': a session is on it.'
          : ', with the new version staged beside each as a .shipped.local file.')
  return [head, tail].filter((t) => t !== '').join(' ')
}

/**
 * The first turn of the session that resolves an update's conflicts. One of
 * the few sends Holi submits: resolving them is a job the user asked for.
 */
export async function updateConflictPrompt(root: string, conflicts: string[]): Promise<string> {
  const lines: string[] = []
  for (const rel of conflicts) {
    const base = stagedPath(rel, 'base')
    const hasBase = (await readFile(join(root, base)).catch(() => null)) !== null
    lines.push(
      `- \`${rel}\`: Holi's new version is \`${stagedPath(rel, 'shipped')}\`` +
        (hasBase ? `; the version this vault started from is \`${base}\`` : '') +
        '.',
    )
  }
  return [
    'Holi ships newer versions of these files, and this vault has changed them too, so they could not be merged automatically:',
    '',
    ...lines,
    '',
    "Merge each one in place: bring in Holi's changes and keep this vault's own. Where the two contradict, keep what this vault meant and say so. Then delete the `.shipped.local` and `.base.local` files, and summarise what changed.",
  ].join('\n')
}
