#!/usr/bin/env node
// Holi PreToolUse hook: refuse writes to `.holi/memory/index.md`.
//
// The memory-index transform regenerates that file on every commit, so an edit
// to it is always lost. Refusing it here tells the agent why and where to write
// instead; the transform would discard it silently. See
// docs/features/agent-memory.md.
//
// Silent on every other file. Dependency-free, like the hooks beside it.

import { resolve } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd()
const INDEX = resolve(root, '.holi/memory/index.md')

function readStdin() {
  return new Promise((done) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => done(text))
    process.stdin.on('error', () => done(''))
  })
}

let payload = null
try {
  payload = JSON.parse(await readStdin())
} catch {
  // Not a payload we understand: stay out of the way.
}

const filePath = payload?.tool_input?.file_path
if (typeof filePath === 'string' && resolve(root, filePath) === INDEX) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          '.holi/memory/index.md is generated from the memory files on every commit, so an edit ' +
          'here is discarded. Write or edit the memory file itself (.holi/memory/<name>.md) instead.',
      },
    }),
  )
}
// Always 0: a non-zero exit is a hook error, not a decision.
process.exit(0)
