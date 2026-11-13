import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installHoliCli } from '../src/main/bridge/cli'
import { installGitHook } from '../src/main/vault/large-files'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it.each(['darwin', 'linux'] as const)(
  'preserves baseline POSIX helper bytes on %s',
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'holi helper bytes '))
    dirs.push(root)
    const cli = await installHoliCli(root, platform)
    await installGitHook(root, 1024, platform)
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
    const normalized = (await readFile(cli, 'utf8')).replace(
      quote(join(root, 'cli-endpoint.json')),
      quote('/holi baseline user data/cli-endpoint.json'),
    )
    // Golden byte digests of the generators at 74b834df, before Windows changes.
    expect(createHash('sha256').update(normalized).digest('hex')).toBe(
      '3f9999f036c106072db311c25374dceba6184935a4e915febcf9ddf173bb863e',
    )
    expect(
      createHash('sha256')
        .update(await readFile(join(root, '.git/hooks/pre-commit')))
        .digest('hex'),
    ).toBe('a849dab5c0ebd9e0bfd026b81f042538922a60c195db7a4ff8e7344d2913951b')
  },
)
