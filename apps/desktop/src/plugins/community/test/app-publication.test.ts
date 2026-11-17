import { mkdtemp, mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { seedApps } from '../main/skills'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holi-app-publication-'))
  roots.push(root)
  const code = join(root, 'checkout')
  const vault = join(root, 'vault')
  await mkdir(join(code, 'apps', 'Demo.app'), { recursive: true })
  await mkdir(vault)
  await writeFile(join(code, 'apps', 'Demo.app', 'index.html'), 'trusted')
  return { root, code, vault, app: join(code, 'apps', 'Demo.app') }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('seedApps publication', () => {
  it('rejects destination aliases before writing', async () => {
    const { code, vault } = await fixture()
    await expect(
      seedApps({ apps: ['apps/First.app', 'else/first.app'] }, code, vault),
    ).rejects.toThrow('colliding')
    expect(await readFile(join(vault, '.holi')).catch(() => null)).toBeNull()
  })

  it('preserves an existing app and publishes a complete staged copy', async () => {
    const { code, vault } = await fixture()
    await mkdir(join(vault, 'Demo.app'))
    await writeFile(join(vault, 'Demo.app', 'user.txt'), 'owned')
    expect(await seedApps({ apps: ['apps/Demo.app'] }, code, vault)).toEqual([])
    expect(await readFile(join(vault, 'Demo.app', 'user.txt'), 'utf8')).toBe('owned')
    await rm(join(vault, 'Demo.app'), { recursive: true })
    expect(await seedApps({ apps: ['apps/Demo.app'] }, code, vault)).toEqual(['Demo.app'])
    expect(await readFile(join(vault, 'Demo.app', 'index.html'), 'utf8')).toBe('trusted')
  })

  it('cancels before publication and cleans only its staging folder', async () => {
    const { code, vault } = await fixture()
    const controller = new AbortController()
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        guard: () => controller.abort(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled')
    expect(await readFile(join(vault, 'Demo.app', 'index.html')).catch(() => null)).toBeNull()
  })

  it('authenticates bytes and rejects extra checkout files against the pinned Git tree', async () => {
    const { root, code, vault, app } = await fixture()
    await writeFile(join(app, 'index.html'), 'trusted\n')
    execFileSync('git', ['init', code], { stdio: 'ignore' })
    execFileSync('git', ['-C', code, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        code,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    )
    const commit = execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await writeFile(join(app, 'index.html'), 'tampered')
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('differs from authenticated release')
    await writeFile(join(app, 'index.html'), 'trusted\n')
    const priorConfig = process.env.GIT_CONFIG_GLOBAL
    const priorObjects = process.env.GIT_OBJECT_DIRECTORY
    process.env.GIT_CONFIG_GLOBAL = join(root, 'missing-global-config')
    process.env.GIT_OBJECT_DIRECTORY = join(root, 'empty-object-directory')
    await writeFile(join(app, 'index.html'), 'trusted\r\n')
    expect(
      await seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).toEqual(['Demo.app'])
    expect(await readFile(join(vault, 'Demo.app', 'index.html'), 'utf8')).toBe('trusted\n')
    if (priorConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = priorConfig
    if (priorObjects === undefined) delete process.env.GIT_OBJECT_DIRECTORY
    else process.env.GIT_OBJECT_DIRECTORY = priorObjects
    await rm(join(vault, 'Demo.app'), { recursive: true })
    await writeFile(join(app, 'index.html'), 'trusted\n')
    await writeFile(join(app, 'extra.js'), 'extra')
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('differs from authenticated release')
  })

  it('rejects a forged loose blob stored under the authenticated object name', async () => {
    const { code, vault, app } = await fixture()
    const trusted = Buffer.from('trusted\n')
    await writeFile(join(app, 'index.html'), trusted)
    execFileSync('git', ['init', code], { stdio: 'ignore' })
    execFileSync('git', ['-C', code, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        code,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    )
    const commit = execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const oid = execFileSync(
      'git',
      ['-C', code, 'rev-parse', `${commit}:apps/Demo.app/index.html`],
      {
        encoding: 'utf8',
      },
    ).trim()
    const objectPath = join(code, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    const forged = Buffer.from('forged!\n')
    await unlink(objectPath)
    await writeFile(
      objectPath,
      deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])),
    )
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('invalid Git blob object')
  })

  it('rejects authenticated aggregate blob bytes before retaining an oversized app', async () => {
    const { code, vault, app } = await fixture()
    const payload = Buffer.alloc(2 * 1024 * 1024, 7)
    for (let i = 0; i < 17; i++) await writeFile(join(app, `file-${i}.bin`), payload)
    execFileSync('git', ['init', code], { stdio: 'ignore' })
    execFileSync('git', ['-C', code, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        code,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    )
    const commit = execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('app exceeds filesystem limits')
  })

  it('rejects authenticated app trees exceeding entry and depth budgets', async () => {
    const { code, vault, app } = await fixture()
    for (let i = 0; i < 2049; i++) await writeFile(join(app, `entry-${i}`), '')
    execFileSync('git', ['init', code], { stdio: 'ignore' })
    execFileSync('git', ['-C', code, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        code,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    )
    const commit = execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('invalid authenticated app tree')
  })

  it('rejects an authenticated tree beyond the depth budget before reading blobs', async () => {
    const { code, vault, app } = await fixture()
    const nested = Array.from({ length: 34 }, (_, index) => `level-${index}`).join('/')
    await mkdir(join(app, nested), { recursive: true })
    await writeFile(join(app, nested, 'deep.txt'), '')
    execFileSync('git', ['init', code], { stdio: 'ignore' })
    execFileSync('git', ['-C', code, 'add', '.'])
    execFileSync(
      'git',
      [
        '-C',
        code,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore' },
    )
    const commit = execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        release: { root: code, commit, sourcePath: '' },
      }),
    ).rejects.toThrow('unsafe Git tree path')
  })

  it('rejects staged-file mutation introduced by the final authorization guard', async () => {
    const { code, vault } = await fixture()
    let calls = 0
    await expect(
      seedApps({ apps: ['apps/Demo.app'] }, code, vault, {
        guard: async () => {
          if (++calls !== 2) return
          const state = join(vault, '.holi', 'state')
          const entries = await readdir(state)
          const staging = entries.find((entry) => entry.startsWith('community-apps.local.'))!
          await writeFile(join(state, staging, 'Demo.app', 'index.html'), 'changed')
        },
      }),
    ).rejects.toThrow('staged app changed')
    expect(await readFile(join(vault, 'Demo.app', 'index.html')).catch(() => null)).toBeNull()
  })

  it('rejects an intermediate directory symlink that escapes the checkout', async () => {
    const { root, code, vault } = await fixture()
    await rm(join(code, 'apps'), { recursive: true })
    await symlink(root, join(code, 'apps'))
    await mkdir(join(root, 'Demo.app'))
    await writeFile(join(root, 'Demo.app', 'index.html'), 'outside')
    await expect(seedApps({ apps: ['apps/Demo.app'] }, code, vault)).rejects.toThrow(
      'escapes checkout',
    )
  })

  it('rejects a source tree that exceeds its entry budget', async () => {
    const { code, vault, app } = await fixture()
    for (let i = 0; i < 2050; i++) await writeFile(join(app, `extra-${i}`), '')
    await expect(seedApps({ apps: ['apps/Demo.app'] }, code, vault)).rejects.toThrow(
      'filesystem limits',
    )
  })
})
