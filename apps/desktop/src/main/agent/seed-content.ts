/**
 * The managed files every vault carries: the `.gitignore` that keeps private
 * files private, the CLAUDE.md shim, the shared agent instructions, and the
 * per-turn context hook.
 *
 * **Seeding runs when a vault is created or adopted (`vaults.add`/`vaults.create`
 * → `ensureSeeded`), NOT on every subsequent open** (`vaults.open` does not
 * re-seed). Create-if-missing makes that safe and gives managed files simple
 * "born-with-the-vault" semantics: the file is written once, at birth, and a
 * member who edits — or deletes — it keeps that change (a plain open never
 * resurrects it; only re-adding the same vault would rewrite a missing one).
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
import { LOCAL_ONLY_IGNORE_LINES, vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'
import userPromptSubmitHook from './hooks/user-prompt-submit.mjs?raw'
import googleSendGateHook from './hooks/google-send-gate.mjs?raw'
import mdToPdfSkill from './skills/md-to-pdf/SKILL.md?raw'
import themeSkill from './skills/theme/SKILL.md?raw'
import gmailCalendarSkill from './skills/gmail-calendar/SKILL.md?raw'
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

Shared instructions for anyone — human or agent — working in this vault.
Everyone here sees this file, so keep it about the vault rather than about one
person.

## What this vault is

A git repository of markdown files. There is no database and no server: the
file **is** the note, the task, and the record.

## Notes

- A note is a \`.md\` file at a path, e.g. \`projects/q2/roadmap.md\`.
- Links between notes are path-based wiki-links: \`[[projects/q2/roadmap.md]]\`,
  or \`[[path|Label]]\`. This is the only link grammar.
- **Renaming a note means rewriting every \`[[link]]\` that points at it**, in
  the same change. Find them with a grep for \`[[<path>\` before moving the file.
  A rename that skips this leaves dangling links, which render as tombstones.

## Images

- Images live in the vault as ordinary committed files (\`.png\`, \`.jpg\`,
  \`.svg\`, …). Put the file where it belongs — usually beside the note that
  uses it, or in an \`assets/\` folder near it.
- Embed one with **standard markdown, note-relative**: \`![alt](logo.png)\`
  resolves next to the current note; \`![alt](assets/logo.png)\` into a subfolder.
  This is what renders on GitHub too — write portable paths, **never** a
  \`holi-vault://\` URL (that is Holi's internal render scheme, not file content).
- \`[[logo.png]]\` also embeds an image, but as a **vault-root** path (like every
  \`[[link]]\`). Prefer \`![]()\` for images so the note stays standard markdown.

## Tasks

- A task is a file named \`task.<name>.md\`, living in the folder it is about —
  e.g. \`projects/q2/task.fix-login.md\`. One glob, \`**/task.*.md\`, finds them
  all.
- YAML frontmatter carries \`status\` (todo | doing | done), \`due\`, \`priority\`,
  \`tags\`, \`reminder\` and \`recurrence\`; the body is the description.
- There are **no task ids**. A link to a task is an ordinary wiki-link to its
  file, and its "area" is just the folder it sits in — moving it between areas
  means moving the file.
- Create, edit and complete them with ordinary file tools.

## How your edits reach other people

Edits are committed automatically, a few seconds after they stop, and those
commits push to GitHub on their own — there is no Publish step. Sync is
automatic in both directions.

## Git is yours

You may run git freely — \`commit\`, \`push\`, \`pull\`, resolve a merge. While you
are working, Holi suspends its own auto-commit/pull loop and resumes it when your
turn goes idle, so there is only ever one git actor and you never contend on
\`.git/index.lock\`.

- **Switching branches pauses Holi's sync until you switch back.** If you check
  out another branch or leave a rebase in progress, Holi's loop stays paused
  until the working tree returns to the default branch — so undo it when you're
  done, or say so.
- \`git log\` and \`git diff\` are always safe to run.

## Memory

- \`MEMORY.md\` — shared with everyone in the vault. Vault conventions,
  environment quirks, approaches that did not work.
- \`USER.local.md\` — your model of one individual. **Machine-local and
  gitignored** (the \`.local.\` in the name is what makes it so); it never
  reaches anyone else's clone. Keep personal detail here, not in \`MEMORY.md\`.
`

const MEMORY_MD = `# Memory

Shared working memory of this vault — conventions, environment quirks,
approaches that didn't work, pointers to skills worth reusing. Synced to every
member. Budget: 5,000 characters; consolidate when it fills up.
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
        // The send gate (D70). It matches Bash broadly and decides for itself,
        // rather than relying on an `if` condition: the agent can spell the
        // command three ways, and a condition that misses one fails OPEN while
        // still reading like protection. The hook defers on everything it does
        // not recognise, so the cost of matching broadly is one child process
        // per Bash call.
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('google-send-gate') }] },
        ],
      },
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
const VAULT_MARKER = JSON.stringify({ version: 1 }, null, 2) + '\n'

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
 * The vault's colour/chrome theme, seeded empty (D64). Both files ship in every
 * vault so theming is discoverable — a member opens the vault, finds them under
 * show-hidden, and knows where shared (`theme.json`, committed) vs personal
 * (`theme.local.json`, gitignored) overrides go. Empty blocks = the standard
 * look until edited; the token vocabulary lives in the seeded `theme` skill.
 */
const THEME_SKELETON = JSON.stringify({ $schema: 'holi-theme/v1', dark: {}, light: {} }, null, 2) + '\n'

/** Written only when absent. Never updated, so a member's edit survives. */
export const SEED_FILES: Record<string, string> = {
  '.holi/vault.json': VAULT_MARKER,
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
  '.holi/theme.json': THEME_SKELETON,
  // Seeded but gitignored (`*.local.*`) — the one machine-local file we seed, so
  // the personal-override slot exists by default. The `.gitignore` is written
  // first in `ensureSeeded`, so this is ignored before it lands.
  '.holi/theme.local.json': THEME_SKELETON,
  'CLAUDE.md': CLAUDE_MD,
  'AGENTS.md': AGENTS_MD,
  'MEMORY.md': MEMORY_MD,
  '.claude/settings.json': SETTINGS_JSON,
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
  '.claude/hooks/google-send-gate.mjs': googleSendGateHook,
  '.claude/skills/md-to-pdf/SKILL.md': mdToPdfSkill,
  '.claude/skills/theme/SKILL.md': themeSkill,
  '.claude/skills/gmail-calendar/SKILL.md': gmailCalendarSkill,
}

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

/**
 * Write whatever managed file is missing. Returns the paths actually written.
 * Idempotent, and safe to run on every vault activation.
 */
export async function ensureSeeded(root: string): Promise<string[]> {
  const written: string[] = []

  // First, and on its own, because everything below it is a file that would be
  // committed — and until this exists there is nothing stopping `git add -A`
  // from taking a machine-local file with it.
  const existing = await readFile(join(root, GITIGNORE), 'utf8').catch(() => null)
  const next = gitignoreWithLocalOnly(existing)
  if (next !== null) {
    await writeAtomic(root, vaultRelPath(GITIGNORE), next)
    written.push(GITIGNORE)
  }

  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    written.push(rel)
  }

  // Brand binaries (Raleway fonts + logo), base64 in a generated module. Same
  // if-absent rule as the text seeds, via the bytes overload of writeAtomic.
  for (const [rel, b64] of Object.entries(BRAND_BINARIES)) {
    const onDisk = await readFile(join(root, rel)).catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(root, vaultRelPath(rel), Buffer.from(b64, 'base64'))
    written.push(rel)
  }
  return written
}
