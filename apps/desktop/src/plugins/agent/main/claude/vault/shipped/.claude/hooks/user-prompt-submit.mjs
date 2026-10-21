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
// Local reads and a few git plumbing calls. Holi's main process keeps
// `.holi/state/context.local.json` current and records where each turn ended
// in `.holi/state/turns.local.json`, keyed by the session's job id (the name of
// `$CLAUDE_JOB_DIR`). Outside Holi, with nothing focused, or in a session with
// no recorded turn, those are absent and it prints nothing for them.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** Plumbing output, or null when git fails (no repo, a sha that is gone).
 *  Never takes `.git/index.lock` for a stat refresh: a live agent may be
 *  committing beside it. */
function git(args, env) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
  } catch {
    return null
  }
}

/** The working tree as a tree object, through a scratch copy of the index so
 *  the real one is untouched; ignored files left out. The same thing Holi
 *  records as a turn's end while another session's turn is still running. */
function worktreeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'holi-prompt-'))
  try {
    const index = join(dir, 'index')
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim()
    if (!real) return null
    try {
      copyFileSync(real, index)
    } catch {
      // No index yet: start from empty.
    }
    const env = { GIT_INDEX_FILE: index }
    if (git(['add', '--all'], env) === null) return null
    return git(['write-tree'], env)?.trim() || null
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

/** A secret file's name, in any folder: `.env`, `.env.<x>`, `.secrets`,
 *  `.secrets.<x>`. A copy of `isSecretPath` in `@holi/shared`, because a hook
 *  runs in any Claude Code and cannot import Holi. */
const SECRET_NAME = /^\.(env|secrets)(\..+)?$/i

/** Holi's own state, machine-local files and secrets are not what anyone needs
 *  told about. */
const worthNaming = (path) =>
  !path.startsWith('.holi/state/') &&
  !path.includes('.local.') &&
  !path.split('/').some((segment) => SECRET_NAME.test(segment))

/** A path as a code span, or quoted when a backtick or a control character in
 *  it would break one. */
const shown = (path) => (/[`\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : `\`${path}\``)

function changesLine() {
  if (!jobDir) return null
  const turns = readJson('.holi/state/turns.local.json')
  // Newest first, so the first record naming this session is its last turn.
  const job = basename(jobDir)
  const end = Array.isArray(turns) ? turns.find((t) => t?.sessionId === job)?.end : undefined
  if (typeof end !== 'string' || !/^[0-9a-f]{7,64}$/.test(end)) return null

  // Everything between where the turn ended (its settle commit, or the working
  // tree when another session's turn was still running) and the working tree
  // now, committed or not.
  const now = worktreeTree()
  if (now === null) return null
  const changed = git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', end, now, '--'])
  if (changed === null) return null
  const paths = changed.split('\0').filter(Boolean).filter(worthNaming)
  if (paths.length === 0) return null

  const named = paths.slice(0, SHOWN).map(shown)
  const more = paths.length > SHOWN ? ` and ${paths.length - SHOWN} more` : ''
  return `Changed since your last turn, not by you: ${named.join(', ')}${more} (\`git diff ${end.slice(0, 12)}\` shows how)`
}

const lines = [focusLine(), changesLine()].filter(Boolean)
if (lines.length > 0) process.stdout.write(lines.join('\n'))
process.exit(0)
