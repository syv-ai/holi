import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

afterEach(cleanupFixtures)

it('creates independent seeded remotes, including after fixture cleanup', async () => {
  const first = await makeRemote()
  const clone = await makeClone(first)
  expect(await readFile(join(clone, '.holi/vault'), 'utf8')).toBe('1\n')
  await writeFile(join(clone, 'README.md'), 'changed\n')
  await plainGit(clone, ['add', 'README.md'])
  await plainGit(clone, ['commit', '-m', 'change first remote'])
  await plainGit(clone, ['push', 'origin', 'main'])

  const second = await makeRemote()
  expect(await plainGit(second, ['show', 'main:README.md'])).toBe('# Vault')
  expect(await plainGit(first, ['show', 'main:README.md'])).toBe('changed')
  await cleanupFixtures()

  const third = await makeRemote()
  expect(await plainGit(third, ['show', 'main:README.md'])).toBe('# Vault')
})
