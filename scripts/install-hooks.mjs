// Writes the git hooks into the repository's hooks folder. Run by `prepare` on every
// `pnpm install`.
//
// The folder is shared by every worktree of the repository (`git rev-parse
// --git-common-dir`), and worktrees may be on older branches without rulecast or the
// commit-message check, so each hook skips a tool the checked-out branch does not have
// (docs/refactor/design-decisions.md). A worktree without `node_modules` cannot run
// lint-staged at all, so the pre-commit hook says so instead of failing on a missing
// command. `HOLI_SKIP_HOOKS=1` skips both hooks.
//
// A `core.hooksPath` set for this repository wins over `.git/hooks`, so the hooks go
// there. A global one is left alone (it is someone's personal hooks folder) and the
// script says that git will not run these hooks here.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HOOKS = {
  'pre-commit': `[ -d node_modules ] || { echo 'pre-commit: no node_modules; run pnpm install, or set HOLI_SKIP_HOOKS=1 to skip the hooks' >&2; exit 1; }
pnpm exec lint-staged && { test ! -f .rulecast-config.yaml || pnpm exec rulecast run; }`,
  'commit-msg': `test ! -f scripts/check-commit-msg.mjs || node scripts/check-commit-msg.mjs "$1"`,
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// `git config --get` exits 1 when the key is unset; anything else is a real error.
const gitConfig = (...args) => {
  try {
    return git('config', ...args)
  } catch (error) {
    if (error.status === 1 && !error.stderr) return ''
    throw error
  }
}

let dir
try {
  const common = git('rev-parse', '--git-common-dir')
  const local = gitConfig('--local', '--get', 'core.hooksPath')
  if (local) {
    dir = resolve(git('rev-parse', '--show-toplevel'), local)
  } else {
    const global = gitConfig('--get', 'core.hooksPath')
    if (global) {
      console.warn(
        `install-hooks: core.hooksPath is ${global}, so git ignores .git/hooks here; the hooks were not installed`,
      )
      process.exit(0)
    }
    dir = resolve(common, 'hooks')
  }
} catch (error) {
  if (error.code === 'ENOENT') {
    console.warn('install-hooks: git not found; the hooks were not installed')
    process.exit(0)
  }
  if (/not a git repository/.test(error.stderr ?? '')) process.exit(0) // a tarball install
  console.warn(
    `install-hooks: ${(error.stderr ?? error.message).trim()}; the hooks were not installed`,
  )
  process.exit(0)
}

try {
  mkdirSync(dir, { recursive: true })
  for (const [name, command] of Object.entries(HOOKS)) {
    const file = join(dir, name)
    writeFileSync(
      file,
      `#!/bin/sh\n# Written by scripts/install-hooks.mjs; edit that file, not this one.\n[ "$HOLI_SKIP_HOOKS" = "1" ] && exit 0\n${command}\n`,
    )
    chmodSync(file, 0o755)
  }
  console.log(`install-hooks: wrote ${Object.keys(HOOKS).join(' and ')} to ${dir}`)
} catch (error) {
  console.warn(`install-hooks: ${error.message}; the hooks were not installed`)
}
