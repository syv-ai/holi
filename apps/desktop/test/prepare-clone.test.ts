import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  beforeTempOpen: undefined as (() => Promise<void>) | undefined,
  failCheckAttr: false,
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const commandArgs = args[1]
      if (!hooks.failCheckAttr || !Array.isArray(commandArgs) || commandArgs[0] !== 'check-attr')
        return actual.spawn(...args)
      const child = new EventEmitter() as ReturnType<typeof actual.spawn>
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
        },
      })
      setImmediate(() => child.emit('close', 1))
      return child
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (String(args[0]).includes('.holi-line-ending-')) await hooks.beforeTempOpen?.()
      return handle
    },
  }
})
import { updateShipped } from '../src/main/vault/seed/update'
import { prepareManagedClone } from '../src/main/vault/prepare-clone'
import { appsSeed } from '../src/plugins/apps/main/seed'
import { cleanupFixtures, makeClone, makeRemote, plainGit, tmp } from './helpers/git-fixtures'

afterAll(cleanupFixtures)
const run = promisify(execFile)
const shippedPath = Object.keys(appsSeed.shipped)[0]!
const previousShipped = appsSeed.shipped[shippedPath]!
const updatedShipped = previousShipped.replace(/^[^\n]*/, '# updated shipped line')
const contents = { ...appsSeed, shipped: { [shippedPath]: updatedShipped } }

describe('prepareManagedClone', () => {
  it('consumes stdin errors when Git exits before reading a large path list', async () => {
    const root = await makeClone(await makeRemote(), 'early-git-exit')
    const paths = Array.from({ length: 200 }, (_, index) => `candidate-${index}.md`)
    for (const path of paths) await writeFile(join(root, path), 'base\n')
    await plainGit(root, ['add', '-A'])
    await plainGit(root, ['commit', '-m', 'candidate files'])
    await plainGit(root, ['config', '--local', 'core.autocrlf', 'true'])
    for (const path of paths) await writeFile(join(root, path), 'base\r\n')
    hooks.failCheckAttr = true
    try {
      await expect(prepareManagedClone(root)).rejects.toThrow(/git exited 1/)
    } finally {
      hooks.failCheckAttr = false
    }
  })

  it('rechecks staged state after the replacement file is written', async () => {
    const root = await makeClone(await makeRemote(), 'late-stage')
    const path = 'candidate.md'
    const original = Buffer.from('base\n')
    await writeFile(join(root, path), original)
    await plainGit(root, ['add', path])
    await plainGit(root, ['commit', '-m', 'candidate'])
    await plainGit(root, ['config', '--local', 'core.autocrlf', 'true'])
    const crlf = Buffer.from('base\r\n')
    await writeFile(join(root, path), crlf)

    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => (release = resolve))
    const opened = new Promise<void>((resolve) => (entered = resolve))
    hooks.beforeTempOpen = async () => {
      entered()
      await barrier
    }
    try {
      const preparing = prepareManagedClone(root)
      await opened
      await writeFile(join(root, path), 'new staged content\n')
      await plainGit(root, ['add', path])
      await writeFile(join(root, path), crlf)
      release()
      await preparing
      expect(await readFile(join(root, path))).toEqual(crlf)
      expect(await plainGit(root, ['diff', '--cached', '--name-only'])).toBe(path)
    } finally {
      release()
      hooks.beforeTempOpen = undefined
    }
  })

  it('skips filter, encoding, ident, and explicit text attributes', async () => {
    const root = await makeClone(await makeRemote(), 'attribute-skips')
    const paths = ['filtered.md', 'encoded.md', 'identified.md', 'explicit.md']
    for (const path of paths) await writeFile(join(root, path), `${path}\n`)
    await plainGit(root, ['add', '-A'])
    await plainGit(root, ['commit', '-m', 'attribute fixtures'])
    await writeFile(
      join(root, '.git', 'info', 'attributes'),
      'filtered.md filter=custom\nencoded.md working-tree-encoding=UTF-16LE\nidentified.md ident\nexplicit.md -text\n',
    )
    await plainGit(root, ['config', '--local', 'core.autocrlf', 'true'])
    for (const path of paths) await writeFile(join(root, path), `${path}\r\n`)

    await prepareManagedClone(root)

    for (const path of paths) expect(await readFile(join(root, path), 'utf8')).toBe(`${path}\r\n`)
  })

  it('does not follow a symlinked ancestor outside the clone', async () => {
    const root = await makeClone(await makeRemote(), 'symlink-ancestor')
    const relative = 'parent/candidate.md'
    await mkdir(join(root, 'parent'))
    await writeFile(join(root, relative), 'candidate\n')
    await plainGit(root, ['add', relative])
    await plainGit(root, ['commit', '-m', 'candidate'])
    await plainGit(root, ['config', '--local', 'core.autocrlf', 'true'])
    const outside = await tmp('holi-outside-')
    const target = join(outside, 'candidate.md')
    const externalBytes = Buffer.from('outside\r\n')
    await writeFile(target, externalBytes)
    await rm(join(root, 'parent'), { recursive: true })
    await symlink(outside, join(root, 'parent'))

    await prepareManagedClone(root)

    expect(await readFile(target)).toEqual(externalBytes)
  })

  it('leaves an unmerged file unchanged', async () => {
    const root = await makeClone(await makeRemote(), 'unmerged')
    await writeFile(join(root, 'conflict.md'), 'base\n')
    await plainGit(root, ['add', 'conflict.md'])
    await plainGit(root, ['commit', '-m', 'base'])
    await plainGit(root, ['checkout', '-b', 'other'])
    await writeFile(join(root, 'conflict.md'), 'other\n')
    await plainGit(root, ['commit', '-am', 'other'])
    await plainGit(root, ['checkout', 'main'])
    await writeFile(join(root, 'conflict.md'), 'main\n')
    await plainGit(root, ['commit', '-am', 'main'])
    await expect(plainGit(root, ['merge', 'other'])).rejects.toThrow()
    const conflict = await readFile(join(root, 'conflict.md'))

    await prepareManagedClone(root)

    expect(await readFile(join(root, 'conflict.md'))).toEqual(conflict)
    expect(await plainGit(root, ['ls-files', '--unmerged', '--', 'conflict.md'])).not.toBe('')
  })

  it('prepares an empty clone with an unborn branch', async () => {
    const root = await tmp('holi-empty-clone-')
    await plainGit(root, ['init', '-b', 'main'])
    await prepareManagedClone(root)
    expect(await plainGit(root, ['config', '--local', 'core.autocrlf'])).toBe('false')
  })

  it('reproduces CRLF false conflicts while updating an unrecorded shipped file', async () => {
    const origin = await makeRemote()
    const source = await makeClone(origin, 'source')
    await mkdir(dirname(join(source, shippedPath)), { recursive: true })
    await writeFile(join(source, shippedPath), previousShipped)
    await plainGit(source, ['add', shippedPath])
    await plainGit(source, ['commit', '-m', 'add shipped file'])
    await plainGit(source, ['push', 'origin', 'HEAD:main'])
    const root = await tmp('holi-autocrlf-')
    const clone = join(root, 'clone')
    await run('git', ['-c', 'core.autocrlf=true', 'clone', origin, clone])
    const before = await readFile(join(clone, shippedPath))
    expect(before.toString()).toBe(previousShipped.replace(/\n/g, '\r\n'))
    await prepareManagedClone(clone)
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(previousShipped)

    const report = await updateShipped(clone, [contents])
    expect(report.conflicts).toEqual([])
    expect([...report.updated, ...report.merged]).toEqual([shippedPath])
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(updatedShipped)
  })

  it('merges a committed customization with a non-overlapping shipped update', async () => {
    const origin = await makeRemote()
    const source = await makeClone(origin, 'customized')
    await mkdir(dirname(join(source, shippedPath)), { recursive: true })
    await writeFile(join(source, shippedPath), previousShipped)
    await plainGit(source, ['add', shippedPath])
    await plainGit(source, ['commit', '-m', 'add shipped file'])
    await plainGit(source, ['push', 'origin', 'HEAD:main'])
    const root = await tmp('holi-custom-')
    const clone = join(root, 'clone')
    await run('git', ['-c', 'core.autocrlf=true', 'clone', origin, clone])
    await prepareManagedClone(clone)
    const customized = `${previousShipped}\nlocal committed addition\n`
    await writeFile(join(clone, shippedPath), customized)
    await plainGit(clone, ['add', shippedPath])
    await plainGit(clone, ['commit', '-m', 'customize shipped file'])

    const report = await updateShipped(clone, [contents])

    expect(report.conflicts).toEqual([])
    expect(report.merged).toEqual([shippedPath])
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(
      `${updatedShipped}\nlocal committed addition\n`,
    )
  })

  it('leaves edits, binaries, symlinks and explicit CRLF attributes untouched', async () => {
    const root = await makeClone(await makeRemote(), 'safety')
    const regular = 'eligible.md'
    const executable = 'script.sh'
    const unusual = 'odd name\nfile.md'
    const staged = 'staged.md'
    const edited = 'edited.md'
    const binary = 'binary.dat'
    const crlf = 'forced-crlf.txt'
    const link = 'linked.md'
    await writeFile(join(root, '.gitattributes'), `${crlf} text eol=crlf\n`)
    await writeFile(join(root, regular), 'clean\n')
    await writeFile(join(root, executable), '#!/bin/sh\necho ok\n')
    await chmod(join(root, executable), 0o755)
    await writeFile(join(root, unusual), 'unusual\n')
    await writeFile(join(root, staged), 'base\n')
    await writeFile(join(root, edited), 'base\n')
    await writeFile(join(root, binary), Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x62]))
    await writeFile(join(root, crlf), 'attribute\n')
    await writeFile(join(root, 'target.md'), 'target\n')
    await symlink('target.md', join(root, link))
    await plainGit(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await plainGit(root, ['add', '-A'])
    await plainGit(root, ['commit', '-m', 'fixtures'])
    await plainGit(root, ['config', '--local', 'core.autocrlf', 'true'])
    await plainGit(root, ['config', 'core.filemode', 'true'])
    await writeFile(join(root, regular), 'clean\r\n')
    await writeFile(join(root, executable), '#!/bin/sh\r\necho ok\r\n')
    await writeFile(join(root, unusual), 'unusual\r\n')
    await writeFile(join(root, staged), 'staged change\n')
    await plainGit(root, ['add', staged])
    await writeFile(join(root, staged), 'staged change\r\n')
    await writeFile(join(root, edited), 'user edit\r\n')
    await writeFile(join(root, crlf), 'attribute\r\n')
    await writeFile(join(root, 'untracked.md'), 'untracked\r\n')
    const headBefore = await plainGit(root, ['rev-parse', 'HEAD'])
    const indexBefore = await readFile(join(root, '.git/index'))
    const stagedBefore = await readFile(join(root, staged))

    await prepareManagedClone(root)

    expect(await readFile(join(root, regular), 'utf8')).toBe('clean\n')
    expect(await readFile(join(root, executable), 'utf8')).toBe('#!/bin/sh\necho ok\n')
    expect((await stat(join(root, executable))).mode & 0o777).toBe(0o755)
    expect(await readFile(join(root, unusual), 'utf8')).toBe('unusual\n')
    expect(await readFile(join(root, staged))).toEqual(stagedBefore)
    expect(await readFile(join(root, edited), 'utf8')).toBe('user edit\r\n')
    expect(await readFile(join(root, binary))).toEqual(Buffer.from([0x61, 0x0d, 0x0a, 0x00, 0x62]))
    expect(await readFile(join(root, crlf), 'utf8')).toBe('attribute\r\n')
    expect((await lstat(join(root, link))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, link))).toBe('target.md')
    expect(await readFile(join(root, 'untracked.md'), 'utf8')).toBe('untracked\r\n')
    expect(await plainGit(root, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await readFile(join(root, '.git/index'))).toEqual(indexBefore)
  })

  it('sets local autocrlf off and converts only eligible clean files idempotently', async () => {
    const origin = await makeRemote()
    const source = await makeClone(origin, 'source')
    await mkdir(dirname(join(source, shippedPath)), { recursive: true })
    await writeFile(join(source, shippedPath), previousShipped)
    await plainGit(source, ['add', shippedPath])
    await plainGit(source, ['commit', '-m', 'add shipped file'])
    await plainGit(source, ['push', 'origin', 'HEAD:main'])
    const root = await tmp('holi-prepare-')
    const clone = join(root, 'clone')
    await run('git', ['-c', 'core.autocrlf=true', 'clone', origin, clone])
    const headBefore = await plainGit(clone, ['rev-parse', 'HEAD'])
    const indexBefore = await readFile(join(clone, '.git/index'))

    await prepareManagedClone(clone)
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(previousShipped)
    expect(await plainGit(clone, ['config', '--local', 'core.autocrlf'])).toBe('false')
    expect(await plainGit(clone, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await readFile(join(clone, '.git/index'))).toEqual(indexBefore)
    await prepareManagedClone(clone)
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(previousShipped)
    const report = await updateShipped(clone, [contents])
    expect(report.conflicts).toEqual([])
    expect([...report.updated, ...report.merged]).toEqual([shippedPath])
    expect(await readFile(join(clone, shippedPath), 'utf8')).toBe(updatedShipped)
  })
})
