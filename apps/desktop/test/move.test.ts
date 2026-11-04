import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { moveNotes } from '../src/main/vault/move'
import { withFileLock, withFileLocks } from '../src/main/vault/vault-files'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-mv-'))
  dirs.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8')

describe('moveNotes', () => {
  it('runs beside a delete that holds a note linking to it, and both finish', async () => {
    const root = await vault({ 'c.md': 'see [[z.md]]', 'z.md': 'Z' })
    const rels = ['c.md', 'z.md'].map((p) => vaultRelPath(p))
    // A delete of both holds c.md, then waits for z.md, which the move holds.
    const removal = withFileLocks(root, rels, () => new Promise((r) => setTimeout(r, 50)))
    const move = moveNotes(root, [{ from: 'z.md', to: 'x/z.md' }])
    const stuck = new Promise((r) => setTimeout(() => r('stuck'), 2000))
    expect(await Promise.race([Promise.all([removal, move]).then(() => 'done'), stuck])).toBe(
      'done',
    )
  })

  it('runs beside another move of a note it links to, and both finish', async () => {
    const root = await vault({ 'a.md': 'see [[c.md]]', 'c.md': 'see [[a.md]]' })
    const both = Promise.all([
      moveNotes(root, [{ from: 'a.md', to: 'x/a.md' }]),
      moveNotes(root, [{ from: 'c.md', to: 'x/c.md' }]),
    ])
    const stuck = new Promise((r) => setTimeout(() => r('stuck'), 2000))
    expect(await Promise.race([both.then(() => 'done'), stuck])).toBe('done')
    expect(await read(root, 'x/a.md')).toBe('see [[x/c.md]]')
    expect(await read(root, 'x/c.md')).toBe('see [[x/a.md]]')
  })

  it('lets no writer that checks one moving file write another between the two', async () => {
    // A meeting's minutes are written only while its transcript is there.
    const root = await vault({ 'm/minutes.md': 'minutes', 'm/transcript.md': 'mine' })
    const key = async (rel: string) => (await exactPath(root, rel))!
    let release!: () => void
    const held = withFileLock(
      await key('m/transcript.md'),
      () => new Promise<void>((r) => (release = r)),
    )
    const move = moveNotes(root, [
      { from: 'm/minutes.md', to: 'n/minutes.md' },
      { from: 'm/transcript.md', to: 'n/transcript.md' },
    ])
    await new Promise((r) => setTimeout(r, 50))
    const write = withFileLock(await key('m/minutes.md'), async () => {
      if ((await readFile(join(root, 'm/transcript.md'), 'utf8').catch(() => null)) === null) return
      await writeFile(join(root, 'm/minutes.md'), 'written back')
    })
    release()
    await Promise.all([held, move, write])
    await expect(read(root, 'm/minutes.md')).rejects.toThrow()
    expect(await read(root, 'n/minutes.md')).toBe('minutes')
  })

  it('waits for a write that holds the file by its canonical path', async () => {
    const root = await vault({ 'old.md': 'body' })
    // On macOS the temp folder is reached through a link: the canonical path
    // and the one built from `root` differ, and the lock has to be the same.
    const key = (await exactPath(root, 'sub/new.md'))!
    let release!: () => void
    const held = withFileLock(key, () => new Promise<void>((r) => (release = r)))
    let moved = false
    const move = moveNotes(root, [{ from: 'old.md', to: 'sub/new.md' }]).then(() => (moved = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(moved).toBe(false)
    release()
    await held
    await move
    expect(await read(root, 'sub/new.md')).toBe('body')
  })

  it('a single move behaves exactly like a rename (file + inbound rewrite)', async () => {
    const root = await vault({
      'old.md': 'body',
      'ref.md': 'see [[old.md]] and [[old.md|Alias]]',
    })
    const { rewritten } = await moveNotes(root, [{ from: 'old.md', to: 'sub/new.md' }])
    expect(rewritten).toEqual([{ path: 'ref.md', count: 2 }])
    await expect(read(root, 'old.md')).rejects.toThrow()
    expect(await read(root, 'sub/new.md')).toBe('body')
    expect(await read(root, 'ref.md')).toBe('see [[sub/new.md]] and [[sub/new.md|Alias]]')
  })

  it('moves a whole folder, remapping inbound links to every file in it', async () => {
    const root = await vault({
      'projects/a.md': 'A',
      'projects/b.md': 'B',
      'index.md': '[[projects/a.md]] and [[projects/b.md]]',
    })
    await moveNotes(root, [
      { from: 'projects/a.md', to: 'work/a.md' },
      { from: 'projects/b.md', to: 'work/b.md' },
    ])
    expect(await read(root, 'work/a.md')).toBe('A')
    expect(await read(root, 'work/b.md')).toBe('B')
    expect(await read(root, 'index.md')).toBe('[[work/a.md]] and [[work/b.md]]')
  })

  it('rewrites a moved file’s OWN outbound link when its target also moved', async () => {
    // b.md links a.md, and both move in the same batch. b's own [[a.md]] must
    // land as [[x/a.md]] at b's new home — the map covers moved files too.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'see [[a.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'x/a.md' },
      { from: 'b.md', to: 'x/b.md' },
    ])
    expect(await read(root, 'x/b.md')).toBe('see [[x/a.md]]')
  })

  it('resolves a chain in one pass — a link to a shifted name is NOT double-rewritten', async () => {
    // a→b and b→c together. keep.md’s [[a.md]] must become [[b.md]] (a’s new
    // name), never [[c.md]]. Sequential renames would chain it to c.
    const root = await vault({
      'a.md': 'A',
      'b.md': 'B',
      'keep.md': 'to a: [[a.md]]  to b: [[b.md]]',
    })
    await moveNotes(root, [
      { from: 'a.md', to: 'b.md' },
      { from: 'b.md', to: 'c.md' },
    ])
    // a’s content is now at b.md; b’s content is now at c.md.
    expect(await read(root, 'b.md')).toBe('A')
    expect(await read(root, 'c.md')).toBe('B')
    expect(await read(root, 'keep.md')).toBe('to a: [[b.md]]  to b: [[c.md]]')
  })

  it('carries a non-markdown file across instead of deleting it', async () => {
    // The trap this exists to prevent: the link-rewrite pass only reads `.md`,
    // so a non-markdown file never reached the write list — while the removal
    // pass deleted every `from` unconditionally. A moved image was a deleted
    // image, with nothing at the destination.
    const root = await vault({
      'notes/logo.svg': '<svg/>',
      'notes/app.js': 'export const x = 1\n',
    })

    await moveNotes(root, [
      { from: 'notes/logo.svg', to: 'assets/logo.svg' },
      { from: 'notes/app.js', to: 'assets/app.js' },
    ])

    expect(await read(root, 'assets/logo.svg')).toBe('<svg/>')
    expect(await read(root, 'assets/app.js')).toBe('export const x = 1\n')
    await expect(read(root, 'notes/logo.svg')).rejects.toThrow()
  })

  it('copies non-markdown bytes verbatim — no text decoding on the way', async () => {
    // Read and written as a Buffer, so a PNG survives the trip. Decoding as
    // utf8 and writing the string back would corrupt every byte above 0x7f.
    const root = await mkdtemp(join(tmpdir(), 'holi-mv-'))
    dirs.push(root)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes/pic.png'), bytes)

    await moveNotes(root, [{ from: 'notes/pic.png', to: 'assets/pic.png' }])

    expect(Buffer.compare(await readFile(join(root, 'assets/pic.png')), bytes)).toBe(0)
  })

  it('still rewrites links pointing at a moved non-markdown file', async () => {
    const root = await vault({
      'notes/logo.svg': '<svg/>',
      'ref.md': 'see [[notes/logo.svg]]',
    })

    const { rewritten } = await moveNotes(root, [{ from: 'notes/logo.svg', to: 'assets/logo.svg' }])

    expect(await read(root, 'ref.md')).toBe('see [[assets/logo.svg]]')
    expect(rewritten).toEqual([{ path: 'ref.md', count: 1 }])
  })

  it("moves each note's comment threads with it, and reports the sidecars it changed", async () => {
    const root = await vault({
      'projects/a.md': 'A',
      '.holi/comments/projects/a.md.json': '{"threads":{}}\n',
    })
    const { comments } = await moveNotes(root, [{ from: 'projects/a.md', to: 'done/a.md' }])
    expect(comments).toEqual(['.holi/comments/projects/a.md.json', '.holi/comments/done/a.md.json'])
    expect(await read(root, '.holi/comments/done/a.md.json')).toBe('{"threads":{}}\n')
    await expect(read(root, '.holi/comments/projects/a.md.json')).rejects.toThrow()
  })
})
