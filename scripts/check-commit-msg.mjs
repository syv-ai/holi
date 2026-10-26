#!/usr/bin/env node
// Commit message check: a single subject line, `type: subject` or `type(scope): subject`,
// with type one of feat, fix, chore, doc, refac, and no attribution trailers.
//
//   commit-msg hook:  node scripts/check-commit-msg.mjs "$1"        (path of the message file)
//   CI, a range:      node scripts/check-commit-msg.mjs --range <base>..<head>
//   a string:         node scripts/check-commit-msg.mjs --message "feat: add x"
//
// Registered in .agents/skills/holi-rules/SKILL.md (rule `commit-msg/format`).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUBJECT = /^(feat|fix|chore|doc|refac)(\([a-z0-9-]+\))?: .+/
const ATTRIBUTION = [
  [/^co-authored-by:/im, 'a Co-Authored-By trailer'],
  [/^claude-session:/im, 'a Claude-Session trailer'],
  [/generated with \[?claude code/i, 'a "Generated with Claude Code" line'],
  [/claude\.ai\/code\/session/i, 'a Claude Code session link'],
]
const AUTOMATED = /^(Merge |Revert "|fixup! |squash! )/

/** Problems in one commit message, each saying what is wrong, the fix, and why. */
export function problemsIn(message) {
  const lines = message.replace(/\r\n/g, '\n').split('\n')
  // `git commit` leaves its own comment lines in the editor buffer.
  const text = lines
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim()
  if (text === '')
    return ['The message is empty. Write `type: subject`, so history says what changed.']
  if (AUTOMATED.test(text)) return []
  const problems = []
  const [subject, ...rest] = text.split('\n')
  if (!SUBJECT.test(subject)) {
    problems.push(
      `Subject "${subject}" is not \`type: subject\`. Start with feat, fix, chore, doc or refac (optional scope in parentheses), a colon and a space, so history can be filtered by kind of change.`,
    )
  }
  if (rest.some((l) => l.trim() !== '')) {
    problems.push(
      'The message has a body or trailers. Keep a single subject line and put the detail in the pull request, so the log reads as a list of changes.',
    )
  }
  for (const [re, what] of ATTRIBUTION) {
    if (re.test(text)) {
      problems.push(
        `The message contains ${what}. Remove it; commits and pull requests carry no tool attribution in this repository.`,
      )
    }
  }
  return problems
}

function main(argv) {
  let messages
  if (argv[0] === '--range') {
    const range = argv[1]
    if (!range) throw new Error('--range needs <base>..<head>')
    // %x00 separates commits, %H the hash; the body follows after a blank line.
    const out = execFileSync('git', ['log', '--no-merges', '--format=%H%x01%B%x00', range], {
      encoding: 'utf8',
    })
    messages = out
      .split('\0')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [hash, ...body] = c.split('\x01')
        return { label: hash.slice(0, 8), text: body.join('\x01') }
      })
  } else if (argv[0] === '--message') {
    messages = [{ label: 'message', text: argv[1] ?? '' }]
  } else if (argv[0]) {
    messages = [{ label: 'commit message', text: readFileSync(argv[0], 'utf8') }]
  } else {
    throw new Error(
      'usage: check-commit-msg.mjs <message-file> | --range <a..b> | --message <text>',
    )
  }

  let failed = 0
  for (const { label, text } of messages) {
    const problems = problemsIn(text)
    if (problems.length === 0) continue
    failed++
    console.error(`commit-msg: ${label}`)
    for (const p of problems) console.error(`  - ${p}`)
  }
  if (failed > 0) {
    console.error(`\n${failed} commit message${failed === 1 ? '' : 's'} rejected.`)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
