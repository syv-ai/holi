import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createFixtureSession } from '../scripts/agent-inbox-550-session'

const supportsPosixOwnership = process.platform !== 'win32' && typeof process.getuid === 'function'

const owned: string[] = []
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi550-profile-')))
  owned.push(root)
  return root
}
afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true })
})

test.skipIf(!supportsPosixOwnership)(
  'loads an authenticated fixture session from its owned encrypted store',
  async () => {
    const session = await createFixtureSession(await directory())
    expect(session.viewer).not.toBeNull()
    expect(session.token()).not.toBeNull()
  },
)

test.skipIf(!supportsPosixOwnership)(
  'refuses a linked profile without replacing external credentials',
  async () => {
    const root = await directory()
    const external = await directory()
    const credentials = join(external, 'github-auth.enc')
    await writeFile(credentials, 'existing external credentials')
    await symlink(external, join(root, 'user-data'), 'dir')
    await expect(createFixtureSession(root)).rejects.toThrow()
    expect(await readFile(credentials, 'utf8')).toBe('existing external credentials')
  },
)
