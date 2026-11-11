/**
 * The meetings' own reads of the vault, on real files: how much of a
 * transcript is read to know it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readVaultHead } from '../main/vault-write'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

describe('readVaultHead', () => {
  it('reads far enough to find an old placeholder past a long title in any script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-head-'))
    dirs.push(root)
    await mkdir(join(root, 'Old.meeting'))
    const title = '会議'.repeat(60)
    await writeFile(
      join(root, 'Old.meeting/transcript.local.md'),
      `# ${title}\n\nNot recorded yet: open this meeting and press Record.\n`,
    )
    expect(await readVaultHead(root, 'Old.meeting/transcript.local.md')).toContain(
      'Not recorded yet',
    )
  })

  it('is null for a file that is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-head-'))
    dirs.push(root)
    expect(await readVaultHead(root, 'none.meeting/transcript.local.md')).toBeNull()
  })
})
