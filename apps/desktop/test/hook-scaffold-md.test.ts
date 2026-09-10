/**
 * `scaffold-md` — a note gets its frontmatter however it arrived (#17).
 *
 * Two constraints shape every test here. It runs on the **added** set only, so
 * it can never rewrite a note that arrived on a pull or one that has been in the
 * vault for a year; and "markdown" is not the same as "a note", because
 * `CLAUDE.md` is read verbatim as the agent's instructions and a block at the
 * top of it is prompt text rather than metadata.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffoldMd } from '../src/main/vault/hooks/scaffold-md'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let root: string
const dirs: string[] = []
const TODAY = '2026-09-09'
const BLOCK = `---\ncreated: ${TODAY}\ntags: []\n---\n\n`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-scaffold-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function file(rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text, 'utf8')
}

const read = (rel: string) => readFile(join(root, rel), 'utf8')

const added = (paths: string[]): StagedChanges => ({
  added: paths,
  modified: [],
  renamed: [],
  deleted: [],
})

describe('what it scaffolds', () => {
  it('gives a new note a created date and empty tags', async () => {
    await file('notes/plan.md', '# Plan\n\nbody\n')
    const result = await scaffoldMd(root, added(['notes/plan.md']), TODAY)
    expect(result.changed).toEqual(['notes/plan.md'])
    expect(await read('notes/plan.md')).toBe(`${BLOCK}# Plan\n\nbody\n`)
  })

  it('leaves a note that already has frontmatter alone', async () => {
    const text = '---\ncreated: 2020-01-01\n---\n\nbody\n'
    await file('notes/old.md', text)
    const result = await scaffoldMd(root, added(['notes/old.md']), TODAY)
    expect(result.changed).toEqual([])
    expect(await read('notes/old.md')).toBe(text)
  })

  it('is idempotent — running it twice changes nothing the second time', async () => {
    await file('a.md', 'body\n')
    await scaffoldMd(root, added(['a.md']), TODAY)
    const once = await read('a.md')
    const again = await scaffoldMd(root, added(['a.md']), TODAY)
    expect(again.changed).toEqual([])
    expect(await read('a.md')).toBe(once)
  })

  it('treats an unterminated fence as frontmatter being typed, not as prose', async () => {
    // Burying a half-written block under a second one is the worst thing this
    // could do to a file somebody is in the middle of editing.
    const text = '---\ncreated: 2026-01-01\n'
    await file('half.md', text)
    await scaffoldMd(root, added(['half.md']), TODAY)
    expect(await read('half.md')).toBe(text)
  })

  it('works on an empty file', async () => {
    await file('empty.md', '')
    await scaffoldMd(root, added(['empty.md']), TODAY)
    expect(await read('empty.md')).toBe(BLOCK)
  })
})

describe('what it will not touch', () => {
  const untouched = async (rel: string, text = 'body\n') => {
    await file(rel, text)
    const result = await scaffoldMd(root, added([rel]), TODAY)
    expect(result.changed).toEqual([])
    expect(await read(rel)).toBe(text)
  }

  it('leaves the agent surface alone — frontmatter there is prompt text', async () => {
    await untouched('CLAUDE.md')
    await untouched('AGENTS.md')
    await untouched('MEMORY.md')
    await untouched('.claude/skills/x/SKILL.md')
  })

  it('leaves a task file to its own serializer', async () => {
    await untouched('projects/task.fix-login.md')
  })

  it('leaves hidden paths alone', async () => {
    await untouched('.holi/apps/thing/README.md')
  })

  it('leaves a non-markdown file alone', async () => {
    await untouched('data.json', '{}\n')
  })

  it('leaves an ordinary note that merely shares a managed name', async () => {
    // The agent surface matches those four files EXACTLY — `notes/AGENTS.md` is
    // a note somebody wrote about agents.
    await file('notes/AGENTS.md', 'body\n')
    const result = await scaffoldMd(root, added(['notes/AGENTS.md']), TODAY)
    expect(result.changed).toEqual(['notes/AGENTS.md'])
  })
})

describe('the added set is the whole answer to "whose file is this"', () => {
  it('ignores a modified file, however old and however bare', async () => {
    // A note that arrived on a pull is never in a staged set at all; one that has
    // been here a year is `modified`. Neither is ours to rewrite.
    await file('theirs.md', 'body\n')
    const result = await scaffoldMd(root, { added: [], modified: ['theirs.md'], renamed: [], deleted: [] }, TODAY)
    expect(result.changed).toEqual([])
    expect(await read('theirs.md')).toBe('body\n')
  })

  it('ignores a rename, which moves a file rather than making one', async () => {
    await file('to.md', 'body\n')
    const result = await scaffoldMd(
      root,
      { added: [], modified: [], renamed: [{ from: 'from.md', to: 'to.md' }], deleted: [] },
      TODAY,
    )
    expect(result.changed).toEqual([])
  })

  it('says nothing when it changed nothing', async () => {
    const result = await scaffoldMd(root, added([]), TODAY)
    expect(result.notes).toEqual([])
  })
})
