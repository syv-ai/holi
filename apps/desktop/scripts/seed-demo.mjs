#!/usr/bin/env node
/**
 * Fill a vault clone with demo content that shows Holi's features: the editor's
 * blocks and marks, the board's tasks, a daily note, Holis to send documents
 * to, and automations, one of them a Holi's.
 *
 *   node apps/desktop/scripts/seed-demo.mjs <vault clone> [--yes]
 *
 * Tables are written padded, the way the editor's table widget keeps them, so
 * they open as tables rather than as markdown (docs/features/editor.md).
 *
 * It only adds files: one that already exists is left alone, so running it
 * twice is safe. Dates are relative to today, so the board always has
 * something due, something late and something done.
 *
 * Holi autosaves, commits and pushes a managed clone, so whatever this writes
 * reaches the vault's remote. It refuses a clone whose remote is on GitHub
 * unless `--yes` says that is meant.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const vault = args.find((a) => !a.startsWith('--'))
if (vault === undefined) {
  console.error('usage: seed-demo.mjs <vault clone> [--yes]')
  process.exit(1)
}
const root = resolve(vault)
if (!existsSync(join(root, '.git'))) {
  console.error(`${root} is not a git clone`)
  process.exit(1)
}
let remote = ''
try {
  remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim()
} catch {
  // No remote: nothing to push to, nothing to guard.
}
if (/github\.com/i.test(remote) && !args.includes('--yes')) {
  console.error(
    `${root} pushes to ${remote}.\nHoli would sync this demo content there. Re-run with --yes if that is meant.`,
  )
  process.exit(1)
}

// ── Dates, relative to today ──────────────────────────────────────────────
const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const day = (offset) => {
  const d = new Date(today)
  d.setDate(d.getDate() + offset)
  return d
}
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dmy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`

const task = ({ status, due, priority, tags, recurrence }, body) => {
  const lines = ['---', `status: ${status}`]
  if (due) lines.push(`due: ${due}`)
  if (priority) lines.push(`priority: ${priority}`)
  if (tags) lines.push(`tags: [${tags.join(', ')}]`)
  if (recurrence) lines.push(recurrence)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

// ── The files ─────────────────────────────────────────────────────────────
const files = {
  // A tour of the editor: every block and mark the slash menu and the
  // selection bubble make, as the markdown they write.
  'Welcome to Holi.md': `# Welcome to Holi

This vault is demo content. Every note is plain markdown in a GitHub repository, so what you see here is what is on disk. Type \`/\` on an empty line for blocks, select text for the formatting bubble, or press Space on an empty line to ask the agent.

[toc]

## Writing

Text can be **bold**, *italic*, <u>underlined</u>, ~~struck through~~ or \`code\`. Highlights come in ==yellow==, <mark data-color="green">green</mark>, <mark data-color="blue">blue</mark>, <mark data-color="pink">pink</mark> and <mark data-color="violet">violet</mark>.

<div align="center">

A centred paragraph: the tags hide until the caret is inside it.

</div>

> A quote. Notes link to each other by path: see [[kunder/acme/Acme]] or [[Meetings/Kickoff with Acme]].

## Lists

- A bullet
  - nested under it
- [ ] A to-do in a note
- [x] One that is done

1. Numbered
2. Steps

## Tables and code

| Customer | Stage      | Owner |
| -------- | ---------- | ----- |
| Acme     | Proposal   | Ada   |
| Nordlys  | Onboarding | Bo    |

\`\`\`ts
// Code blocks keep their language.
const greet = (name: string) => \`Hello, \${name}\`
\`\`\`

\`\`\`mermaid
flowchart LR
  Note --> Holi[Send to Holi] --> Tab[Agent tab] --> Review[Review changes]
\`\`\`

## Try

1. Open [[kunder/acme/Acme]] and choose **Agent ▾ → Proposal**.
2. Open the **Board** from the sidebar: one task is late, one is due today.
3. Switch to **Agents** at the top of the sidebar to see the Holis.
`,

  // Today's daily note, so the tree marks it and Home can open on it.
  [`${dmy(today)}.md`]: `---
type: daily-note
date: ${iso(today)}
---

# ${dmy(today)}

- Proposal for [[kunder/acme/Acme]] goes out today.
- ==Follow up with Nordlys== about the onboarding call.
`,

  // Customers: what the Proposal Holi takes.
  'kunder/acme/Acme.md': `# Acme

- **Contact:** Jane Doe, head of operations
- **Need:** a shared knowledge base for 40 support staff, with agents that draft answers from it.

## What they asked for

- Onboarding for three teams in November
- Their own templates for customer replies
- Monthly usage report

## Budget

| Item     | Estimate   |
| -------- | ---------- |
| Setup    | 3 days     |
| Training | 2 sessions |
| Support  | 6 months   |

Send this note to the **Proposal** Holi to turn it into a PDF proposal.
`,
  'kunder/acme/task.send-proposal.md': task(
    { status: 'doing', due: iso(today), priority: 'high', tags: ['sales'] },
    `# Send the proposal to Acme

Draft it from [[kunder/acme/Acme]] with the Proposal Holi, then send it to Jane.`,
  ),
  'kunder/nordlys/Nordlys.md': `# Nordlys

- **Contact:** Bo Hansen
- **Status:** onboarding

Nordlys runs field service in three regions. They want their technicians' notes and checklists in one vault.
`,
  'kunder/nordlys/task.book-onboarding-call.md': task(
    { status: 'todo', due: iso(day(-1)), priority: 'medium', tags: ['onboarding'] },
    `# Book the onboarding call with Nordlys

This one is late, so the Board's count turns red.`,
  ),

  // A meeting: what the Meeting Holi takes.
  'Meetings/Kickoff with Acme.md': `# Kickoff with Acme

**When:** ${iso(day(-2))} · **Who:** Jane, Ada, Bo

## Notes

- Acme wants the knowledge base live before their busy season.
- Support leads will own the templates.

## Action items

- [ ] Ada: send the proposal by Friday
- [ ] Bo: share the onboarding plan
- [ ] Jane: list the three teams and their leads

Send this note to the **Meeting** Holi to file a task for each action item.
`,

  // The rest of the board.
  'Projects/task.write-launch-post.md': task(
    { status: 'todo', due: iso(day(3)), priority: 'low', tags: ['marketing'] },
    `# Write the launch post

Outline in [[Welcome to Holi]].`,
  ),
  'Projects/task.review-roadmap.md': task(
    {
      status: 'todo',
      due: iso(day(1)),
      tags: ['planning'],
      recurrence: 'recurrence:\n  frequency: weekly\n  interval: 1',
    },
    `# Review the roadmap

Every week. Completing it makes the next one.`,
  ),
  'Projects/task.pick-a-theme.md': task(
    { status: 'done', tags: ['design'] },
    `# Pick a theme for the vault

Done: Settings → Theme.`,
  ),

  // A layout the Proposal Holi follows.
  'Templates/Proposal layout.md': `# Proposal for {customer}

## The problem

## What we propose

## Price and timeline

| Item | Price |
| ---- | ----- |

## Next steps
`,

  // Holis: agents with a soul and a memory, sent a document or run by an
  // automation (docs/features/holis.md). Each is a folder.
  '.holi/holis/proposal/holi.yaml': `# Sent a customer note, writes a proposal next to it.
name: Proposal
mascot: rocket
description: Turns a customer note into a proposal
model: sonnet
accepts:
  - kunder/**/*.md
allow:
  - Edit(kunder/**)
`,
  '.holi/holis/proposal/SOUL.md': `# Soul

## Standing instructions

- Write a proposal for the customer in the note you are sent, following
  Templates/Proposal layout.md.
- Save it beside the note as "Proposal.md".
`,
  '.holi/holis/proposal/MEMORY.md': `- ${iso(day(-3))} · Prices are quoted in DKK, excluding VAT
`,
  '.holi/holis/meeting/holi.yaml': `# Sent a meeting note, files its action items as tasks.
name: Meeting
mascot: frog
description: Files a task for each action item in a meeting note
accepts:
  - Meetings/**/*.md
allow:
  - Edit(Meetings/**)
  - Edit(**/task.*.md)
`,
  '.holi/holis/meeting/SOUL.md': `# Soul

## Standing instructions

- For every unchecked action item in the meeting note, create a task file
  (see the using-tasks skill) in the folder the item belongs to, linking back
  to the meeting.
- Tick the item in the note once its task exists.
`,
  '.holi/holis/housekeeping/holi.yaml': `name: Housekeeping
mascot: robot
description: Keeps the vault tidy
allow:
  - Edit(**/task.*.md)
`,
  '.holi/holis/housekeeping/SOUL.md': `# Soul

## Standing instructions

- Move, never delete. Keep a moved note's folders.
- Fix wiki-links that point at a moved or renamed note.
`,

  // Automations on this machine (docs/features/scheduled-agents.md). They do
  // nothing until someone turns them on in the Agents view.
  '.holi/schedules/morning-brief.md': `---
name: Morning brief
cron: '0 8 * * 1-5'
model: sonnet
allow:
  - Edit(**/task.*.md)
---

Read today's daily note and the board. Write a short brief at the top of the
daily note: what is due today, what is late, and what changed since yesterday.
`,
  // One a Holi carries out: its habit.
  '.holi/schedules/sunday-tidy.md': `---
name: Sunday tidy
cron: '0 20 * * 0'
holi: housekeeping
---

Find done tasks older than 30 days and move them to Archive/.
`,
}

// ── Write ─────────────────────────────────────────────────────────────────
let created = 0
for (const [path, text] of Object.entries(files)) {
  const target = join(root, path)
  if (existsSync(target)) {
    console.log(`kept     ${path}`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  console.log(`created  ${path}`)
  created += 1
}
console.log(`\n${created} file(s) added to ${root}.`)
