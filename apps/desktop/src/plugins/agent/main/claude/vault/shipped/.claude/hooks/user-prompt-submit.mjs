#!/usr/bin/env node
// Holi UserPromptSubmit hook: injects the per-turn state the agent cannot
// discover itself. The note the user has focused in the editor, and the lines
// selected in it (numbers only; the agent reads the text). And, in a
// background session, the files that changed since its last turn ended, which
// this session did not change: the user's edits, a pull, another session.
// Tasks, backreferences and sync state the agent finds with its own native
// tools (Glob/grep/git); vault conventions and memory guidance live in
// AGENTS.md. See docs/features/agent-config.md.
//
// Local reads and a few git plumbing calls. Holi's main process keeps
// `.holi/state/context.local.json` current. Where the last turn ended is the
// tree the Stop hook (`turn-signal.mjs end`) saved for this conversation in
// `.holi/state/turn-trees/<session_id>.local.json`, `session_id` being the
// input's, which a resume keeps. A conversation with no file there yet (its first turn, or one
// from before that hook) falls back to Holi's own record of the turn in
// `.holi/state/turns.local.json`, keyed by the job id (the name of
// `$CLAUDE_JOB_DIR`). With nothing focused, or no record either way, it prints
// nothing for them.

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const jobDir = process.env.CLAUDE_JOB_DIR

/** The hook's input JSON, or null. Bounded: a stdin that never ends must not
 *  hold the prompt. */
async function hookInput() {
  if (process.stdin.isTTY) return null
  const read = (async () => {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text
  })()
  const text = await Promise.race([read, new Promise((r) => setTimeout(() => r(null), 1000))])
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

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
 *  the real one is untouched; ignored files, and the `held` ones, left out.
 *  The copy keeps the real index's times, as Holi's `worktree-end.ts` does: a
 *  fresher one would make git trust the cached stat of a file edited in the
 *  same instant, and miss a same-size edit. A copy of `worktreeTree` in
 *  `turn-signal.mjs`. */
function worktreeTree(held) {
  const dir = mkdtempSync(join(tmpdir(), 'holi-prompt-'))
  try {
    const index = join(dir, 'index')
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim()
    if (!real) return null
    try {
      copyFileSync(real, index)
      // In whole milliseconds, rounded down: a Date rounds to the next one, and
      // this time must never pass the real index's.
      const { atimeMs, mtimeNs } = statSync(real, { bigint: true })
      utimesSync(index, Number(atimeMs) / 1000, Number(mtimeNs / 1_000_000n) / 1000)
    } catch {
      // No index yet: start from empty.
    }
    const env = { GIT_INDEX_FILE: index }
    const skip = held.map((path) => `:(exclude,literal)${path}`)
    if (git(['add', '--all', '--', '.', ...skip], env) === null) return null
    return git(['write-tree'], env)?.trim() || null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The longest path a line names. */
const PATH_MAX = 200

/** Each UTF-16 unit of `text` as a JSON escape. */
const escaped = (text) =>
  text
    .split('')
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')

/**
 * A path as a code span, cut short. A teammate names files, so one with a
 * backtick, or a control, format or line-breaking character (which could end
 * the line, or hide or reorder what it says), is quoted as JSON instead, those
 * characters escaped. The same rule as a scheduled run's line (`quote` in
 * `schedules/router.ts`), except that those characters are escaped rather
 * than dropped, so the name still says which file it is.
 */
const shown = (path) => {
  const cut = path.length > PATH_MAX ? `${path.slice(0, PATH_MAX - 1)}…` : path
  if (!/[`\p{C}\p{Zl}\p{Zp}]/u.test(cut)) return `\`${cut}\``
  return JSON.stringify(cut).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, escaped)
}

function focusLine() {
  const context = readJson('.holi/state/context.local.json')
  if (typeof context?.focusedPath !== 'string' || context.focusedPath === '') return null
  const { startLine, endLine } = context.selection ?? {}
  const selected = !Number.isInteger(startLine)
    ? ''
    : startLine === endLine
      ? `selected line ${startLine}; `
      : `selected lines ${startLine}-${endLine}; `
  return `Focused note: ${shown(context.focusedPath)} (${selected}use \`Read\` to view its contents)`
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

/** What Holi's autosave holds back as too big to commit, as Holi lists it in
 *  `.holi/state/held-back.local.json`. Such a file differs from where every
 *  turn ended, so it would be named at every turn; it is left out of the tree
 *  (not hashed at every prompt) and of what is named. No file, or one that does
 *  not read, leaves nothing out. */
function heldBack() {
  const paths = readJson('.holi/state/held-back.local.json')?.paths
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p !== '') : []
}

const OBJECT_ID = /^[0-9a-f]{7,64}$/
/** Where each conversation's last turn left the vault, a file each, as the
 *  Stop hook (`turn-signal.mjs end`) saves them: the tree of Holi's settle
 *  commit when it made one in time, so files its transforms rewrote are not
 *  named, and otherwise the working tree as the agent left it. */
const TREES_DIR = '.holi/state/turn-trees'

const validConversation = (id) => typeof id === 'string' && /^[\w-]{1,128}$/.test(id)

/** Leave the conversation an empty file, the mark of a turn that has started
 *  and not reached a Stop. Atomic; false when it could not be written. */
function markTaken(id) {
  const file = join(root, TREES_DIR, `${id}.local.json`)
  const temp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(join(root, TREES_DIR), { recursive: true })
    writeFileSync(temp, '{}\n')
    renameSync(temp, file)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The folder itself is unusable, so there is nothing to clean up.
    }
    return false
  }
}

/** Take the tree out of the conversation's file and answer it. Null when the
 *  file holds none, or could not be emptied (a tree left in it would be
 *  counted from again); undefined when the conversation has no file. */
function takeTree(id) {
  if (!validConversation(id)) return undefined
  const file = join(root, TREES_DIR, `${id}.local.json`)
  if (!existsSync(file)) return undefined
  const tree = readJson(join(TREES_DIR, `${id}.local.json`))?.tree
  if (typeof tree !== 'string' || !OBJECT_ID.test(tree)) return null
  return markTaken(id) ? tree : null
}

/**
 * Where this conversation's last turn ended: the tree the Stop hook saved for
 * it, or else the end of Holi's newest turn record for this job. Null when
 * there is neither, or when there is a file but no tree in it: the Stop hook
 * could not take one, or this prompt's turn never reached a Stop (an
 * interrupted one fires none). Counting from an older tree would name this
 * conversation's own latest edits. Either is used once: this prompt takes it
 * out, and the turn's Stop saves the next.
 */
function lastEnd(input) {
  const taken = takeTree(input?.session_id)
  if (taken !== undefined) return taken
  const turns = readJson('.holi/state/turns.local.json')
  // Newest first, so the first record naming this session is its last turn.
  const job = basename(jobDir)
  const end = Array.isArray(turns) ? turns.find((t) => t?.sessionId === job)?.end : undefined
  if (typeof end !== 'string' || !OBJECT_ID.test(end)) return null
  // No conversation id to mark leaves only the record to go by.
  return !validConversation(input?.session_id) || markTaken(input.session_id) ? end : null
}

function changesLine(input) {
  if (!jobDir) return null
  const end = lastEnd(input)
  if (end === null) return null

  // Everything between where the turn ended (the tree as the agent left it,
  // or Holi's settle commit) and the working tree now, committed or not.
  const held = heldBack()
  const now = worktreeTree(held)
  if (now === null) return null
  const changed = git(['diff-tree', '-r', '--name-only', '--no-renames', '-z', end, now, '--'])
  if (changed === null) return null
  const paths = changed
    .split('\0')
    .filter(Boolean)
    .filter(worthNaming)
    .filter((path) => !held.includes(path))
  if (paths.length === 0) return null

  const named = paths.slice(0, SHOWN).map(shown)
  const more = paths.length > SHOWN ? ` and ${paths.length - SHOWN} more` : ''
  return `Changed since your last turn, not by you: ${named.join(', ')}${more} (\`git diff ${end.slice(0, 12)}\` shows how)`
}

const input = await hookInput()
const lines = [focusLine(), changesLine(input)].filter(Boolean)
if (lines.length > 0) process.stdout.write(lines.join('\n'))
process.exit(0)
