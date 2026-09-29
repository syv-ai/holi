#!/usr/bin/env node
// Holi turn-signal hook: tells the running Holi app that a turn in one of
// this vault's Claude Code background sessions started or ended, so it can pause
// sync while the agent works. Usage: turn-signal.mjs start|end
//
// Where Holi is: `$CLAUDE_CONFIG_DIR/holi.env`, which Holi rewrites each time it
// opens the vault. Not the environment: a background session's environment comes
// from Claude Code's supervisor, which may have been started long before this
// Holi was. Which session: the short job id, the name of `$CLAUDE_JOB_DIR`.
//
// It never fails the turn and never prints: anything written to stdout from a
// UserPromptSubmit hook is injected into Claude's context. Outside Holi, in a
// session that is not a background one, or with Holi closed, it does nothing.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const edge = process.argv[2]
const configDir = process.env.CLAUDE_CONFIG_DIR
const jobDir = process.env.CLAUDE_JOB_DIR

async function main() {
  if ((edge !== 'start' && edge !== 'end') || !configDir || !jobDir) return
  const env = {}
  for (const line of readFileSync(join(configDir, 'holi.env'), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  const { HOLI_HOOK_PORT: port, HOLI_HOOK_TOKEN: token } = env
  if (!/^\d+$/.test(port ?? '') || !token) return
  const query = new URLSearchParams({ t: token, job: basename(jobDir) })
  await fetch(`http://127.0.0.1:${port}/turn/${edge}?${query}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2000),
  })
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
