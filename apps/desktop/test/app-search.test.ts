import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DocMeta } from '@holi/shared'
import { isSearchable, SEARCH_LIMIT, searchVault } from '../src/main/apps/app-search'

let root: string
let docs: DocMeta[]

async function note(path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), text)
  docs.push({ path, kind: 'note', updatedAt: '2026-09-30T00:00:00Z' } as DocMeta)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-search-'))
  docs = []
})

describe('searchVault', () => {
  it('lists name matches before body matches', async () => {
    await note('a.md', 'about the Budget for q3')
    await note('Budget.md', 'numbers')
    const hits = await searchVault(root, docs, 'budget', isSearchable)
    expect(hits.map((h) => [h.path, h.match])).toEqual([
      ['Budget.md', 'name'],
      ['a.md', 'body'],
    ])
    expect(hits[1]!.snippet).toContain('Budget')
  })

  it("never searches the agent surface or an app's records", async () => {
    await note('memory/budget.md', 'budget')
    await note('AGENTS.md', 'budget')
    await note('Fin.app/data/items/budget.md', 'budget')
    expect(await searchVault(root, docs, 'budget', isSearchable)).toEqual([])
  })

  it('stops at the limit', async () => {
    for (let i = 0; i < SEARCH_LIMIT + 5; i++) await note(`n${i}.md`, 'x budget')
    expect(await searchVault(root, docs, 'budget', isSearchable)).toHaveLength(SEARCH_LIMIT)
  })
})
