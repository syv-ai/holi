/**
 * Managed vault files (spec §Managed seeding): the agent config every vault
 * member shares — the CLAUDE.md shim, AGENTS.md, MEMORY.md, hook wiring, and
 * the hook scripts themselves.
 *
 * Seeding rides the adoption path (plan decision 4): we write missing files
 * into the working dir after the mirror starts, and the watcher adopts them as
 * vault docs exactly like agent-created files — so they sync to every member
 * with no special-casing. Create-if-missing only: a member who edits AGENTS.md
 * keeps their edit forever.
 *
 * USER.md is deliberately NOT seeded — it's machine-local (isLocalOnlyPath) and
 * the agent creates it when it first learns something about the user.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'
import userPromptSubmitHook from './hooks/user-prompt-submit.mjs?raw'

/** The old bootstrap's shim: CLAUDE.md is the file the CLI reads; AGENTS.md is
 * the file humans and other agents edit. One import keeps them in sync. */
const CLAUDE_MD = '<rules>\n@AGENTS.md\n</rules>\n'

const AGENTS_MD = `# Agent rules

Shared instructions for anyone (human or agent) working in this vault. Everyone
in the vault sees this file — keep it about the vault, not about one person.

- Notes are markdown files; renames go through the \`note_rename\` op so
  \`[[wiki-links]]\` are rewritten. Never \`mv\` a note.
- Tasks are files: \`tasks/<slug>-<id>.md\`, YAML frontmatter + a markdown body
  for the description. Create, edit and delete them with ordinary file tools.
  Never edit the \`id:\` or \`version:\` lines. Name notes and folders by path.
- To *complete* a task use the \`task_set\` op, not a file edit — writing
  \`status: done\` cannot say whether a recurring task rolls forward or ends.
  To *query* tasks use \`task_list\`; never glob and parse \`tasks/\`.
- Edits sync live to every member. There is no commit step.
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

export const SEED_FILES: Record<string, string> = {
  'CLAUDE.md': CLAUDE_MD,
  'AGENTS.md': AGENTS_MD,
  'MEMORY.md': MEMORY_MD,
  '.claude/settings.json': SETTINGS_JSON,
  '.claude/hooks/user-prompt-submit.mjs': userPromptSubmitHook,
}

/**
 * Write any managed file that is neither a known vault doc nor already on
 * disk. Returns the paths actually written (the watcher adopts them shortly
 * after). Idempotent: safe to run on every vault activation.
 */
export async function ensureSeeded(workRoot: string, knownDocPaths: Set<string>): Promise<string[]> {
  const written: string[] = []
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    if (knownDocPaths.has(rel)) continue
    const onDisk = await readFile(join(workRoot, rel), 'utf8').catch(() => null)
    if (onDisk !== null) continue
    await writeAtomic(workRoot, vaultRelPath(rel), content)
    written.push(rel)
  }
  return written
}
