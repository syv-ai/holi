/**
 * Writing vault content OUT to a folder on disk — the replacement for the drag
 * to Finder that macOS refuses (`prd/notes-editor.md` FR-13).
 *
 * The mirror of `import-files.ts`, and it differs in exactly one decided way:
 * a name already in use is auto-renamed rather than refused. Importing protects
 * the vault, so it refuses; exporting writes to the user's own disk, where
 * getting a second copy is the useful answer and losing the first is not.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportFiles } from '../src/main/vault/export-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe('exportFiles', () => {
  it('copies a file out and leaves the vault untouched', async () => {
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), '# Mine\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed).toEqual([{ from: 'note.md', to: join(dest, 'note.md') }])
    expect(result.failed).toEqual([])
    expect(await readFile(join(dest, 'note.md'), 'utf8')).toBe('# Mine\n')
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('# Mine\n')
  })

  it('copies a folder with everything under it', async () => {
    // A folder target keeps its shape. `import-files` refuses folders because
    // recursing INTO the vault needs a decision about what a folder of unknown
    // files means; going out, a folder is just a folder.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await mkdir(join(root, 'trip/day1'), { recursive: true })
    await writeFile(join(root, 'trip/day1/a.md'), 'a\n', 'utf8')

    const result = await exportFiles(root, ['trip'], dest)

    expect(result.failed).toEqual([])
    expect(await readFile(join(dest, 'trip/day1/a.md'), 'utf8')).toBe('a\n')
  })

  it('auto-renames rather than overwriting what is already there', async () => {
    // The one place Holi could destroy something git cannot recover, because
    // the destination is outside the vault.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), 'vault\n', 'utf8')
    await writeFile(join(dest, 'note.md'), 'theirs\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed).toEqual([{ from: 'note.md', to: join(dest, 'note copy.md') }])
    expect(await readFile(join(dest, 'note.md'), 'utf8')).toBe('theirs\n')
    expect(await readFile(join(dest, 'note copy.md'), 'utf8')).toBe('vault\n')
  })

  it('counts up when the copy is taken too', async () => {
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'note.md'), 'vault\n', 'utf8')
    await writeFile(join(dest, 'note.md'), 'one\n', 'utf8')
    await writeFile(join(dest, 'note copy.md'), 'two\n', 'utf8')

    const result = await exportFiles(root, ['note.md'], dest)

    expect(result.landed[0]?.to).toBe(join(dest, 'note copy 2.md'))
  })

  it('exports what it can and reports the rest', async () => {
    // One unreadable source must not cost the others — the same rule the import
    // follows, for the same reason.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')
    await writeFile(join(root, 'good.md'), 'ok\n', 'utf8')

    const result = await exportFiles(root, ['ghost.md', 'good.md'], dest)

    expect(result.landed.map((l) => l.from)).toEqual(['good.md'])
    expect(result.failed).toEqual([{ name: 'ghost.md', reason: 'could not be copied (ENOENT)' }])
  })

  it('refuses a path that climbs out of the vault', async () => {
    // `safe()` guards the router, but this function is also the thing a future
    // caller reaches for, and a traversal here would read any file on disk.
    const root = await scratch('holi-vault-')
    const dest = await scratch('holi-dest-')

    await expect(exportFiles(root, ['../../etc/hosts'], dest)).rejects.toThrow()
  })
})
