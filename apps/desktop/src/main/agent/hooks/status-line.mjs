#!/usr/bin/env node
// Holi status line: prints this session's footer, the model and how much
// of its context window is used, and tells the running Holi app the same, so the
// session's row in the sidebar can show it.
//
// Claude Code hands it its status JSON on stdin. The footer is printed from that
// JSON here, so it reads the same in any Claude Code, with or without Holi.
//
// Where Holi is: `$CLAUDE_CONFIG_DIR/holi.env`, which Holi rewrites each time it
// opens the vault. Which session: the short job id, the name of `$CLAUDE_JOB_DIR`.
// Outside Holi, in a session that is not a background one, or with Holi closed,
// it only prints the footer. It never fails.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

function footer(status) {
  const model = status?.model?.display_name
  const used = status?.context_window?.used_percentage
  const parts = []
  if (typeof model === 'string' && model !== '') parts.push(model)
  if (typeof used === 'number' && Number.isFinite(used)) parts.push(`${Math.round(used)}% context`)
  return parts.join(' · ')
}

async function report(body) {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  const jobDir = process.env.CLAUDE_JOB_DIR
  if (!configDir || !jobDir) return
  const env = {}
  for (const line of readFileSync(join(configDir, 'holi.env'), 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  const { HOLI_HOOK_PORT: port, HOLI_HOOK_TOKEN: token } = env
  if (!/^\d+$/.test(port ?? '') || !token) return
  const query = new URLSearchParams({ t: token, job: basename(jobDir) })
  await fetch(`http://127.0.0.1:${port}/statusline?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(1000),
  })
}

async function main() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  let status = null
  try {
    status = JSON.parse(text)
  } catch {
    return
  }
  // The footer first: Holi being slow or gone must never hold it up.
  process.stdout.write(footer(status))
  await report(text)
}

// No `process.exit`: on macOS a write to a pipe completes asynchronously, and
// exiting at once can lose the footer. The fetch timeout bounds the wait.
main().catch(() => {})
