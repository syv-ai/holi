/**
 * The managed files every vault carries: the `.gitignore` that keeps private
 * files private, the CLAUDE.md shim, the shared agent instructions, and the
 * per-turn context hook.
 *
 * **Seeding runs on vault creation, adoption AND every open** (`vaults.add`/
 * `vaults.create`/`vaults.open` → `ensureSeeded`; the open case is D70).
 * Create-if-missing is what makes running it that often safe, and it is also
 * what makes a NEW managed file reach vaults that predate it with no migration:
 * the next open writes the one file that is absent and touches nothing else. A
 * member who edits a managed file keeps that change; one who deletes it gets it
 * back on the next open, which is the price of the send gate being present in
 * every vault.
 *
 * **`.gitignore` is the exception, and the reason this module matters.** An
 * adopted repo usually already has one, so create-if-missing would silently
 * never write ours — and the sync engine commits with `git add -A`, so the
 * first commit would carry a `*.local.*` file to every collaborator. Its lines
 * are therefore appended individually, and they come from
 * `LOCAL_ONLY_IGNORE_LINES` rather than being copied here, so the ignore file
 * and the vault store's notion of "machine-local" cannot drift apart.
 *
 * `USER.local.md` is deliberately NOT seeded: it is machine-local (its name says
 * so), and the agent creates it when it first learns something about the user.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyThemePatch,
  ICONS_FILE,
  LOCAL_ONLY_IGNORE_LINES,
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
import { mayRefresh, readSeedState, recordSeeded } from './seed-state'
import userPromptSubmitHook from './hooks/user-prompt-submit.mjs?raw'
import googleSendGateHook from './hooks/google-send-gate.mjs?raw'
import vaultAppCheckHook from './hooks/vault-app-check.mjs?raw'
import memoryOverviewHook from './hooks/memory-overview.mjs?raw'
import mdToPdfSkill from './skills/md-to-pdf/SKILL.md?raw'
import themeSkill from './skills/theme/SKILL.md?raw'
import gmailCalendarSkill from './skills/gmail-calendar/SKILL.md?raw'
import vaultAppsSkill from './skills/vault-apps/SKILL.md?raw'
import usingTasksSkill from './skills/using-tasks/SKILL.md?raw'
import memorySkill from './skills/memory/SKILL.md?raw'
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

/** The old bootstrap's shim: CLAUDE.md is the file the CLI reads; AGENTS.md is
 * the file humans and other agents edit. One import keeps them in sync. */
const CLAUDE_MD = '<rules>\n@AGENTS.md\n</rules>\n'

const AGENTS_MD = `# Agent rules

## What a vault is

A git repository of markdown files. No database, no server: the file **is** the note, the task, and the record.

- A note is a \`.md\` file at a path: \`projects/q2/roadmap.md\`.
- Links are path-based wiki-links: \`[[projects/q2/roadmap.md]]\` or \`[[path|Label]]\`.
- Renaming a note means rewriting every \`[[link]]\` to it. A pre-commit hook does this for renames git can see; grep \`[[<path>\` if you moved the file some other way. Doing it yourself as well is harmless.
- Images, PDFs and anything else are ordinary committed files: \`![alt](logo.png)\`.

## Tasks

- A task is a \`.md\` file prefixed \`task.\`: \`projects/q2/task.fix-login.md\`. Glob \`**/task.*.md\`.
- Frontmatter carries \`status\` (todo | doing | done), \`due\`, \`priority\`, \`tags\`, \`reminder\`, \`recurrence\`. The body is the description.
- No task ids — link one like any note. Its "area" is the folder it sits in.

## Sync

Edits auto-commit every few seconds and push on their own; pulls are automatic. There is no Publish step.

Run git freely, merges included. Holi pauses its own commit/pull loop for the length of your turn, so you never contend on \`.git/index.lock\`. It stays paused while you are off the default branch or mid-rebase.

## Memory

A memory is **one fact in one file** under \`memory/\`. Write one whenever you learn something this vault will want again.

- Frontmatter: \`type\` (free-form — \`convention\`, \`environment\`, \`person\`, \`project\`, \`reference\`, \`preference\` are a starting set, not a list to stay inside) and a one-line \`description\`, which is what the index and the session overview print. \`title\` is optional and falls back to the H1, then the filename.
- The body is the fact. Link other memories with ordinary wiki-links: \`[[memory/other.md]]\`.
- \`memory/whatever.local.md\` is **personal** — the \`.local.\` makes it gitignored, so it never leaves this clone. Anything about one person goes there.
- \`memory/index.md\` is **generated** on commit. Edit the memory files; edits to the index are discarded.

Use the **memory** skill when writing one.

\`MEMORY.md\` and \`USER.local.md\` are the older shape. Both still work and are still read, and neither is written to any more — a personal fact goes in \`memory/<name>.local.md\`, which the session overview announces, where \`USER.local.md\` is auto-loaded by nothing and listed nowhere. Splitting either into \`memory/\` is worth doing when the user asks; never unasked.
`

const hookCommand = (name: string) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.mjs"`

/**
 * A turn-bracket hook: POST to Holi's local hook server so it learns turn
 * start/end (git coexistence — pause sync while the agent works). Guarded by
 * `[ -n "$HOLI_HOOK_PORT" ]` so it is a silent no-op for a bare `claude` opened
 * in this vault outside Holi (no server, no port). The port + token are read
 * live from the child env Holi injects, so this shared/committed command needs
 * no per-session rewrite. NOT gated by `permissions.ask` — hook commands run
 * directly, they are not the agent's Bash tool.
 */
const turnHook = (endpoint: 'start' | 'end') =>
  `[ -n "$HOLI_HOOK_PORT" ] || exit 0; curl -s --max-time 2 -X POST "http://127.0.0.1:$HOLI_HOOK_PORT/turn/${endpoint}?t=$HOLI_HOOK_TOKEN" >/dev/null 2>&1`

const SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        // UserPromptSubmit injects the focused-note context AND signals turn
        // start; Stop signals turn end. Together they bracket a turn for git
        // coexistence (the hook-server signal, not PTY parsing). PreToolUse was
        // deliberately absent for that purpose — the UserPromptSubmit→Stop
        // bracket already spans all tool use — and arrived later for an
        // unrelated one: gating send (D70), below.
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: hookCommand('user-prompt-submit') },
              { type: 'command', command: turnHook('start') },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: turnHook('end') }] }],
        // What this vault remembers, once per session (D89). Fires on startup,
        // resume AND compact — the third is the one that matters most, being
        // exactly when the agent has just forgotten it has memory at all.
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('memory-overview') }] }],
        // The vault-app validator. Advisory only — it reports and exits 0 —
        // because slice 1's authoring loop had no feedback in it at all: the
        // agent wrote an app blind and asked the user to go and look, so a
        // syntax error surfaced as a blank tab and a puzzled user.
        //
        // Matched on the writing tools rather than on the path, because the
        // matcher grammar cannot see a path; the hook returns immediately for
        // anything outside `.holi/apps/`.
        PostToolUse: [
          {
            matcher: 'Write|Edit|MultiEdit',
            hooks: [{ type: 'command', command: hookCommand('vault-app-check') }],
          },
        ],
        // The send gate (D70). It matches Bash broadly and decides for itself,
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
          // The same gate, over Gmail's *MCP* tools (2026-08-14).
          //
          // A `Bash` matcher sees only Bash. When a claude.ai Gmail connector is
          // available the agent will happily reach for it instead of
          // `holi-google` — observed in real use — and every one of those calls
          // sailed past this gate, because an MCP tool call is not a shell
          // command. `disableClaudeAiConnectors` below is the real fix; this is
          // the belt to its braces, for a vault whose settings regress or whose
          // user re-enables the connector deliberately.
          {
            matcher: 'mcp__.*[Gg]mail.*',
            hooks: [{ type: 'command', command: hookCommand('google-send-gate') }],
          },
        ],
      },
      /**
       * No claude.ai cloud connectors in a vault (2026-08-14).
       *
       * The agent used a claude.ai **Gmail** connector to write a draft, in
       * preference to `holi-google` — which routes around every guarantee this
       * app makes about mail: main is the sole token authority (D67), the send
       * gate is a hook on `Bash` (D70), and the cache is patched by Holi's own
       * writes (D68). None of those apply to a tool Holi never sees.
       *
       * Settable in any scope, and `true` in *any* source wins, so this checked-in
       * project file opts the vault out and a user-level `false` cannot undo it.
       * It does **not** touch skills or plugins inherited from `~/.claude` —
       * project settings cannot reach those, and that is a separate decision.
       */
      disableClaudeAiConnectors: true,
      /**
       * One memory surface, not two (D89).
       *
       * Claude Code keeps its own auto-memory under
       * `~/.claude/projects/<sanitized-cwd>/memory/`. That directory is outside
       * the vault, never syncs, is invisible to teammates, and the agent reaches
       * for it in preference to the vault's because it is the surface its own
       * system prompt describes. `memory/` is the vault's answer; this key
       * closes the other door so there is one place to look.
       *
       * **Off rather than redirected.** `autoMemoryDirectory` could point Claude
       * Code at `memory/`, and is the wrong lever twice: it is explicitly
       * ignored when set in projectSettings, so Holi could only set it per
       * clone; and its format is Anthropic's, with `[[slug]]` links that address
       * memories by name where Holi's address them by vault path. Holi would be
       * committing a format it does not control to every member of a shared
       * repository.
       *
       * Verified live against 2.1.267 rather than read out of the binary: with
       * this key in a project `.claude/settings.json`, a session reports no
       * memory directory at all; with `{}` it reports one.
       */
      autoMemoryEnabled: false,
      permissions: {
        // seeded egress gating (PRD §Security posture) — the user still
        // approves each one, they just don't slip through unasked
        //
        // The holi-google entries are the *undoable* tier (D70) and are NOT the
        // wall: a user can allow-always their way past any of them, which is
        // fine, because each has a one-click undo in Gmail or Google Calendar.
        // The wall for send/reply is the PreToolUse hook above, which overrides
        // both this list and a prior "don't ask again". The send/reply entries
        // here are belt-and-braces for a vault whose hook file was removed.
        ask: [
          'Bash(curl:*)',
          'Bash(wget:*)',
          'Bash(holi-google archive:*)',
          'Bash(holi-google trash:*)',
          'Bash(holi-google unschedule:*)',
          'Bash(holi-google send:*)',
          'Bash(holi-google reply:*)',
        ],
      },
    },
    null,
    2,
  ) + '\n'

/**
 * The durable, in-repo marker that a repo is a Holi vault. Its GitHub twin is
 * the `holi-vault` topic (github/api.ts) — the topic is the cheap discovery
 * index the picker filters on; this file is the record that travels with the
 * clone, and the natural home for vault-level metadata as it accrues.
 */
/**
 * The vault's own settings, seeded once and then the user's.
 *
 * **Built from `VAULT_SETTING_DESCRIPTORS`, not written out here.** The same
 * list drives the onboarding step that asks about these, so the file a vault is
 * born with and the questions it was asked cannot drift apart — and adding a
 * setting later is adding a descriptor, not editing two places that have to
 * agree.
 *
 * The `hooks` block says **which** pre-commit transforms run, and can never say
 * what one is (D76): the script body ships in the binary and lives in
 * `.git/hooks/`, where nothing can push it onto anyone's laptop. Keys are the
 * transform names, kebab and all.
 *
 * `archive-done` is off because it moves task files, which changes what the
 * board shows; a transform that rearranges someone's work is opt-in.
 */
const HOLI_SETTINGS = seedSettingsText(seedSettings('committed'), 'committed')

/**
 * The machine-local half — today, which appearance this machine follows.
 *
 * Gitignored by the seeded `*.local.*` rule, exactly like `theme.local.yaml`
 * beside it, so a personal choice is never pushed to anyone.
 */
const HOLI_SETTINGS_LOCAL = seedSettingsText(seedSettings('local'), 'local')

/** One line: the vault format version. Not JSON, because nothing ever parsed
 *  it — `isVaultClone` asks only whether the file can be read. See
 *  `VAULT_MARKER_FILE` for why an extensionless flag rather than a document. */
const VAULT_MARKER = '1\n'

/** The Plain template's manifest — a clean, unbranded layout with two optional
 * metadata fields (Date, Recipient) that the Convert dialog renders as inputs
 * and template.typ prints as a small header. Committed vault content under
 * `.holi/document-templates/plain/`. Built via `JSON.stringify` (like VAULT_MARKER) so
 * there is no `.json?raw` import dependency. */
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
 * The vault's colour/chrome theme (D64). Both files ship in every vault so
 * theming is discoverable — a member opens the vault, finds them under
 * show-hidden, and knows where shared (`theme.yaml`, committed) vs personal
 * (`theme.local.yaml`, gitignored) overrides go.
 *
 * **Seeded with the whole vocabulary commented out, not empty.** Two empty
 * blocks were discoverable only in the sense that the FILES were: they named
 * none of the forty tokens, so knowing what could go in one meant leaving for
 * the settings pane or the `theme` skill. Every token is now a commented line
 * in its group, and setting one is deleting its `# `.
 */
const THEME_SKELETON = applyThemePatch(null, {})

/** Written only when absent. Never updated, so a member's edit survives. */
/**
 * **Holi owns these after writing them** (D75). Documentation and code Holi
 * ships: refreshed on every open, but only when the file on disk is still
 * byte-for-byte what Holi last wrote there (see `seed-state.ts`).
 *
 * Create-if-missing is what made `ensureSeeded` safe to run on every open, and
 * it is also what made a managed file impossible to improve. Slice 1 shipped a
 * `vault-apps` skill; reading it back the same day found four gaps, three of
 * which an agent gets *wrong* rather than merely misses — and the fix could
 * reach only vaults that had never been opened. A skill that cannot be
 * corrected is a skill whose first draft is permanent on every machine that
 * ever ran it.
 */
export const MANAGED_FILES: Record<string, string> = {
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
  '.claude/hooks/google-send-gate.mjs': googleSendGateHook,
  '.claude/hooks/vault-app-check.mjs': vaultAppCheckHook,
  '.claude/hooks/memory-overview.mjs': memoryOverviewHook,
  '.claude/skills/md-to-pdf/SKILL.md': mdToPdfSkill,
  '.claude/skills/theme/SKILL.md': themeSkill,
  '.claude/skills/gmail-calendar/SKILL.md': gmailCalendarSkill,
  '.claude/skills/vault-apps/SKILL.md': vaultAppsSkill,
  '.claude/skills/using-tasks/SKILL.md': usingTasksSkill,
  /**
   * How to write a memory (D89).
   *
   * **A skill rather than more `AGENTS.md` prose, because `AGENTS.md` is a
   * ONCE_FILE and cannot be corrected.** A vault seeded before D65 still tells
   * the agent that `USER.md` is machine-local — a claim Holi made and then
   * invalidated — and nothing has ever been able to reach it. Skills are
   * managed, so this one lands in every vault on the next open and can be
   * improved later, which is exactly the argument D75 already made about the
   * vault-apps skill.
   */
  '.claude/skills/memory/SKILL.md': memorySkill,
}

/**
 * **The user’s the moment they exist.** Create-if-missing, forever: a hash
 * match is not permission to rewrite one of these, because the question a hash
 * answers ("did anyone touch it?") is not the question that matters here.
 * `AGENTS.md` seeded with our words is still the file the user was handed to
 * write in, and re-asserting our draft over an identical copy would be Holi
 * arguing with them once a session.
 *
 * `.claude/settings.json` sits here but keeps its own third rule: it is MERGED
 * key-wise rather than created-if-missing (see `settingsWithRequired`),
 * because a seed that only runs at creation is a migration that never happens.
 */
/**
 * `.holi/settings/icons.yaml` — path → emoji, for the things that cannot carry an icon
 * in their own frontmatter: folders, non-markdown files, and the agent-surface
 * files where frontmatter would become prompt text. Seeded empty so the file is
 * discoverable (and so the agent has somewhere obvious to write) rather than
 * being a convention you have to be told about.
 */
const ICONS_SKELETON = '{}\n'

export const ONCE_FILES: Record<string, string> = {
  [VAULT_MARKER_FILE]: VAULT_MARKER,
  [SETTINGS_FILE]: HOLI_SETTINGS,
  '.holi/document-templates/plain/template.json': PLAIN_MANIFEST,
  '.holi/document-templates/plain/template.typ': plainTemplateTyp,
  // The branded set and its shared brand foundation (D66 rename, spec
  // 2026-08-04). `_brand/` is skipped by the template picker (underscore prefix);
  // its binary fonts + logo are seeded separately from BRAND_BINARIES below.
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
  'CLAUDE.md': CLAUDE_MD,
  'AGENTS.md': AGENTS_MD,
  /**
   * The memory directory exists and is tracked from a vault's first commit
   * (D89), in its empty-state form — after that the `memory-index` transform
   * owns the file.
   *
   * A ONCE_FILE and emphatically not a MANAGED_FILE: managed means "rewritten
   * when the shipped version changes", and this one is rewritten by a transform
   * on every commit that touches a memory. The two would fight, and the seed
   * runs on every vault OPEN, so the vault's real index would be replaced by the
   * empty stub roughly once a session.
   *
   * `MEMORY.md` is no longer seeded. Vaults that have one keep it, it is still
   * read, and nothing here moves it — that is content the user wrote, and
   * relocating it automatically is exactly the unattended shared-layer edit
   * `not-built.md` rules against. `AGENTS.md` names it as the older shape and
   * the session overview offers to split it when asked.
   */
  [MEMORY_INDEX]: MEMORY_INDEX_EMPTY,
  '.claude/settings.json': SETTINGS_JSON,
}

/** Both classes together — kept because a caller that only needs to know "is
 *  this a file Holi seeds?" should not have to ask which class it is in. */
export const SEED_FILES: Record<string, string> = { ...ONCE_FILES, ...MANAGED_FILES }

export const GITIGNORE = '.gitignore'

/**
 * The `.gitignore` text this vault should have, or **null** if it already has
 * every line it needs.
 *
 * Line-wise rather than whole-file, because an adopted repo's existing ignores
 * are not ours to replace — and because appending to a file with no trailing
 * newline would otherwise produce `node_modules*.local.*`, which ignores nothing
 * while looking like it ignores something.
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
 * **Merged rather than skipped, and that distinction is a security property.**
 * The seed loop is write-if-absent, and every vault opened before D70 already
 * has a `settings.json` — so the send gate would have arrived as a *file* and
 * never been wired: the hook script present, nothing invoking it, and `send`
 * reaching a real mailbox with no confirmation at all. Exactly D68's stale-grant
 * shape, where a capability widened in code while the stored artifact still
 * reflected the old one.
 *
 * Key-wise, the way `.gitignore` is line-wise, and for the same reason: an
 * adopted vault's own hooks and permission rules are not ours to replace. Holi
 * adds what it needs and touches nothing else.
 *
 * A malformed file returns `null` — it is the user's, and unparseable JSON is
 * not something to "fix" by overwriting. The cost is an ungated vault, which is
 * why `ensureSeeded`'s caller can see that nothing was written.
 */
export function settingsWithRequired(existing: string | null): string | null {
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
    permissions: { ask: string[] }
    disableClaudeAiConnectors: boolean
    autoMemoryEnabled: boolean
  }
  let changed = false

  /**
   * No claude.ai cloud connectors (2026-08-14).
   *
   * Merged here as well as seeded, because **a seed that only runs at creation
   * is a migration that never happens** — D70's own lesson, and the reason the
   * send gate was absent from every established vault when it shipped. Every
   * vault that exists today has a `settings.json`, so the creation path would
   * have reached none of them.
   *
   * Only ever set to `true`, and only when absent: a user who deliberately set
   * it `false` has said something, and re-asserting it on every vault open would
   * be Holi arguing with them once a session.
   */
  if (settings.disableClaudeAiConnectors === undefined) {
    settings.disableClaudeAiConnectors = required.disableClaudeAiConnectors
    changed = true
  }

  /**
   * One memory surface (D89), merged here for `disableClaudeAiConnectors`'s
   * reason: every vault that exists today already has a `settings.json`, so the
   * creation path would reach none of them.
   *
   * **Only when absent.** A user who set it `true` has said something — they
   * want Claude Code's own auto-memory as well — and Holi does not argue with
   * them once a session. The vault's `memory/` works either way; what the key
   * buys is that there is one place to look rather than two.
   */
  if (settings.autoMemoryEnabled === undefined) {
    settings.autoMemoryEnabled = required.autoMemoryEnabled
    changed = true
  }

  // The gate. Matched by the script it runs rather than by deep-equality, so a
  // user who reordered or annotated the entry does not get a duplicate.
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const hasGate = JSON.stringify(preToolUse).includes('google-send-gate')
  if (!hasGate) {
    hooks.PreToolUse = [...preToolUse, ...required.hooks.PreToolUse]
    settings.hooks = hooks
    changed = true
  }

  // The vault-app validator, merged for the gate's reason: every vault that
  // exists today already has a settings.json, so the creation path reaches none
  // of them. Matched by the script it runs, so a user who reordered or
  // annotated the entry does not get a duplicate.
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []
  if (!JSON.stringify(postToolUse).includes('vault-app-check')) {
    hooks.PostToolUse = [...postToolUse, ...required.hooks.PostToolUse]
    settings.hooks = hooks
    changed = true
  }

  // The session overview (D89), matched by the script it runs rather than by
  // deep-equality, the way the two gates above are: a user who reordered or
  // annotated the entry does not get a duplicate.
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []
  if (!JSON.stringify(sessionStart).includes('memory-overview')) {
    hooks.SessionStart = [...sessionStart, ...required.hooks.SessionStart]
    settings.hooks = hooks
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

  return changed ? JSON.stringify(settings, null, 2) + '\n' : null
}

/**
 * What one run of `ensureSeeded` did.
 *
 * Three lists rather than one, because "Holi wrote this file" now covers three
 * different events and the caller can act on only some of them. `skipped` is
 * the one that has to be visible: a managed file left alone is Holi declining
 * to ship an improvement, and the user is entitled to know which.
 */
export interface SeedResult {
  /** Created because it was absent. */
  written: string[]
  /** A managed file overwritten with a newer shipped version (D75). */
  refreshed: string[]
  /** A managed file Holi could not prove was still its own. */
  skipped: { path: string; reason: 'edited' | 'unrecorded' }[]
}

/**
 * Write whatever managed file is missing, and refresh the ones Holi still owns.
 *
 * Idempotent, and safe to run on every vault activation — which is the whole
 * point, since a seed that only runs at creation is a migration that never
 * happens. Three rules, one per class:
 *
 *   - **once** (`ONCE_FILES`) — created if absent, never touched again.
 *   - **managed** (`MANAGED_FILES`) — created if absent, and rewritten when the
 *     shipped content has changed *and* the file on disk is still byte-for-byte
 *     what Holi last wrote there. Anything else is skipped and reported.
 *   - **`.claude/settings.json`** — merged key-wise (`settingsWithRequired`).
 *
 * The `.gitignore` comes first and on its own: everything below it is a file
 * that would be committed, and until it exists nothing stops `git add -A` from
 * taking a machine-local file with it.
 */
export async function ensureSeeded(root: string): Promise<SeedResult> {
  const result: SeedResult = { written: [], refreshed: [], skipped: [] }

  const existing = await readFile(join(root, GITIGNORE), 'utf8').catch(() => null)
  const next = gitignoreWithLocalOnly(existing)
  if (next !== null) {
    await writeAtomic(root, vaultRelPath(GITIGNORE), next)
    result.written.push(GITIGNORE)
  }

  for (const [rel, content] of Object.entries(ONCE_FILES)) {
    // `settings.json` is the one file that is MERGED rather than skipped when
    // present — see `settingsWithRequired`, and the block below. Skipping it is
    // how the send gate would ship as an inert file in every existing vault.
    if (rel === SETTINGS) continue
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    result.written.push(rel)
  }

  for (const [rel, content] of Object.entries(MANAGED_FILES)) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk === null) {
      await writeAtomic(root, vaultRelPath(rel), content)
      await recordSeeded(root, rel, content)
      result.written.push(rel)
      continue
    }
    if (onDisk === content) {
      // Already exactly what we ship, however it got there — so it is ours, and
      // recording it is what lets the NEXT version reach this vault. Without
      // this line every vault seeded before the hashes existed stays frozen
      // forever, which is the problem D75 was written to solve.
      await recordSeeded(root, rel, content)
      continue
    }
    const state = await readSeedState(root)
    if (state[rel] === undefined) {
      // Predates the hashes. Assume the user's: this is the state every vault
      // in the world is in today, and guessing the other way rewrites their
      // edited skills once, silently.
      result.skipped.push({ path: rel, reason: 'unrecorded' })
      continue
    }
    if (!(await mayRefresh(root, rel, onDisk))) {
      result.skipped.push({ path: rel, reason: 'edited' })
      continue
    }
    await writeAtomic(root, vaultRelPath(rel), content)
    await recordSeeded(root, rel, content)
    result.refreshed.push(rel)
  }

  const settingsOnDisk = await readFile(join(root, SETTINGS), 'utf8').catch(() => null)
  const settingsNext = settingsWithRequired(settingsOnDisk)
  if (settingsNext !== null) {
    await writeAtomic(root, vaultRelPath(SETTINGS), settingsNext)
    result.written.push(SETTINGS)
  }

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

/**
 * `holi seed refresh [path] [--force]` — rewrite the managed files Holi wrote.
 *
 * The on-demand half of D75. `ensureSeeded` refreshes on open and declines
 * whenever it cannot prove the file is still its own; this is how the agent
 * asks for the one it just noticed is stale, and `--force` is how a user says
 * "I edited it, give me your copy back".
 *
 * **`--force` reaches managed files only.** A once-file is the user's — no
 * flag changes that, because the flag is about overriding an *edit check*, and
 * a once-file was never Holi's to check. Asking for one comes back as
 * `not managed` rather than as an error: the agent asked a reasonable
 * question and deserves the actual answer.
 */
export async function refreshManaged(
  root: string,
  opts: { path?: string; force?: boolean },
): Promise<{ refreshed: string[]; skipped: { path: string; reason: string }[] }> {
  const refreshed: string[] = []
  const skipped: { path: string; reason: string }[] = []

  if (opts.path !== undefined && MANAGED_FILES[opts.path] === undefined) {
    skipped.push({ path: opts.path, reason: 'not managed' })
    return { refreshed, skipped }
  }

  const targets = opts.path === undefined ? Object.keys(MANAGED_FILES) : [opts.path]

  for (const rel of targets) {
    const content = MANAGED_FILES[rel]!
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk === content) continue
    if (onDisk !== null && opts.force !== true && !(await mayRefresh(root, rel, onDisk))) {
      const state = await readSeedState(root)
      skipped.push({ path: rel, reason: state[rel] === undefined ? 'unrecorded' : 'edited' })
      continue
    }
    await writeAtomic(root, vaultRelPath(rel), content)
    await recordSeeded(root, rel, content)
    refreshed.push(rel)
  }
  return { refreshed, skipped }
}
