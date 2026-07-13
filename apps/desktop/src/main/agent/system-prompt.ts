// Port of the old app's `build_system_prompt` (agent_context.rs), adjusted
// for the new system: permission-mode and apps sections dropped, memory and
// skills guidance retargeted to native file edits, task/note guidance
// retargeted to the 7 `mcp__holi__*` ops + native file tools.
//
// Ships once per session via `--append-system-prompt`. Per-turn context
// (fill indicators, focused note, related tasks/backrefs) is the
// UserPromptSubmit hook's job, not this module's.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const USER_MD_BUDGET = 4_000
export const MEMORY_MD_BUDGET = 5_000

const TOKEN_TO_CHAR = 4
const TOTAL_CHAR_CAP = 48_000 * TOKEN_TO_CHAR

const SECTION_SEPARATOR = '\n\n***\n\n'

export interface VaultTreeEntry {
  name: string
  isDir: boolean
  children?: VaultTreeEntry[]
}

/** Truncate to `cap` chars with a trailing marker the agent can see. */
export function capPrompt(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n[…truncated to ${cap.toLocaleString('en-US')} chars]`
}

/**
 * Top level + one descent into visible directories; dot-entries skipped
 * (the agent sees what the file tree shows by default). Missing root is
 * non-fatal — the prompt still carries identity + tools + conventions.
 */
export async function readVaultTree(root: string): Promise<VaultTreeEntry[]> {
  async function level(dir: string, depth: number): Promise<VaultTreeEntry[]> {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const visible = dirents
      .filter((d) => !d.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
    const entries: VaultTreeEntry[] = []
    for (const d of visible) {
      const entry: VaultTreeEntry = { name: d.name, isDir: d.isDirectory() }
      if (entry.isDir && depth < 1) {
        entry.children = await level(join(dir, d.name), depth + 1)
      }
      entries.push(entry)
    }
    return entries
  }
  return level(root, 0)
}

export function renderVaultTree(tree: VaultTreeEntry[]): string {
  const lines = ['## Vault top-level layout']
  function visit(entries: VaultTreeEntry[], depth: number) {
    for (const entry of entries) {
      lines.push(`${'  '.repeat(depth)}- ${entry.name}${entry.isDir ? '/' : ''}`)
      if (entry.children) visit(entry.children, depth + 1)
    }
  }
  visit(tree, 0)
  return lines.join('\n')
}

const TOOLS = [
  '## Tools',
  '- Task and note operations are 7 MCP tools prefixed `mcp__holi__*`: `task_new`, `task_list`, `task_get`, `task_set`, `task_link`, `task_delete`, `note_rename`. Call them directly — their schemas are in your tool list.',
  '- Files: `Read` / `Glob` / `Grep` for read-only; `Edit` / `Write` for mutations. The working directory is a live materialization of the shared vault — every file you save syncs to the user’s editor and other vault members in real time.',
  '- Renames go through `mcp__holi__note_rename` — it rewrites every `[[…]]` reference across the vault. Never `mv` a note; a raw move loses its identity and breaks links.',
  '- Tasks are server records, not files. There is nothing to `Read` or `Edit` for a task — use the `mcp__holi__task_*` ops.',
  '- Web: `WebFetch` / `WebSearch` for facts the vault doesn’t have. Cite the URL in your reply.',
]

const ASKING_THE_USER = [
  '## Asking the user',
  'When you need answers from the user to proceed — scope, preferences, ambiguous file targets, anything — **always** use the native `AskUserQuestion` tool instead of listing the questions inline in your reply. Up to 4 questions per call; pop another batch if you need more. Each question gets an implicit "Other" choice — never enumerate it yourself.',
]

const AGENDA_HEURISTICS = [
  '## Agenda heuristics',
  '- `mcp__holi__task_list` filters by `status` only — fetch the narrowest status set that answers the question, then filter by due date, tags, or priority yourself.',
  '- After completing a task on the user’s behalf, mention the next item if one exists.',
]

const USER_MEMORY = [
  '## Memory: USER.md',
  `\`<vault>/USER.md\` is your memory of the user — machine-local, never synced to other members. Its current contents are shown at the top of every turn with a fill indicator against the budget. Append entries with a native \`Edit\` when:`,
  '- the user states a preference (e.g. "I work in PT", "keep replies terse"),',
  '- they correct your style, tone, or format ("don’t apologise", "no trailing summaries"),',
  '- you notice a durable working-style fact you’d want on day one of a fresh conversation.',
  'Treat an incomplete user model as standing work: a low fill percentage means you don’t know the user yet — capture durable facts proactively, don’t wait to be asked. The most valuable entry is one that prevents the user from having to correct or remind you again.',
  `One fact per entry, written as a declarative fact, not an instruction to yourself ("Nicolai prefers terse replies" ✓, "Always reply tersely" ✗). Hard char budget = ${USER_MD_BUDGET.toLocaleString('en-US')}. Prune by editing the file.`,
].join('\n')

const VAULT_MEMORY = [
  '## Memory: MEMORY.md',
  `\`<vault>/MEMORY.md\` is your free-form working memory of this vault — environment quirks, recurring patterns, approaches that didn’t work, pointers to skills and scripts you maintain. Distinct from USER.md (about the user); this is about the vault and your own work in it. It syncs to every vault member, so keep it about the shared vault, not the user’s machine. Its current contents are shown at the top of every turn.`,
  `Append with a native \`Edit\`. Hard char budget = ${MEMORY_MD_BUDGET.toLocaleString('en-US')}. Prune by editing the file.`,
].join('\n')

const MEMORY_GUIDANCE = [
  '## When to save to memory',
  '**Save the *fact*, not the conversation.** Something you will want to remember in a future session: a preference the user stated, a project goal, a non-obvious convention, a workflow that worked, a deadline.',
  '**Do NOT save:** the current task, what you just did this turn, ephemeral chat context. Memory is for things that survive — for ephemeral context, just answer.',
  '**Procedures belong in skills, not memory.** A repeatable how-to goes into a skill; memory holds who the user is and what’s true about the vault.',
  `**Budget overflow:** char budgets are hard (USER.md: ${USER_MD_BUDGET.toLocaleString('en-US')}, MEMORY.md: ${MEMORY_MD_BUDGET.toLocaleString('en-US')}). When a file is over budget, consolidate — merge overlapping entries, delete stale ones — with a native \`Edit\`.`,
].join('\n')

const SKILLS_GUIDANCE = [
  '## Skills',
  'A skill is a reusable procedure — "how I write a weekly review", "how I triage Monday emails". Skills live at `<vault>/.claude/skills/<name>/SKILL.md` and are picked up natively; create and edit them with the native file tools.',
  '**When to use:** before starting a task, check whether a skill matches — even partially. If one does, follow it: skills encode the user’s preferred approach and conventions, so load them even for tasks you already know how to do.',
  '**When to create:** after completing a non-trivial multi-step task whose approach is worth replaying. After fixing a tricky error with a non-obvious fix. After discovering a workflow worth replaying.',
  '**When to patch:** when using a skill and finding it outdated, incomplete, or wrong — edit it immediately. Stale skills are liabilities.',
  '**Scripts live inside skills:** a reusable script belongs at `<name>/scripts/`, documented in its SKILL.md — never in a loose directory you’ll forget.',
].join('\n')

const VAULT_SYSTEM = [
  '## The vault system (Holi)',
  '- **Live sync**: the working directory is a live materialization of a shared vault. Saves sync to the user’s editor and every other member within moments; while you edit a note the user sees a "Claude is editing…" presence marker on it. No commit or push step — syncing is automatic.',
  '- **Recurring tasks**: marking a recurring task `done` (via `mcp__holi__task_set`) auto-rolls its due date forward to the next instance — don’t create a new task for the next occurrence.',
  '- **Wiki-link rewrites on rename**: `mcp__holi__note_rename` rewrites every `[[…]]` reference across the vault. Don’t grep-and-replace links manually, and never rename with `mv`.',
  '- **Tasks are server records**: they live in Holi’s database, not as files in the vault. `mcp__holi__task_new` / `task_set` / `task_link` / `task_delete` are the only way to change them.',
  '- **Holi-managed files at vault root**: `CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, and `.claude/` config are infra Holi seeds and syncs. `USER.md` and `MEMORY.md` are curated by you through native edits; treat `CLAUDE.md` as read-only — do not propose creating, deleting, or moving it.',
].join('\n')

const VAULT_CONVENTIONS = [
  '## Vault conventions',
  '- Wiki-links use the vault-relative path inside `[[…]]` with `.md`: `[[meetings/2026-04-19.md]]`.',
  '- Reference tasks by their id (from `mcp__holi__task_list` / `task_get`), not by path — they have no path.',
].join('\n')

const OUTPUT_FORMATTING = [
  '## Output formatting',
  '- Your replies render in a terminal. Use plain markdown: bullets for lists, fenced blocks for code, vault-relative paths (`meetings/2026-04-19.md`) when referencing notes so the user can find them in the file tree.',
  '- Keep replies terse — the terminal is narrow and the user is next to their editor.',
].join('\n')

const SCRIPTING = [
  '## Scripting',
  'Run one-off commands inline and discard them. Anything reusable becomes part of a skill: write the script to `<vault>/.claude/skills/<name>/scripts/` and reference it from the skill’s SKILL.md — that’s how you rediscover it next session.',
].join('\n')

export interface BuildSystemPromptArgs {
  /** Working-copy `.claude/IDENTITY.md` content; omitted when absent. */
  identity?: string | null
  /** Working-copy `.claude/SOUL.md` content; omitted when absent. */
  soul?: string | null
  tree: VaultTreeEntry[]
}

export function buildSystemPrompt({ identity, soul, tree }: BuildSystemPromptArgs): string {
  // IDENTITY first, then SOUL — same order as the old app.
  const identityLayers = [identity, soul]
    .map((s) => s?.trim() ?? '')
    .filter((s) => s.length > 0)

  const holiBase = [
    USER_MEMORY,
    VAULT_MEMORY,
    MEMORY_GUIDANCE,
    SKILLS_GUIDANCE,
    VAULT_SYSTEM,
    VAULT_CONVENTIONS,
    OUTPUT_FORMATTING,
    SCRIPTING,
    renderVaultTree(tree),
  ].join('\n\n')

  const blocks: string[] = []
  if (identityLayers.length > 0) blocks.push(identityLayers.join(SECTION_SEPARATOR))
  blocks.push(TOOLS.join('\n'))
  blocks.push(ASKING_THE_USER.join('\n'))
  blocks.push(AGENDA_HEURISTICS.join('\n'))
  blocks.push(holiBase)

  return capPrompt(blocks.join(SECTION_SEPARATOR), TOTAL_CHAR_CAP)
}
