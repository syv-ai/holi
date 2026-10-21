import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  anchorAt,
  commentThreads,
  emptyCommentsFile,
  formatCommentsFile,
  formatRecord,
  mergeCommentsText,
  mergeRecordText,
  parseCommentsFile,
  withReply,
  withThread,
} from '@holi/shared'
import { runGit, tryGit } from '../src/main/git'
import { bridgeLines, writeVaultEnv } from './helpers/bridge-env'
import { attributesLine, installMergeDrivers, MERGE_DRIVERS } from '../src/main/vault/merge-drivers'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-merge-drivers-'))
  dirs.push(root)
  await runGit(root, ['init', '-q', '-b', 'main'])
  await runGit(root, ['config', 'user.email', 'ada@syv.ai'])
  await runGit(root, ['config', 'user.name', 'Ada Holm'])
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('installMergeDrivers', () => {
  it('registers each driver for its own paths only, and is idempotent', async () => {
    await mkdir(join(root, '.git/info'), { recursive: true })
    await writeFile(join(root, '.git/info/attributes'), '*.psd binary\n')
    await installMergeDrivers(root)
    await installMergeDrivers(root)

    const driver = await runGit(root, ['config', '--get', 'merge.holi-record.driver'])
    expect(driver).toContain(join(root, '.git/holi-merge'))
    const attributes = await readFile(join(root, '.git/info/attributes'), 'utf8')
    expect(
      attributes.split('\n').filter((l) => l === attributesLine(MERGE_DRIVERS[0]!)),
    ).toHaveLength(1)
    // Someone else's line survives: the file is appended to, never replaced.
    expect(attributes).toContain('*.psd binary')

    const attr = async (path: string) =>
      (await runGit(root, ['check-attr', 'merge', '--', path])).split(': ').at(-1)
    expect(await attr('Budget.app/data/items/a.json')).toBe('holi-record')
    expect(await attr('A/B.app/data/x/y.json')).toBe('holi-record')
    expect(await attr('.holi/comments/notes/a.md.json')).toBe('holi-comments')
    expect(await attr('notes/a.json')).toBe('unspecified')
    expect(await attr('Budget.app/app.json')).toBe('unspecified')
  })
})

describe('the driver, end to end through git', () => {
  let server: Server
  /** The routes git's driver asked, in order. */
  let asked: string[]

  /** Holi's side, answering as the `/merge/record` and `/merge/comments`
   *  routes do. */
  async function listen(): Promise<number> {
    asked = []
    server = createServer((req, res) => {
      const route = new URL(req.url ?? '/', 'http://x').pathname
      asked.push(route)
      const merge = route === '/merge/comments' ? mergeCommentsText : mergeRecordText
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        const p = new URLSearchParams(body)
        const base = p.get('base') ?? ''
        const out = merge(base === '' ? null : base, p.get('ours')!, p.get('theirs')!)
        res.writeHead(out.ok ? 200 : 409, { 'content-type': 'text/plain' })
        res.end(out.ok ? out.text : out.reason)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  }

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  })

  const REC = 'T.app/data/items/a.json'

  async function branches(ours: object, theirs: object) {
    await mkdir(join(root, 'T.app/data/items'), { recursive: true })
    await writeFile(join(root, REC), formatRecord({ title: 'a', done: false, points: 1 }))
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'base'])
    await runGit(root, ['checkout', '-qb', 'theirs'])
    await writeFile(join(root, REC), formatRecord(theirs))
    await runGit(root, ['commit', '-qam', 'theirs'])
    await runGit(root, ['checkout', '-q', 'main'])
    await writeFile(join(root, REC), formatRecord(ours))
    await runGit(root, ['commit', '-qam', 'ours'])
  }

  it('merges edits of different fields of one record cleanly', async () => {
    await writeVaultEnv(root, bridgeLines(await listen(), 'ab'))
    await installMergeDrivers(root)
    await branches({ title: 'a', done: true, points: 1 }, { title: 'b', done: false, points: 1 })

    const merge = await tryGit(root, ['merge', '--no-edit', 'theirs'])
    expect(merge.ok).toBe(true)
    expect(await readFile(join(root, REC), 'utf8')).toBe(
      formatRecord({ title: 'b', done: true, points: 1 }),
    )
  })

  it('leaves a conflict for reconcile when both changed one field', async () => {
    await writeVaultEnv(root, bridgeLines(await listen(), 'ab'))
    await installMergeDrivers(root)
    await branches({ title: 'x', done: false, points: 1 }, { title: 'y', done: false, points: 1 })

    expect((await tryGit(root, ['merge', '--no-edit', 'theirs'])).ok).toBe(false)
    expect(await runGit(root, ['diff', '--name-only', '--diff-filter=U'])).toBe(REC)
  })

  it("routes a note's comments to their own driver, keeping both sides' replies", async () => {
    await writeVaultEnv(root, bridgeLines(await listen(), 'ab'))
    await installMergeDrivers(root)
    const SIDECAR = '.holi/comments/plan.md.json'
    const doc = 'The budget is 40k.\n'
    const reply = (id: string, author: string) => ({
      id,
      author,
      at: '2026-10-21T11:00:00.000Z',
      body: `${author} replies`,
    })
    const base = withThread(emptyCommentsFile(), 't', anchorAt(doc, 14, 17), {
      ...reply('a', 'ada'),
      at: '2026-10-21T10:00:00.000Z',
    })
    await mkdir(join(root, '.holi/comments'), { recursive: true })
    await writeFile(join(root, SIDECAR), formatCommentsFile(base))
    await runGit(root, ['add', '-A'])
    await runGit(root, ['commit', '-qm', 'base'])
    await runGit(root, ['checkout', '-qb', 'theirs'])
    await writeFile(
      join(root, SIDECAR),
      formatCommentsFile(withReply(base, 't', reply('b', 'bob'))!),
    )
    await runGit(root, ['commit', '-qam', 'theirs'])
    await runGit(root, ['checkout', '-q', 'main'])
    await writeFile(
      join(root, SIDECAR),
      formatCommentsFile(withReply(base, 't', reply('c', 'cy'))!),
    )
    await runGit(root, ['commit', '-qam', 'ours'])

    expect((await tryGit(root, ['merge', '--no-edit', 'theirs'])).ok).toBe(true)
    expect(asked).toEqual(['/merge/comments'])
    const [thread] = commentThreads(parseCommentsFile(await readFile(join(root, SIDECAR), 'utf8'))!)
    expect(thread!.comments.map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('conflicts safely when Holi is not there to ask', async () => {
    await installMergeDrivers(root)
    await branches({ title: 'a', done: true, points: 1 }, { title: 'b', done: false, points: 1 })

    expect((await tryGit(root, ['merge', '--no-edit', 'theirs'])).ok).toBe(false)
    expect(await runGit(root, ['diff', '--name-only', '--diff-filter=U'])).toBe(REC)
  })
})
