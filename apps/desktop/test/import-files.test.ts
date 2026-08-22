/**
 * Bringing a file in from outside the vault (`prd/notes-editor.md` FR-13).
 *
 * A vault is a folder, so importing is a copy — but it is the one write whose
 * *source* is not the vault, which makes it the one place a name can arrive
 * that the vault already uses, and the one place a binary arrives by accident.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { importFiles } from '../src/main/vault/import-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})
async function scratch(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

describe('importFiles', () => {
  it('copies a file in under the folder it was dropped on', async () => {
    const root = await scratch('holi-vault-')
    const outside = await scratch('holi-outside-')
    await writeFile(join(outside, 'notes.md'), '# From elsewhere\n', 'utf8')

    const result = await importFiles(root, [join(outside, 'notes.md')], 'inbox')

    expect(result.imported).toEqual(['inbox/notes.md'])
    expect(await readFile(join(root, 'inbox/notes.md'), 'utf8')).toBe('# From elsewhere\n')
  })

  it('refuses to land on a name the vault already uses', async () => {
    // The vault's standing rule (FR-11): reject a colliding destination rather
    // than overwrite. A drop is the easiest way to hit one — the source name is
    // chosen by whatever folder the file came from, not by the person dropping.
    const root = await scratch('holi-vault-')
    const outside = await scratch('holi-outside-')
    await writeFile(join(root, 'notes.md'), 'mine\n', 'utf8')
    await writeFile(join(outside, 'notes.md'), 'theirs\n', 'utf8')

    const result = await importFiles(root, [join(outside, 'notes.md')], '')

    expect(result.imported).toEqual([])
    expect(result.skipped).toEqual([{ name: 'notes.md', reason: 'a file of that name is here' }])
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('mine\n')
  })

  it('imports what it can and reports the rest', async () => {
    // One bad name in a multi-file drop must not cost the others. Dropping six
    // files and getting nothing because the fourth clashed is the behaviour
    // people work around by dropping one at a time.
    const root = await scratch('holi-vault-')
    const outside = await scratch('holi-outside-')
    await writeFile(join(root, 'clash.md'), 'mine\n', 'utf8')
    await writeFile(join(outside, 'clash.md'), 'theirs\n', 'utf8')
    await writeFile(join(outside, 'fresh.md'), 'new\n', 'utf8')

    const result = await importFiles(
      root,
      [join(outside, 'clash.md'), join(outside, 'fresh.md')],
      '',
    )

    expect(result.imported).toEqual(['fresh.md'])
    expect(result.skipped.map((s) => s.name)).toEqual(['clash.md'])
  })

  it('says what happened when a folder is dropped in', async () => {
    // Dragging a folder from Finder is an ordinary thing to try, and the raw
    // failure is `EISDIR` — a code, shown to a person, for something they did
    // on purpose. Recursing is a feature; saying so is the minimum.
    const root = await scratch('holi-vault-')
    const outside = await scratch('holi-outside-')
    await mkdir(join(outside, 'a-folder'))

    const result = await importFiles(root, [join(outside, 'a-folder')], '')

    expect(result.imported).toEqual([])
    expect(result.skipped).toEqual([
      { name: 'a-folder', reason: 'folders are not imported yet' },
    ])
  })

  it('copies bytes, not text — an image survives the trip', async () => {
    // The one import that a text copy silently corrupts. `copyNotes` reads utf8
    // because everything it moves is already in the vault and already text;
    // this is the door binaries come through.
    const root = await scratch('holi-vault-')
    const outside = await scratch('holi-outside-')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe])
    await writeFile(join(outside, 'logo.png'), png)

    await importFiles(root, [join(outside, 'logo.png')], 'assets')

    expect(await readFile(join(root, 'assets/logo.png'))).toEqual(png)
  })
})
