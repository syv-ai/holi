#!/usr/bin/env node
// Holi UserPromptSubmit hook: injects the per-turn state the agent cannot
// discover itself. The note the user has focused in the editor, and the lines
// selected in it (numbers only; the agent reads the text). And, in a session
// Holi has recorded a turn of, the files that changed since that turn ended,
// which this session did not change: the user's edits, a pull, another session.
// Tasks, backreferences and sync state the agent finds with its own native
// tools (Glob/grep/git); vault conventions and memory guidance live in
// AGENTS.md. See docs/features/agent-config.md.
//
// Local reads and two git plumbing calls. Holi's main process keeps
// `.holi/state/context.local.json` current and records each turn's commit range
// in `.holi/state/turns.local.json`, keyed by the session's job id (the name of
// `$CLAUDE_JOB_DIR`). Outside Holi, with nothing focused, or in a session with
// no recorded turn, those are absent and it prints nothing for them.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const jobDir = process.env.CLAUDE_JOB_DIR

/** How many changed paths the line names before it says "and N more". */
const SHOWN = 10

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch {
    return null
  }
}

/** NUL-separated plumbing output as a list, or null when git fails (no repo, a
 *  sha that is gone). */
function git(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return out.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function focusLine() {
  const context = readJson('.holi/state/context.local.json')
  if (!context?.focusedPath) return null
  const { startLine, endLine } = context.selection ?? {}
  const selected = !Number.isInteger(startLine)
    ? ''
    : startLine === endLine
      ? `selected line ${startLine}; `
      : `selected lines ${startLine}-${endLine}; `
  return `Focused note: \`${context.focusedPath}\` (${selected}use \`Read\` to view its contents)`
}

/** Holi's own state and machine-local files are not what anyone edited. */
const worthNaming = (path) => !path.startsWith('.holi/state/') && !path.includes('.local.')

function changesLine() {
  if (!jobDir) return null
  const turns = readJson('.holi/state/turns.local.json')
  // Newest first, so the first record naming this session is its last turn.
  const job = basename(jobDir)
  const end = Array.isArray(turns) ? turns.find((t) => t?.sessionId === job)?.end : undefined
  if (typeof end !== 'string' || !/^[0-9a-f]{7,64}$/.test(end)) return null

  // Committed since the turn's settle commit (autosave makes most edits
  // commits), then whatever is not committed yet.
  const committed = git(['diff', '--name-only', '--no-renames', '-z', end, 'HEAD', '--'])
  if (committed === null) return null
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? []
  const pending = []
  for (let i = 0; i < status.length; i++) {
    pending.push(status[i].slice(3))
    // A rename or copy carries its old path as the next entry.
    if (/^[RC]/.test(status[i])) i++
  }
  const paths = [...new Set([...committed, ...pending])].filter(worthNaming)
  if (paths.length === 0) return null

  const named = paths.slice(0, SHOWN).map((p) => `\`${p}\``)
  const more = paths.length > SHOWN ? ` and ${paths.length - SHOWN} more` : ''
  return `Changed since your last turn, not by you: ${named.join(', ')}${more} (\`git diff ${end.slice(0, 12)}\` shows how)`
}

const lines = [focusLine(), changesLine()].filter(Boolean)
if (lines.length > 0) process.stdout.write(lines.join('\n'))
process.exit(0)
