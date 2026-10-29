import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { vaultRelPath } from '@holi/shared'
import { fileCards } from '../src/main/vault/file-cards'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-file-cards-'))
  await mkdir(join(root, 'Projects'))
  await writeFile(
    join(root, 'Projects/Roadmap.md'),
    '---\ndescription: What ships.\ntags: [q4]\n---\n# Roadmap\n\nNow and next.\n',
  )
  await writeFile(join(root, 'Projects/logo.png'), Buffer.alloc(1234))
})
afterEach(() => rm(root, { recursive: true, force: true }))

test('a note gets its summary and last commit; another file its size only', async () => {
  const cards = await fileCards(
    root,
    ['Projects/Roadmap.md', 'Projects/logo.png'].map(vaultRelPath),
    async (path) => (path.endsWith('.md') ? { date: '2026-10-20T10:00:00Z', author: 'Ada' } : null),
  )
  expect(cards[0]).toMatchObject({
    path: 'Projects/Roadmap.md',
    last: { author: 'Ada' },
    note: { description: 'What ships.', tags: ['q4'] },
  })
  expect(cards[1]).toMatchObject({ path: 'Projects/logo.png', size: 1234, last: null })
  expect(cards[1]?.note).toBeUndefined()
})

test('a file that has gone and a git that fails still answer, in order', async () => {
  const cards = await fileCards(
    root,
    ['Projects/gone.md', 'Projects/Roadmap.md'].map(vaultRelPath),
    () => Promise.reject(new Error('git broke')),
  )
  expect(cards.map((c) => c.path)).toEqual(['Projects/gone.md', 'Projects/Roadmap.md'])
  expect(cards[0]).toMatchObject({ size: 0, last: null })
  expect(cards[1]?.note?.description).toBe('What ships.')
})
