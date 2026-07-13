#!/usr/bin/env node
// Holi UserPromptSubmit hook — prints the per-turn context block that Claude
// Code injects into the turn: current memory files (with fill indicators) and
// the note the user is looking at, plus its tasks and backlinks.
//
// Pure local reads (<50 ms): Holi's main process keeps
// `.holi/context.local.json` current, so this never talks to a server. Outside
// Holi the files are absent and it prints nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const USER_BUDGET = 4000
const MEMORY_BUDGET = 5000
const SEPARATOR = '\n\n***\n\n'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()

function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8').trim()
  } catch {
    return ''
  }
}

/** `[31% — 1,240/4,000 chars]` — a visibly low fill is the every-turn nudge
 * that the model of the user/vault is still incomplete. */
function fillIndicator(chars, budget) {
  const pct = Math.min(100, Math.floor((chars * 100) / budget))
  return `[${pct}% — ${chars.toLocaleString('en-US')}/${budget.toLocaleString('en-US')} chars]`
}

function memorySection(header, body, budget, emptyHint) {
  if (!body) return `${header} [0% — empty]\n\n(empty — ${emptyHint})`
  return `${header} ${fillIndicator(body.length, budget)}\n\n${body}`
}

const sections = [
  memorySection(
    '## Memory of the user (`USER.md`)',
    read('USER.md'),
    USER_BUDGET,
    'get to know the user. As they reveal preferences, working style, or facts you\'d want available on day one of a fresh conversation, append them to `USER.md` with an `Edit`.',
  ),
  memorySection(
    '## Memory (`MEMORY.md`)',
    read('MEMORY.md'),
    MEMORY_BUDGET,
    'when you notice vault conventions, environment quirks, or approaches that didn\'t work, append them to `MEMORY.md` with an `Edit` so it\'s recalled next turn.',
  ),
]

let context = null
try {
  context = JSON.parse(readFileSync(join(root, '.holi/context.local.json'), 'utf8'))
} catch {
  // no editor context (bare CLI, or nothing focused yet) — memory only
}

if (context?.focusedPath) {
  const lines = []
  const open = context.openPaths ?? []
  if (open.length > 0) {
    lines.push('Active notes:')
    for (const path of open) lines.push(`- ${path}`)
    lines.push('')
  }
  lines.push(`Focused note: \`${context.focusedPath}\` (use \`Read\` to view its contents)`)
  sections.push(lines.join('\n'))

  const tasks = context.relatedTasks ?? []
  const taskLines = ['# Related non-complete tasks']
  if (tasks.length === 0) taskLines.push('(none)')
  else {
    for (const t of tasks) {
      const due = t.due ? `, due=${t.due}` : ''
      taskLines.push(`- [${t.status}] ${t.title} (id=${t.id}${due})`)
    }
  }
  sections.push(taskLines.join('\n'))

  const backrefs = context.backrefPaths ?? []
  const backrefLines = ['# Related notes (backreferences)']
  if (backrefs.length === 0) backrefLines.push('(none)')
  else for (const path of backrefs) backrefLines.push(`- [[${path}]]`)
  sections.push(backrefLines.join('\n'))
}

process.stdout.write(sections.join(SEPARATOR))
process.exit(0)
