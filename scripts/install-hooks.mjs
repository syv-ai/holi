// Writes the git hooks into the repository's shared hooks folder. Run by `prepare`
// on every `pnpm install`.
//
// The folder is shared by every worktree of the repository (`git rev-parse
// --git-common-dir`), and worktrees may be on older branches without rulecast or the
// commit-message check, so each hook skips a tool the checked-out branch does not have
// (docs/refactor/design-decisions.md, D19). `HOLI_SKIP_HOOKS=1` skips both hooks.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const HOOKS = {
  'pre-commit': `pnpm exec lint-staged && { test ! -f .rulecast-config.yaml || pnpm exec rulecast run; }`,
  'commit-msg': `test ! -f scripts/check-commit-msg.mjs || node scripts/check-commit-msg.mjs "$1"`,
}

let common
try {
  common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()
} catch {
  // Not a git checkout (a tarball install): nothing to hook.
  process.exit(0)
}
const dir = join(isAbsolute(common) ? common : join(process.cwd(), common), 'hooks')
mkdirSync(dir, { recursive: true })
for (const [name, command] of Object.entries(HOOKS)) {
  const file = join(dir, name)
  writeFileSync(
    file,
    `#!/bin/sh\n# Written by scripts/install-hooks.mjs; edit that file, not this one.\n[ "$HOLI_SKIP_HOOKS" = "1" ] && exit 0\n${command}\n`,
  )
  chmodSync(file, 0o755)
}
