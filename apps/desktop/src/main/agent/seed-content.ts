/**
 * The managed files every vault carries: the `.gitignore` that keeps private
 * files private, the CLAUDE.md shim, the shared agent instructions, and the
 * per-turn context hook.
 *
 * **Seeding runs on every vault open, not just at creation** (auth PRD FR-8
 * seeds a *new* vault; adoption needs it just as much). Create-if-missing makes
 * that safe: the first person to open a vault seeds it, everyone else no-ops,
 * and a member who edits `AGENTS.md` keeps their edit forever.
 *
 * **`.gitignore` is the exception, and the reason this module matters.** An
 * adopted repo usually already has one, so create-if-missing would silently
 * never write ours — and the sync engine commits with `git add -A`, so the
 * first commit would carry `USER.md` to every collaborator. Its lines are
 * therefore appended individually, and they come from `LOCAL_ONLY_IGNORE_LINES`
 * rather than being copied here, so the ignore file and the vault store's
 * notion of "machine-local" cannot drift apart.
 *
 * `USER.md` is deliberately NOT seeded: it is machine-local, and the agent
 * creates it when it first learns something about the user.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_ONLY_IGNORE_LINES, vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'
import userPromptSubmitHook from './hooks/user-prompt-submit.mjs?raw'

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

Edits are committed automatically, a few seconds after they stop. Those commits
stay on this machine until the user presses **Publish**.

- **Do not run \`git commit\`, \`git push\`, \`git pull\`, or switch branches.**
  Holi is doing this, and a branch checkout pauses sync until it is undone.
- If you need to know what changed, \`git log\` and \`git diff\` are safe.

## Memory

- \`MEMORY.md\` — shared with everyone in the vault. Vault conventions,
  environment quirks, approaches that did not work.
- \`USER.md\` — your model of one individual. **Machine-local and gitignored**;
  it never reaches anyone else's clone. Keep personal detail here, not in
  \`MEMORY.md\`.
`

const MEMORY_MD = `# Memory

Shared working memory of this vault — conventions, environment quirks,
approaches that didn't work, pointers to skills worth reusing. Synced to every
member. Budget: 5,000 characters; consolidate when it fills up.
`

const hookCommand = (name: string) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.mjs"`

const SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        // The one surviving hook. PreToolUse/Stop existed to open and close the
        // bridge's turn protocol; there is no turn to bracket now that the file
        // IS the document (D60), and the editor reconciles a foreign write on
        // its own.
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('user-prompt-submit') }] }],
      },
      permissions: {
        // seeded egress gating (PRD §Security posture) — the user still
        // approves each one, they just don't slip through unasked
        ask: ['Bash(curl:*)', 'Bash(wget:*)'],
      },
    },
    null,
    2,
  ) + '\n'

/** Written only when absent. Never updated, so a member's edit survives. */
export const SEED_FILES: Record<string, string> = {
  'CLAUDE.md': CLAUDE_MD,
  'AGENTS.md': AGENTS_MD,
  'MEMORY.md': MEMORY_MD,
  '.claude/settings.json': SETTINGS_JSON,
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
}

export const GITIGNORE = '.gitignore'

/**
 * The `.gitignore` text this vault should have, or **null** if it already has
 * every line it needs.
 *
 * Line-wise rather than whole-file, because an adopted repo's existing ignores
 * are not ours to replace — and because appending to a file with no trailing
 * newline would otherwise produce `node_modulesUSER.md`, which ignores nothing
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
  return written
}
