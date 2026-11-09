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
// It never fails the turn and prints nothing else: anything written to stdout
// from a UserPromptSubmit hook is injected into Claude's context. Outside Holi,
// in a session that is not a background one, or with Holi closed, it sends
// nothing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const edge = process.argv[2]
const jobDir = process.env.CLAUDE_JOB_DIR
const ROUTES = { session: '/session', start: '/turn/start', end: '/turn/end' }

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

/** The vault this runs in: the nearest folder up holding `.holi/vault`. */
function vaultRoot() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.holi/vault'))) return dir
    if (dirname(dir) === dir) return null
  }
}

async function main() {
  if (!Object.hasOwn(ROUTES, edge ?? '') || !jobDir) return
  const root = vaultRoot()
  if (root === null) return
  const input = edge === 'start' ? null : await hookInput()
  if (edge === 'session') {
    try {
      noteJob(root, input)
    } catch {
      // Never at the cost of telling Holi where the session takes messages.
    }
  }
  const env = Object.create(null)
  for (const line of readFileSync(join(root, '.holi/state/bridge.local.env'), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  const { HOLI_BRIDGE_PORT: port, HOLI_BRIDGE_TOKEN: token } = env
  if (!/^\d+$/.test(port ?? '') || !/^[0-9a-f]+$/.test(token ?? '')) return
  const query = new URLSearchParams({ t: token, job: basename(jobDir) })
  if (edge === 'end') {
    const pending = pendingOf(input)
    if (pending !== null) query.set('pending', String(pending))
  }
  const { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: inboxToken } =
    process.env
  const body =
    edge !== 'end' && socket && inboxToken
      ? JSON.stringify({ socket, token: inboxToken })
      : undefined
  if (edge === 'session' && body === undefined) return
  await fetch(`http://127.0.0.1:${port}${ROUTES[edge]}?${query}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    signal: AbortSignal.timeout(2000),
  })
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
