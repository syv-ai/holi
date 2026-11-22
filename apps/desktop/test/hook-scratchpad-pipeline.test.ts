import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { SCRATCHPAD_PATH } from '@holi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DEFAULT_HOOKS, vaultTransforms } from '../src/main/vault/hooks/transforms'
import { resetBreaker, runPreCommit } from '../src/main/vault/hooks/runner'
import { stagedChanges, type StagedChanges } from '../src/main/vault/hooks/staged'

const execFile = promisify(execFileCallback)
let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-scratchpad-pipeline-'))
  dirs.push(root)
  resetBreaker()
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function write(rel: string, bytes: Buffer | string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), bytes)
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: root })
  return stdout
}

async function initRepo(): Promise<void> {
  await git('init', '-q')
  await git('config', 'user.name', 'Holi Test')
  await git('config', 'user.email', 'holi@example.test')
  await git('add', '.')
  try {
    await readFile(join(root, SCRATCHPAD_PATH))
    await git('add', '-f', '--', SCRATCHPAD_PATH)
  } catch {
    // Most fixtures have no canonical scratchpad.
  }
  await git('commit', '-qm', 'initial')
}

async function runDefaultPipeline(changes?: StagedChanges) {
  return runPreCommit(root, changes ?? (await stagedChanges(root)), {
    settings: DEFAULT_HOOKS,
    transforms: vaultTransforms([], []),
  })
}

async function indexBytes(rel: string): Promise<Buffer> {
  const { stdout } = await execFile('git', ['show', `:${rel}`], { cwd: root, encoding: 'buffer' })
  return stdout as unknown as Buffer
}

describe('default pipeline scratchpad protection', () => {
  it('preserves exact disk and index bytes for a move into the canonical scratchpad', async () => {
    const bytes = Buffer.from([0x80, 0xff, ...Buffer.from('scratchpad without newline')])
    await write('incoming.md', bytes)
    await write('ordinary.md', '[[incoming.md]]')
    await initRepo()
    await write('ordinary.md', '[[incoming.md]] ')
    await git('add', 'ordinary.md')
    await git('mv', 'incoming.md', SCRATCHPAD_PATH)

    const result = await runDefaultPipeline()

    expect(await readFile(join(root, SCRATCHPAD_PATH))).toEqual(bytes)
    expect(await indexBytes(SCRATCHPAD_PATH)).toEqual(bytes)
    expect(await readFile(join(root, 'ordinary.md'), 'utf8')).toBe(`[[${SCRATCHPAD_PATH}]]\n`)
    expect(result.changed).toContain('ordinary.md')
    expect(result.changed).not.toContain(SCRATCHPAD_PATH)
    expect(await git('diff', '--cached', '--name-only')).toContain('ordinary.md')
    expect(await git('diff', '--name-only')).toBe('')
  })

  it('preserves exact disk and index bytes for a move out while relinking references', async () => {
    const bytes = Buffer.from([
      0x80,
      0xff,
      ...Buffer.from(`[[${SCRATCHPAD_PATH}]] without newline`),
    ])
    await write(SCRATCHPAD_PATH, bytes)
    await write('ordinary.md', `[[${SCRATCHPAD_PATH}]]`)
    await initRepo()
    await write('ordinary.md', `[[${SCRATCHPAD_PATH}]] `)
    await git('add', 'ordinary.md')
    await git('mv', SCRATCHPAD_PATH, 'personal.md')

    const result = await runDefaultPipeline()

    expect(await readFile(join(root, 'personal.md'))).toEqual(bytes)
    expect(await indexBytes('personal.md')).toEqual(bytes)
    expect(await readFile(join(root, 'ordinary.md'), 'utf8')).toBe('[[personal.md]]\n')
    expect(result.changed).toContain('ordinary.md')
    expect(result.changed).not.toContain('personal.md')
    expect(await git('diff', '--cached', '--name-only')).toContain('ordinary.md')
    expect(await git('diff', '--name-only')).toBe('')
  })

  it('normalizes ordinary notes and only protects scratchpad content in simultaneous mappings', async () => {
    const scratchpad = Buffer.from([0x80, 0xff, ...Buffer.from('draft without newline')])
    const ordinary = Buffer.from('ordinary has trailing spaces  ')
    await write(SCRATCHPAD_PATH, scratchpad)
    await write('personal.md', ordinary)
    await write('target.md', 'target\n')
    await write('ref.md', `[[${SCRATCHPAD_PATH}]] and [[target.md]]`)
    await initRepo()
    await git('mv', 'personal.md', 'archive.md')
    await git('mv', SCRATCHPAD_PATH, 'personal.md')
    await git('mv', 'target.md', 'renamed.md')
    const result = await runDefaultPipeline({
      added: [],
      modified: [],
      deleted: [],
      renamed: [
        { from: SCRATCHPAD_PATH, to: 'personal.md' },
        { from: 'personal.md', to: 'archive.md' },
        { from: 'target.md', to: 'renamed.md' },
      ],
    })

    expect(await readFile(join(root, 'personal.md'))).toEqual(scratchpad)
    expect(await indexBytes('personal.md')).toEqual(scratchpad)
    expect(await readFile(join(root, 'archive.md'), 'utf8')).toBe(
      'ordinary has trailing spaces  \n',
    )
    expect(await indexBytes('archive.md')).toEqual(Buffer.from('ordinary has trailing spaces  \n'))
    expect(await readFile(join(root, 'ref.md'), 'utf8')).toBe('[[personal.md]] and [[renamed.md]]')
    expect(result.changed).toContain('archive.md')
    expect(result.changed).toContain('ref.md')
    expect(result.changed).not.toContain('personal.md')
  })

  it('does not protect nested lookalikes from ordinary relinking or normalization', async () => {
    const bytes = Buffer.from('[[old.md]] without newline  ')
    await write('old.md', 'old\n')
    await initRepo()
    await write('nested/scratchpad.local.md', bytes)
    await git('add', 'nested/scratchpad.local.md')
    await git('mv', 'old.md', 'new.md')

    const result = await runDefaultPipeline()

    expect(await readFile(join(root, 'nested/scratchpad.local.md'), 'utf8')).toBe(
      '[[new.md]] without newline  \n',
    )
    expect(result.changed).toContain('nested/scratchpad.local.md')
  })
})
