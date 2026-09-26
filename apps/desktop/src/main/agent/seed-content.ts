/**
 * The managed files every vault carries: the `.gitignore` that keeps private
 * files private, the shared agent instructions (`AGENTS.md`, which Claude Code
 * reads natively, so there is no `CLAUDE.md`), and the per-turn context hook.
 *
 * **Seeding runs on vault creation, adoption AND every open** (`vaults.add`/
 * `vaults.create`/`vaults.open` → `ensureSeeded`; the open case is D70).
 * Running it that often is what makes a NEW seeded file reach older vaults with
 * no migration. A member who deletes a seeded file gets it back on the next
 * open, which is the price of the send gate being present in every vault.
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
import memoryIndexGuardHook from './hooks/memory-index-guard.mjs?raw'
import mdToPdfSkill from './skills/md-to-pdf/SKILL.md?raw'
import themeSkill from './skills/theme/SKILL.md?raw'
import gmailCalendarSkill from './skills/gmail-calendar/SKILL.md?raw'
import vaultAppsSkill from './skills/vault-apps/SKILL.md?raw'
import usingTasksSkill from './skills/using-tasks/SKILL.md?raw'
import memorySkill from './skills/memory/SKILL.md?raw'
import pdfCommentsSkill from './skills/pdf-comments/SKILL.md?raw'
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
 * A turn-bracket hook: POST to Holi's local hook server so it can pause sync
 * while the agent works. Guarded by `[ -n "$HOLI_HOOK_PORT" ]` so it is a silent
 * no-op for a bare `claude` opened outside Holi. Port and token come from the
 * child env, so this committed command needs no per-session rewrite. Hook
 * commands are not the agent's Bash tool, so `permissions.ask` does not gate it.
 */
const turnHook = (endpoint: 'start' | 'end') =>
  `[ -n "$HOLI_HOOK_PORT" ] || exit 0; curl -s --max-time 2 -X POST "http://127.0.0.1:$HOLI_HOOK_PORT/turn/${endpoint}?t=$HOLI_HOOK_TOKEN" >/dev/null 2>&1`

const SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        // UserPromptSubmit injects the focused-note context AND signals turn
        // start; Stop signals turn end. That bracket already spans all tool use,
        // so PreToolUse is only for gating send (D70), below.
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
        // resume AND compact: after a compact the agent has just forgotten it
        // has memory at all.
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('memory-overview') }] }],
        // The vault-app validator. Advisory only (it reports and exits 0), so
        // the agent gets feedback instead of a syntax error surfacing as a
        // blank tab.
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
       * makes about mail: main is the sole token authority (D67), the send gate
       * is a hook on `Bash` (D70), and the cache is patched by Holi's own writes
       * (D68). None of those apply to a tool Holi never sees.
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
       * Claude Code's own auto-memory lives outside the vault, never syncs, and
       * is the surface its system prompt steers the agent to. This key closes
       * that door so `memory/` is the one place to look.
       *
       * **Off rather than redirected.** `autoMemoryDirectory` is ignored in
       * projectSettings, and its format addresses memories by `[[slug]]` where
       * Holi's address them by vault path.
       */
      autoMemoryEnabled: false,
      permissions: {
        // Seeded egress gating: the user still approves each one, they just
        // don't slip through unasked.
        //
        // The holi-google entries are the *undoable* tier (D70) and are NOT the
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
        // nothing (D106). Merged into existing vaults like `ask` is.
        allow: ['Bash(holi pdf comments:*)'],
      },
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
 * what one is (D76): the script body ships in the binary and lives in
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
 * The vault's colour/chrome theme (D64). Both files ship in every vault so
 * theming is discoverable: shared overrides go in `theme.css` (committed),
 * personal ones in `theme.local.css` (gitignored).
 *
 * **Seeded with the whole token vocabulary commented out, not empty**, so the
 * file itself names what can be set.
 */
const THEME_SKELETON = applyThemePatch(null, {})

/**
 * **Holi owns these after writing them** (D75). Documentation and code Holi
 * ships: refreshed on every open, but only when the file on disk is still
 * byte-for-byte what Holi last wrote there (see `seed-state.ts`). Without that,
 * a shipped skill's first draft would be permanent in every vault.
 */
export const MANAGED_FILES: Record<string, string> = {
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
  '.claude/hooks/google-send-gate.mjs': googleSendGateHook,
  '.claude/hooks/vault-app-check.mjs': vaultAppCheckHook,
  '.claude/hooks/memory-overview.mjs': memoryOverviewHook,
  '.claude/hooks/memory-index-guard.mjs': memoryIndexGuardHook,
  '.claude/skills/md-to-pdf/SKILL.md': mdToPdfSkill,
  '.claude/skills/theme/SKILL.md': themeSkill,
  '.claude/skills/gmail-calendar/SKILL.md': gmailCalendarSkill,
  '.claude/skills/vault-apps/SKILL.md': vaultAppsSkill,
  '.claude/skills/using-tasks/SKILL.md': usingTasksSkill,
  /**
   * How to write a memory (D89).
   *
   * **A skill rather than more `AGENTS.md` prose, because `AGENTS.md` is a
   * ONCE_FILE and cannot be corrected.** Skills are managed, so this one lands
   * in every vault on the next open and can be improved later (D75).
   */
  '.claude/skills/memory/SKILL.md': memorySkill,
  /** `holi pdf comments` (D106): what it prints, and that it only reads. */
  '.claude/skills/pdf-comments/SKILL.md': pdfCommentsSkill,
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
  // The branded set and its shared brand foundation (D66). `_brand/` is skipped
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
   * The memory directory exists and is tracked from a vault's first commit
   * (D89), in its empty-state form; after that the `memory-index` transform
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
export const SEED_FILES: Record<string, string> = { ...ONCE_FILES, ...MANAGED_FILES }

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
 * (D70) as a hook script nothing invokes.
 *
 * Key-wise, the way `.gitignore` is line-wise: an adopted vault's own hooks and
 * permission rules are not ours to replace. Holi adds what it needs and touches
 * nothing else.
 *
 * A malformed file returns `null`: it is the user's, and unparseable JSON is not
 * something to "fix" by overwriting. The cost is an ungated vault.
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
    permissions: { ask: string[]; allow: string[] }
    disableClaudeAiConnectors: boolean
    autoMemoryEnabled: boolean
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
   * One memory surface (D89), merged for `disableClaudeAiConnectors`'s reason.
   *
   * **Only when absent.** A user who set it `true` wants Claude Code's own
   * auto-memory as well; the vault's `memory/` works either way.
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
    hooks.PreToolUse = [
      ...preToolUse,
      ...required.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('google-send-gate')),
    ]
    settings.hooks = hooks
    changed = true
  }

  // The memory index guard, merged and matched the same way.
  if (!JSON.stringify(hooks.PreToolUse ?? []).includes('memory-index-guard')) {
    hooks.PreToolUse = [
      ...(hooks.PreToolUse ?? []),
      ...required.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('memory-index-guard')),
    ]
    settings.hooks = hooks
    changed = true
  }

  // The vault-app validator, merged and matched the same way as the gate.
  const postToolUse = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : []
  if (!JSON.stringify(postToolUse).includes('vault-app-check')) {
    hooks.PostToolUse = [...postToolUse, ...required.hooks.PostToolUse]
    settings.hooks = hooks
    changed = true
  }

  // The session overview (D89), matched the same way.
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

  // And the read-only commands that need no prompt.
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : []
  const missingAllow = required.permissions.allow.filter((rule) => !allow.includes(rule))
  if (missingAllow.length > 0) {
    permissions.allow = [...allow, ...missingAllow]
    settings.permissions = permissions
    changed = true
  }

  return changed ? JSON.stringify(settings, null, 2) + '\n' : null
}

/**
 * What one run of `ensureSeeded` did.
 *
 * `skipped` has to be visible: a managed file left alone is Holi declining to
 * ship an improvement, and the user is entitled to know which.
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
 * Idempotent, and safe to run on every vault activation. Three rules, one per
 * class:
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
    // `settings.json` is MERGED rather than skipped when present: see
    // `settingsWithRequired` and the block below.
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
      // Already exactly what we ship, however it got there, so it is ours.
      // Recording it is what lets the NEXT version reach this vault.
      await recordSeeded(root, rel, content)
      continue
    }
    const state = await readSeedState(root)
    if (state[rel] === undefined) {
      // No recorded hash. Assume the user's: guessing the other way would
      // silently rewrite their edited skills.
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
 * The on-demand half of D75: `ensureSeeded` declines whenever it cannot prove
 * the file is still its own, and `--force` is how a user says "I edited it,
 * give me your copy back".
 *
 * **`--force` reaches managed files only.** A once-file is the user's, so
 * asking for one comes back as `not managed` rather than as an error.
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
