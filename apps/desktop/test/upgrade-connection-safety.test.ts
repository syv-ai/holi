import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('refuses the upgrade command outside a disposable hosted runner before creating resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-565-safety-test-'))
  try {
    const script = fileURLToPath(new URL('../scripts/run-connection-upgrade.mjs', import.meta.url))
    await expect(
      promisify(execFile)(process.execPath, [script], {
        env: { PATH: process.env.PATH, HOME: root, RUNNER_TEMP: root, GITHUB_ACTIONS: 'false' },
        timeout: 15_000,
      }),
    ).rejects.toMatchObject({ code: 1 })
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
