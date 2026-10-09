#!/usr/bin/env node
// Holi turn-signal hook: tells the running Holi app that a turn in one of
// this vault's Claude Code background sessions started or ended, so it can pause
// sync while the agent works. Usage: turn-signal.mjs start|end
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
// It never fails the turn and never prints: anything written to stdout from a
// UserPromptSubmit hook is injected into Claude's context. Outside Holi, in a
// session that is not a background one, or with Holi closed, it does nothing.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const edge = process.argv[2]
const jobDir = process.env.CLAUDE_JOB_DIR

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

/** The vault this runs in: the nearest folder up holding `.holi/vault`. */
function vaultRoot() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.holi/vault'))) return dir
    if (dirname(dir) === dir) return null
  }
}

async function main() {
  if ((edge !== 'start' && edge !== 'end') || !jobDir) return
  const root = vaultRoot()
  if (root === null) return
  const env = Object.create(null)
  for (const line of readFileSync(join(root, '.holi/state/bridge.local.env'), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  const { HOLI_BRIDGE_PORT: port, HOLI_BRIDGE_TOKEN: token } = env
  if (!/^\d+$/.test(port ?? '') || !/^[0-9a-f]+$/.test(token ?? '')) return
  const query = new URLSearchParams({ t: token, job: basename(jobDir) })
  if (edge === 'end') {
    const pending = pendingOf(await hookInput())
    if (pending !== null) query.set('pending', String(pending))
  }
  await fetch(`http://127.0.0.1:${port}/turn/${edge}?${query}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  })
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
