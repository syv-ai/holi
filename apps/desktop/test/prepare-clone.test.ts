import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
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
