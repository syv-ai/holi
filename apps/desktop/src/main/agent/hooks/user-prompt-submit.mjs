#!/usr/bin/env node
// Holi UserPromptSubmit hook — injects the ONE piece of per-turn state the agent
// cannot discover itself: the note the user has focused in the editor. Tasks,
// backreferences and sync state the agent finds with its own native tools
// (Glob/grep/git); vault conventions and memory guidance live in AGENTS.md.
// See prd/agent.md §Per-turn context.
//
// Pure local read (<50 ms): Holi's main process keeps `.holi/context.local.json`
// current, so this never talks to a server. Outside Holi — or with nothing
// focused — the file is absent and it prints nothing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()

let context = null
try {
  context = JSON.parse(readFileSync(join(root, '.holi/context.local.json'), 'utf8'))
} catch {
  // no editor context (bare CLI, or nothing focused yet) — print nothing
}

if (context?.focusedPath) {
  process.stdout.write(`Focused note: \`${context.focusedPath}\` (use \`Read\` to view its contents)`)
}
process.exit(0)
