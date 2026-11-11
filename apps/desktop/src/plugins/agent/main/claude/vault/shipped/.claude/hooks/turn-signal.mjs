#!/usr/bin/env node
// Holi turn-signal hook: tells the running Holi app that a turn in one of
// this vault's Claude Code background sessions started or ended, so it can pause
// sync while the agent works. Usage: turn-signal.mjs session|start|end
//
// At `session` (SessionStart) and `start` it also hands Holi where the session
// takes messages: the inbox socket and token Claude Code exports to its hooks
// as CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN, so Holi can
// add a message to this session while it runs. Holi keeps them in memory only.
// A session without them (`--bare`, an older Claude Code) sends none.
//
// Where Holi is: `.holi/state/bridge.local.env` at the vault's root, found by
// walking up from the current directory to the folder holding `.holi/vault`.
// Holi writes it when it opens the vault and deletes it when it leaves. Not the
// environment: a background session's environment comes from Claude Code's
// supervisor, which may have been started long before this Holi was. Read key
// by key and checked, never evaluated. Which session: the short job id, the
// name of `$CLAUDE_JOB_DIR`.
//
// At `end` it also says whether the session is done or only paused: Claude
// Code's Stop input lists the `background_tasks` still in flight and the
// `session_crons` still scheduled, empty when nothing is, which is how its
// hooks reference says to tell the two apart. Sent as `pending`, their count;
// left out when the input carries neither list.
//
// At `session` it also notes which job folder the conversation runs in, in
// `.holi/state/jobs.local.json` by the conversation's id. A conversation
// resumed into another job gets a new `$CLAUDE_JOB_DIR`, and its scratch files
// stay in the old one, so at a `resume` start whose folder moved it prints one
// line saying so, and where the old one is if it is still there. That line,
// which SessionStart adds to Claude's context, is the only thing it prints.
//
// At `end` it also saves where the turn left the vault, in
// `.holi/state/turn-trees/<session_id>.local.json` (`session_id` is in the
// input, and a resume keeps it): the prompt hook (`user-prompt-submit.mjs`)
// names what changed since then, not by this conversation. Holi answers
// `/turn/end` with the tree of the settle commit it made for the turn, once it
// has made it, and that is what is saved: the commit's transforms (the memory
// index, markdown normalising) rewrite files the agent touched, and those are
// the agent's work as Holi stored it. Otherwise (Holi closed, another session
// still working, nothing to commit, no answer within `SETTLE_WAIT_MS`) it saves
// the working tree as it took it before telling Holi: taken after, it could
// hold a pull the resumed sync brought in, which would then never be named.
// When git fails too, the file holds no `tree` and the prompt hook names
// nothing, rather than diffing against an older tree that would hold back none
// of this turn's own edits. One file per conversation, the newest `TREES_KEPT`
// kept. A conversation's Stop and its next prompt run one after the other, so
// nothing else writes its file meanwhile.
//
// At `start` it also sends `pid`, the session's own `claude` process
// (`$CLAUDE_PID`, or this hook's parent on an older CLI). Holi checks it is still
// alive before it gives up on a working session the listing has lost sight of.
//
// It never fails the turn and prints nothing else: anything written to stdout
// from a UserPromptSubmit hook is injected into Claude's context. Outside Holi, or in
// a session that is not a background one, it does nothing; with Holi closed,
// `end` only saves the turn's tree.

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const edge = process.argv[2]
const jobDir = process.env.CLAUDE_JOB_DIR
const ROUTES = { session: '/session', start: '/turn/start', end: '/turn/end' }

/** Where each conversation's last turn left the vault, a file each. The prompt
 *  hook reads the same names. */
const TREES_DIR = '.holi/state/turn-trees'
/** How many conversations it remembers. */
const TREES_KEPT = 100
/** How long `end` waits for Holi's settle commit. That commit runs the
 *  pre-commit transforms (shrinking an image can take a second or two), and
 *  one that finds a pull in flight is asked again a second later: a few
 *  seconds covers both. Longer would hold the session's Stop for nothing
 *  while Holi is stuck, when the hook's own tree is a fair answer. */
const SETTLE_WAIT_MS = 5000
const OBJECT_ID = /^[0-9a-f]{7,64}$/

/** The hook's input JSON, or null. Bounded: a stdin that never ends must not
 *  hold the turn. */
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

/** How much the Stop input says is still in flight or scheduled, or null when
 *  it does not say. */
function pendingOf(input) {
  if (input === null || typeof input !== 'object') return null
  const tasks = input.background_tasks
  const crons = input.session_crons
  if (!Array.isArray(tasks) && !Array.isArray(crons)) return null
  return (Array.isArray(tasks) ? tasks.length : 0) + (Array.isArray(crons) ? crons.length : 0)
}

/** Where each conversation last ran: `{ conversation, job }`, newest first. */
const JOBS_FILE = '.holi/state/jobs.local.json'
const JOBS_KEPT = 100

/** Record this conversation's job folder; at a resume into a different one,
 *  say so. Best-effort: a lost record only loses the line. */
function noteJob(root, input) {
  const conversation = input?.session_id
  if (typeof conversation !== 'string' || !/^[\w-]{1,128}$/.test(conversation)) return
  const file = join(root, JOBS_FILE)
  let jobs = []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    // A path with a control character could end the line it is printed in.
    const plain = (j) => typeof j?.job === 'string' && !/\p{C}/u.test(j.job)
    if (Array.isArray(parsed)) jobs = parsed.filter(plain)
  } catch {
    // None yet, or unreadable: start over.
  }
  const previous = jobs.find((j) => j.conversation === conversation)?.job
  if (input.source === 'resume' && previous !== undefined && previous !== jobDir) {
    process.stdout.write(
      existsSync(previous)
        ? `This conversation was resumed in a new job folder: $CLAUDE_JOB_DIR is now ${jobDir}. Files from before the resume are still in ${previous}.`
        : `This conversation was resumed in a new job folder: $CLAUDE_JOB_DIR is now ${jobDir}. The one before it is gone.`,
    )
  }
  const next = [{ conversation, job: jobDir }, ...jobs.filter((j) => j.conversation !== conversation)]
  mkdirSync(dirname(file), { recursive: true })
  // Through a rename: two sessions starting at once must not leave a torn
  // file, which the next start would read as none and so forget every note.
  const scratch = `${file}.${process.pid}`
  writeFileSync(scratch, `${JSON.stringify(next.slice(0, JOBS_KEPT), null, 2)}\n`)
  renameSync(scratch, file)
}

/** Plumbing output, or null when git fails. Never takes `.git/index.lock`. */
function git(root, args, env) {
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

/** What Holi's autosave holds back as too big to commit, as Holi lists it in
 *  `.holi/state/held-back.local.json`: left out of the tree, as the settle
 *  commit leaves them out, and not hashed at every turn. */
function heldBack(root) {
  try {
    const paths = JSON.parse(
      readFileSync(join(root, '.holi/state/held-back.local.json'), 'utf8'),
    )?.paths
    return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p !== '') : []
  } catch {
    return []
  }
}

/** The working tree as a tree object, through a scratch copy of the index so
 *  the real one is untouched; ignored and held-back files left out. The copy
 *  keeps the real index's times, as Holi's `worktree-end.ts` does: a fresher
 *  one would make git trust the cached stat of a file edited in the same
 *  instant, and miss a same-size edit. A copy of `worktreeTree` in
 *  `user-prompt-submit.mjs`, since each hook reaches a vault on its own. */
function worktreeTree(root) {
  const dir = mkdtempSync(join(tmpdir(), 'holi-stop-'))
  try {
    const index = join(dir, 'index')
    const real = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim()
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
    const skip = heldBack(root).map((path) => `:(exclude,literal)${path}`)
    if (git(root, ['add', '--all', '--', '.', ...skip], env) === null) return null
    return git(root, ['write-tree'], env)?.trim() || null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Save `tree` as the conversation's file, or a file without one when there
 *  is none. Written to a temporary file and renamed into place, so a reader
 *  never sees half of it; then all but the newest `TREES_KEPT` go. Best
 *  effort. */
function saveTree(root, id, tree) {
  const dir = join(root, TREES_DIR)
  const file = join(dir, `${id}.local.json`)
  const temp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temp, `${JSON.stringify(tree ? { tree } : {})}\n`)
    renameSync(temp, file)
    const saved = readdirSync(dir)
      .filter((name) => name.endsWith('.local.json'))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((x, y) => y.at - x.at)
    for (const old of saved.slice(TREES_KEPT)) rmSync(join(dir, old.name), { force: true })
  } catch {
    rmSync(temp, { force: true })
  }
}

/** The vault this runs in: the nearest folder up holding `.holi/vault`. */
function vaultRoot() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.holi/vault'))) return dir
    if (dirname(dir) === dir) return null
  }
}

/** Holi's bridge port and token, or null when Holi is not open on the vault. */
function bridge(root) {
  const env = Object.create(null)
  try {
    const text = readFileSync(join(root, '.holi/state/bridge.local.env'), 'utf8')
    for (const line of text.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1).trim()
    }
  } catch {
    return null
  }
  const { HOLI_BRIDGE_PORT: port, HOLI_BRIDGE_TOKEN: token } = env
  if (!/^\d+$/.test(port ?? '') || !/^[0-9a-f]+$/.test(token ?? '')) return null
  return { port, token }
}

/** Tell Holi. At `end`, answers the settle commit's tree when Holi gives one. */
async function signal(root, input) {
  const holi = bridge(root)
  if (holi === null) return null
  const query = new URLSearchParams({ t: holi.token, job: basename(jobDir) })
  // Claude's own pid: the hook's parent is a short-lived wrapper under
  // CLAUDE_CODE_SHELL_PREFIX. A CLI older than the variable has neither.
  if (edge === 'start') {
    query.set('pid', /^[1-9]\d*$/.test(process.env.CLAUDE_PID ?? '') ? process.env.CLAUDE_PID : String(process.ppid))
  }
  const pending = edge === 'end' ? pendingOf(input) : null
  if (pending !== null) query.set('pending', String(pending))
  const { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: inboxToken } =
    process.env
  const body =
    edge !== 'end' && socket && inboxToken
      ? JSON.stringify({ socket, token: inboxToken })
      : undefined
  if (edge === 'session' && body === undefined) return null
  const res = await fetch(`http://127.0.0.1:${holi.port}${ROUTES[edge]}?${query}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    signal: AbortSignal.timeout(edge === 'end' ? SETTLE_WAIT_MS : 2000),
  })
  if (edge !== 'end' || res.status !== 200) return null
  const tree = (await res.json())?.tree
  return typeof tree === 'string' && OBJECT_ID.test(tree) ? tree : null
}

async function main() {
  if (!Object.hasOwn(ROUTES, edge ?? '') || !jobDir) return
  const root = vaultRoot()
  if (root === null) return
  if (edge !== 'end') {
    if (edge === 'session') {
      try {
        noteJob(root, await hookInput())
      } catch {
        // Never at the cost of telling Holi where the session takes messages.
      }
    }
    await signal(root, null)
    return
  }
  const input = await hookInput()
  const id = input?.session_id
  const conversation = typeof id === 'string' && /^[\w-]{1,128}$/.test(id) ? id : null
  const own = conversation === null ? null : worktreeTree(root)
  const settled = await signal(root, input).catch(() => null)
  if (conversation !== null) saveTree(root, conversation, settled ?? own)
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
