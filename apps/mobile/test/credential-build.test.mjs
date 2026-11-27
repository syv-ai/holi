import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'vitest'
import { snapshotCredentialSource } from '../scripts/credential-build.mjs'
import { runCommand } from '../scripts/host-checks.mjs'

const git = promisify(execFile)

test('archives committed build inputs from the mobile package directory', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'holi770-snapshot-'))
  try {
    const sourceHead = await runCommand('git', ['rev-parse', 'HEAD'], { cwd })
    const source = await snapshotCredentialSource({
      root,
      sourceHead,
      run: (_stage, exe, args, options) => runCommand(exe, args, { cwd, ...options }),
    })
    for (const path of ['pnpm-lock.yaml', 'apps/mobile/App_Resources/iOS/Info.plist']) {
      const { stdout } = await git('git', ['show', `${sourceHead}:${path}`], {
        cwd,
        encoding: 'buffer',
      })
      assert.deepEqual(await readFile(join(source, path)), stdout)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
