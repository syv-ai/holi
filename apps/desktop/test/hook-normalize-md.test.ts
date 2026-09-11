/**
 * `normalize-md` — safe, idempotent, invisible changes only.
 *
 * The constraint that shapes every test here: the editor autosaves and Holi
 * auto-commits, so this transform can fire on a file the user has open, in the
 * middle of a sentence. Anything that moves text moves their cursor.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeMd } from '../src/main/vault/hooks/normalize-md'
import type { StagedChanges } from '../src/main/vault/hooks/staged'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-normalize-'))
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

/** Only staged files are considered — this never sweeps the whole vault. */
const staging = (paths: string[]): StagedChanges => ({
  added: paths,
  modified: [],
  renamed: [],
})

describe('what it fixes', () => {
  it('strips a single trailing space and a trailing tab', async () => {
    // The genuinely invisible case: one space or a tab renders as nothing and
    // nobody put it there on purpose.
    await file('a.md', '# Title \n\nsome text\t\n')
    const result = await normalizeMd(root, staging(['a.md']))
    expect(result.changed).toEqual(['a.md'])
    expect(await read('a.md')).toBe('# Title\n\nsome text\n')
  })

  it('adds a missing final newline', async () => {
    await file('a.md', '# Title\n\nsome text')
    await normalizeMd(root, staging(['a.md']))
    expect(await read('a.md')).toBe('# Title\n\nsome text\n')
  })

  it('leaves a file that is already normal completely alone', async () => {
    // Idempotent, and it must not even appear in `changed` — a transform that
    // reports work it did not do makes the log useless.
    await file('a.md', '# Title\n\nsome text\n')
    const result = await normalizeMd(root, staging(['a.md']))
    expect(result.changed).toEqual([])
    expect(await read('a.md')).toBe('# Title\n\nsome text\n')
  })

  it('is idempotent — a second run changes nothing', async () => {
    await file('a.md', '# Title   \n\nsome text')
    await normalizeMd(root, staging(['a.md']))
    const once = await read('a.md')
    const second = await normalizeMd(root, staging(['a.md']))
    expect(second.changed).toEqual([])
    expect(await read('a.md')).toBe(once)
  })
})

describe('what it must never touch', () => {
  it('never reflows prose', async () => {
    // The autosave-plus-auto-commit argument: a reflow fires mid-sentence on a
    // file someone has open and moves their cursor.
    const long = `# Title\n\n${'word '.repeat(60).trim()}\n`
    await file('a.md', long)
    const result = await normalizeMd(root, staging(['a.md']))
    expect(result.changed).toEqual([])
    expect(await read('a.md')).toBe(long)
  })

  it('leaves CRLF alone', async () => {
    // A Windows collaborator's line endings are not a defect in their file.
    const crlf = '# Title\r\n\r\nsome text\r\n'
    await file('a.md', crlf)
    const result = await normalizeMd(root, staging(['a.md']))
    expect(result.changed).toEqual([])
    expect(await read('a.md')).toBe(crlf)
  })

  it('leaves a fenced code block untouched, indentation included', async () => {
    const text = '# Title\n\n```js\nif (a) {\n    const b = 1   \n}\n```\n'
    await file('a.md', text)
    const result = await normalizeMd(root, staging(['a.md']))
    expect(await read('a.md')).toBe(text)
    expect(result.changed).toEqual([])
  })

  it('leaves a tilde-fenced block alone too', async () => {
    const text = '~~~\ntrailing   \n~~~\n'
    await file('a.md', text)
    await normalizeMd(root, staging(['a.md']))
    expect(await read('a.md')).toBe(text)
  })

  it('keeps a hard line break at three spaces too — CommonMark says two OR MORE', async () => {
    const text = 'first line   \nsecond line\n'
    await file('a.md', text)
    const result = await normalizeMd(root, staging(['a.md']))
    expect(await read('a.md')).toBe(text)
    expect(result.changed).toEqual([])
  })

  it('keeps a markdown hard line break (two trailing spaces)', async () => {
    // Two trailing spaces are a <br>. Stripping them is not whitespace tidying,
    // it silently changes how the note renders.
    const text = 'first line  \nsecond line\n'
    await file('a.md', text)
    const result = await normalizeMd(root, staging(['a.md']))
    expect(await read('a.md')).toBe(text)
    expect(result.changed).toEqual([])
  })

  it('does not touch a non-markdown file', async () => {
    await file('data.json', '{"a": 1}   ')
    const result = await normalizeMd(root, staging(['data.json']))
    expect(result.changed).toEqual([])
    expect(await read('data.json')).toBe('{"a": 1}   ')
  })

  it('does not sweep files that are not staged', async () => {
    await file('staged.md', 'text \n')
    await file('untouched.md', 'text \n')
    const result = await normalizeMd(root, staging(['staged.md']))
    expect(result.changed).toEqual(['staged.md'])
    expect(await read('untouched.md')).toBe('text \n')
  })
})

describe('task files', () => {
  it('canonicalizes frontmatter key order through the task round-trip', async () => {
    await file(
      'task.fix-login.md',
      '---\npriority: high\nstatus: todo\n---\n\nbody\n',
    )
    const result = await normalizeMd(root, staging(['task.fix-login.md']))
    expect(result.changed).toEqual(['task.fix-login.md'])
    const text = await read('task.fix-login.md')
    expect(text.indexOf('status:')).toBeLessThan(text.indexOf('priority:'))
  })

  it('sorts a leftover `title:` to the end, where the unknown keys live', async () => {
    // The title is the body's first heading now, so a key left over from an
    // older file is an unknown one — carried through untouched, and after the
    // keys the format does know.
    await file('task.fix-login.md', '---\ntitle: Fix login\nstatus: todo\n---\n\nbody\n')
    await normalizeMd(root, staging(['task.fix-login.md']))
    const text = await read('task.fix-login.md')
    expect(text.indexOf('status:')).toBeLessThan(text.indexOf('title:'))
  })

  it('leaves an already-canonical task file alone', async () => {
    await file('task.a.md', '---\nstatus: todo\ntitle: Fix login\n---\n\nbody\n')
    await normalizeMd(root, staging(['task.a.md']))
    const once = await read('task.a.md')
    const second = await normalizeMd(root, staging(['task.a.md']))
    expect(second.changed).toEqual([])
    expect(await read('task.a.md')).toBe(once)
  })

  it('leaves an unparseable task file exactly as it is', async () => {
    const broken = '---\nstatus: finished\n---\n\nbody\n'
    await file('task.broken.md', broken)
    const result = await normalizeMd(root, staging(['task.broken.md']))
    expect(result.changed).toEqual([])
    expect(await read('task.broken.md')).toBe(broken)
  })
})
