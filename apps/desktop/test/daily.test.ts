import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDailyNoteContent } from '@holi/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { getOrCreateDaily, sweepDaily } from '../src/main/vault/daily'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-daily-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}
const exists = (root: string, rel: string) =>
  readFile(join(root, rel), 'utf8').then(
    () => true,
    () => false,
  )

const TODAY = '2026-07-21' // stem 21-07-2026

describe('getOrCreateDaily', () => {
  it('creates today’s note with the deterministic seed when absent', async () => {
    const root = await vault({})
    const r = await getOrCreateDaily(root, TODAY)
    expect(r).toEqual({ path: '21-07-2026.md', created: true })
    expect(await readFile(join(root, '21-07-2026.md'), 'utf8')).toBe(buildDailyNoteContent(TODAY))
  })

  it('returns the existing note without rewriting it', async () => {
    const root = await vault({ '21-07-2026.md': buildDailyNoteContent(TODAY) })
    expect(await getOrCreateDaily(root, TODAY)).toEqual({ path: '21-07-2026.md', created: false })
  })
})

describe('sweepDaily', () => {
  it('deletes untouched unreferenced stubs, archives the rest, leaves today and non-dailies', async () => {
    const root = await vault({
      '20-07-2026.md': buildDailyNoteContent('2026-07-20'), // untouched, unreferenced → delete
      '19-07-2026.md': buildDailyNoteContent('2026-07-19') + 'real notes\n', // has body → archive
      '18-07-2026.md': buildDailyNoteContent('2026-07-18'), // untouched BUT referenced → archive
      '21-07-2026.md': buildDailyNoteContent(TODAY), // today → leave
      '31-12-1999.md': 'just a note that looks like a date\n', // no daily frontmatter → leave
      'ref.md': 'anchored to [[18-07-2026.md]]',
    })

    expect(await sweepDaily(root, TODAY)).toEqual({ archived: 2, deleted: 1 })

    expect(await exists(root, '20-07-2026.md')).toBe(false) // deleted stub
    expect(await exists(root, 'journal/19-07-2026.md')).toBe(true) // archived
    expect(await exists(root, 'journal/18-07-2026.md')).toBe(true) // archived, not deleted (backref)
    expect(await readFile(join(root, 'ref.md'), 'utf8')).toBe('anchored to [[journal/18-07-2026.md]]')
    expect(await exists(root, '21-07-2026.md')).toBe(true) // today left at root
    expect(await exists(root, '31-12-1999.md')).toBe(true) // hand-authored, untouched
  })

  it('is a no-op on a re-run', async () => {
    const root = await vault({
      '20-07-2026.md': buildDailyNoteContent('2026-07-20'),
      '21-07-2026.md': buildDailyNoteContent(TODAY),
    })
    await sweepDaily(root, TODAY)
    expect(await sweepDaily(root, TODAY)).toEqual({ archived: 0, deleted: 0 })
  })
})
