import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshSkills, writeSkills } from '../main/skills'
import { skillTransactionFs, transactSkillRefresh } from '../main/skill-transaction'

const execFile = promisify(execFileCallback)
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holi-522-skills-'))
  roots.push(root)
  const source = join(root, 'release')
  const vault = join(root, 'vault')
  await mkdir(join(source, 'skills', 'demo'), { recursive: true })
  await mkdir(vault, { recursive: true })
  await writeFile(join(source, 'skills', 'demo', 'SKILL.md'), 'release v1')
  return { source, vault, manifest: { skills: ['skills/demo'] } }
}

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

describe('refreshSkills', () => {
  it('accepts an ordinary Git for Windows CRLF checkout and publishes authenticated LF bytes', async () => {
    const f = await fixture()
    const repository = f.source
    const skillFile = join(repository, 'skills/demo/SKILL.md')
    const canonical = Buffer.from('release v1\nsecond line\n')
    await writeFile(skillFile, canonical)
    const git = async (...args: string[]) =>
      execFile('git', args, { cwd: repository, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    await git('init', '-q')
    await git('config', 'user.email', 'holi-test@example.invalid')
    await git('config', 'user.name', 'Holi test')
    await git('config', 'core.autocrlf', 'true')
    await git('add', 'skills/demo/SKILL.md')
    await git('commit', '-qm', 'fixture')
    await rm(skillFile)
    await git('checkout', '--', 'skills/demo/SKILL.md')
    const checkedOut = await readFile(skillFile)
    expect(checkedOut).toEqual(Buffer.from('release v1\r\nsecond line\r\n'))

    await expect(
      transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], repository, f.vault, {
        force: false,
        guard() {},
        expectedSnapshots: [
          {
            name: 'demo',
            directories: [],
            files: [{ path: 'SKILL.md', bytes: canonical, mode: 0o100644 }],
          },
        ],
      }),
    ).resolves.toEqual(['.claude/skills/demo'])
    expect(await readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).toEqual(canonical)
    expect(await readFile(skillFile)).toEqual(checkedOut)
  })

  it('rejects CRLF checkouts with non-checkout edits and unsafe text representations', async () => {
    const cases = [
      {
        actual: Buffer.from('release v1\r\nextra edit\r\n'),
        expected: Buffer.from('release v1\n'),
      },
      { actual: Buffer.from([0x61, 0x00, 0x0d, 0x0a]), expected: Buffer.from([0x61, 0x00, 0x0a]) },
      { actual: Buffer.from('a\r\nb\rc\r\n'), expected: Buffer.from('a\nb\nc\n') },
      { actual: Buffer.from([0xff, 0x0d, 0x0a]), expected: Buffer.from([0xff, 0x0a]) },
    ]
    for (const { actual, expected } of cases) {
      const f = await fixture()
      await writeFile(join(f.source, 'skills/demo/SKILL.md'), actual)
      await expect(
        transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], f.source, f.vault, {
          force: false,
          guard() {},
          expectedSnapshots: [
            {
              name: 'demo',
              directories: [],
              files: [{ path: 'SKILL.md', bytes: expected, mode: 0o100644 }],
            },
          ],
        }),
      ).rejects.toThrow('differs from authenticated metadata')
      await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
    }
  })

  it('copies absent folders and treats matching contents as a no-op', async () => {
    const f = await fixture()
    expect(
      await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).toEqual(['.claude/skills/demo'])
    expect(
      await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).toEqual([])
  })

  it('refuses any conflicting folder without writing unless forced', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'local edit')
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow('--force')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('local edit')
    await mkdir(join(f.vault, '.claude/skills/unrelated'), { recursive: true })
    await writeFile(join(f.vault, '.claude/skills/unrelated/file.md'), 'keep')
    expect(await refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} })).toEqual(
      ['.claude/skills/demo'],
    )
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('release v1')
    expect(await readFile(join(f.vault, '.claude/skills/unrelated/file.md'), 'utf8')).toBe('keep')
  })

  it('backs up manually edited folders before publishing replacement guides', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'my edited guide')
    const written = await writeSkills(f.manifest, f.source, f.vault)
    const backup = written.find((path) => path.includes('guide backups'))
    expect(backup).toBeDefined()
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('release v1')
    expect(
      await readFile(join(f.vault, backup!.split(' (')[0]!, 'demo.original/SKILL.md'), 'utf8'),
    ).toBe('my edited guide')
  })

  it('keeps existing guide bytes and pin eligibility when backup creation fails', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'my edited guide')
    const originalRename = skillTransactionFs.rename
    skillTransactionFs.rename = async (from, to) => {
      if (String(from).endsWith('/.claude/skills/demo') && String(to).endsWith('demo.original'))
        throw new Error('simulated backup failure')
      return originalRename(from, to)
    }
    try {
      await expect(writeSkills(f.manifest, f.source, f.vault)).rejects.toThrow(
        'simulated backup failure',
      )
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('my edited guide')
    } finally {
      skillTransactionFs.rename = originalRename
    }
  })

  it('treats byte-and-mode matches as unchanged and mode changes as conflicts', async () => {
    const f = await fixture()
    await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} })
    expect(
      await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).toEqual([])
    await chmod(join(f.vault, '.claude/skills/demo/SKILL.md'), 0o755)
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow('--force')
  })

  it('preserves private source permissions without broadening them during staging', async () => {
    const f = await fixture()
    const sourceFile = join(f.source, 'skills/demo/SKILL.md')
    await chmod(sourceFile, 0o600)
    await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} })
    expect((await lstat(join(f.vault, '.claude/skills/demo/SKILL.md'))).mode & 0o777).toBe(0o600)
  })

  it('preflights every source before publishing any destination', async () => {
    const f = await fixture()
    await mkdir(join(f.source, 'skills', 'late'))
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'keep')
    await expect(
      transactSkillRefresh(
        [
          { path: 'skills/demo', name: 'demo' },
          { path: 'skills/late', name: 'late' },
        ],
        f.source,
        f.vault,
        { force: true, guard() {} },
      ),
    ).rejects.toThrow('SKILL.md')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('keep')
  })

  it('allows contained source symlinks but rejects source escapes and destination symlink parents', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'shared.md'), 'shared')
    await symlink('../../shared.md', join(f.source, 'skills/demo/shared.md'))
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).resolves.toHaveLength(1)
    expect(await readFile(join(f.vault, '.claude/skills/demo/shared.md'), 'utf8')).toBe('shared')

    const outside = join(f.vault, '..', 'outside')
    await mkdir(outside, { recursive: true })
    await rm(join(f.vault, '.claude'), { recursive: true })
    await symlink(outside, join(f.vault, '.claude'))
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} }),
    ).rejects.toThrow()
  })

  it('rejects source escapes, dangling links, and cycles before destination writes', async () => {
    const f = await fixture()
    const external = join(f.vault, '..', 'secret.md')
    await writeFile(external, 'secret')
    await symlink(external, join(f.source, 'skills/demo/escape.md'))
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow()
    await rm(join(f.source, 'skills/demo/escape.md'))
    await symlink('missing.md', join(f.source, 'skills/demo/dangling.md'))
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow()
    await rm(join(f.source, 'skills/demo/dangling.md'))
    await symlink('.', join(f.source, 'skills/demo/loop'))
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow('cycle')
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
  })

  it('rejects case-colliding names and non-regular required files', async () => {
    const f = await fixture()
    await expect(
      transactSkillRefresh(
        [
          { path: 'skills/demo', name: 'Demo' },
          { path: 'skills/demo', name: 'demo' },
        ],
        f.source,
        f.vault,
        { force: false, guard() {} },
      ),
    ).rejects.toThrow('colliding')
    await rm(join(f.source, 'skills/demo/SKILL.md'))
    await symlink('README.md', join(f.source, 'skills/demo/SKILL.md'))
    await writeFile(join(f.source, 'skills/demo/README.md'), 'not required')
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow('regular SKILL.md')
  })

  it('passes validated immutable bytes to the provenance seam before publication', async () => {
    const f = await fixture()
    const validateSnapshot = async (
      snapshots: readonly { name: string; files: readonly { path: string; bytes: Buffer }[] }[],
    ) => {
      expect(snapshots[0]!.files[0]!.bytes.toString()).toBe('release v1')
      snapshots[0]!.files[0]!.bytes.fill(0)
      await writeFile(join(f.source, 'skills/demo/SKILL.md'), 'changed after snapshot')
    }
    await expect(
      transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], f.source, f.vault, {
        force: false,
        guard() {},
        validateSnapshot,
      }),
    ).resolves.toEqual(['.claude/skills/demo'])
    expect(await readFile(join(f.vault, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('release v1')
  })

  it('rejects publication-stage byte, mode, and shape tampering performed by the guard', async () => {
    for (const tamper of ['bytes', 'mode', 'shape'] as const) {
      const f = await fixture()
      let calls = 0
      await expect(
        refreshSkills(f.manifest, f.source, f.vault, {
          force: false,
          async guard() {
            if (++calls !== 3) return
            const [stage] = await readdir(join(f.vault, '.holi/state'))
            const staged = join(f.vault, '.holi/state', stage!, 'demo.new')
            if (tamper === 'bytes') await writeFile(join(staged, 'SKILL.md'), 'tampered')
            if (tamper === 'mode') await chmod(join(staged, 'SKILL.md'), 0o755)
            if (tamper === 'shape') await writeFile(join(staged, 'extra.md'), 'undeclared')
          },
        }),
      ).rejects.toThrow('staged skill changed')
      await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
    }
  })

  it('preserves edits that race with the backup rename on an otherwise successful refresh', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'old')
    const originalRename = skillTransactionFs.rename
    const rename = vi.spyOn(skillTransactionFs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('/demo.original'))
        await writeFile(join(target, 'SKILL.md'), 'concurrent edit')
      return originalRename(from, to)
    })
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} }),
    ).rejects.toThrow(/recovery data preserved/)
    rename.mockRestore()
    const [stage] = await readdir(join(f.vault, '.holi/state'))
    expect(
      await readFile(join(f.vault, '.holi/state', stage!, 'demo.original/SKILL.md'), 'utf8'),
    ).toBe('concurrent edit')
  })

  it('preserves edits made to an original backup before successful cleanup', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'old')
    let guards = 0
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: true,
        async guard() {
          if (++guards !== 4) return
          const [stage] = await readdir(join(f.vault, '.holi/state'))
          await writeFile(
            join(f.vault, '.holi/state', stage!, 'demo.original/SKILL.md'),
            'late edit',
          )
        },
      }),
    ).rejects.toThrow(/committed but staging cleanup failed/)
    const [stage] = await readdir(join(f.vault, '.holi/state'))
    expect(
      await readFile(join(f.vault, '.holi/state', stage!, 'demo.original/SKILL.md'), 'utf8'),
    ).toBe('late edit')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('release v1')
  })

  it('preserves a concurrent target edit and recovery backup when rollback is rejected', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'old')
    await writeFile(join(f.source, 'skills/demo/SKILL.md'), 'new')
    let calls = 0
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: true,
        async guard() {
          calls++
          if ((await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => '')) !== 'new') return
          await writeFile(join(target, 'user.txt'), 'keep me')
          throw Error('final guard rejected')
        },
      }),
    ).rejects.toThrow('rollback incomplete')
    expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('keep me')
    const [stage] = await readdir(join(f.vault, '.holi/state'))
    expect(
      await readFile(join(f.vault, '.holi/state', stage!, 'demo.original/SKILL.md'), 'utf8'),
    ).toBe('old')
  })

  it('never cleans an outside stage alias after the staging parent is replaced during publication', async () => {
    const f = await fixture()
    const outside = join(f.vault, '..', 'holi-522-stage-sentinel')
    await mkdir(outside, { recursive: true })
    const originalRename = skillTransactionFs.rename
    const rename = vi.spyOn(skillTransactionFs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to)
      if (!String(to).includes('/.claude/skills/')) return
      const state = join(f.vault, '.holi/state')
      const stageName = (await readdir(state))[0]!
      const sentinel = join(outside, stageName)
      await mkdir(sentinel)
      await writeFile(join(sentinel, 'sentinel'), 'outside data')
      await rm(state, { recursive: true, force: true })
      await symlink(outside, state)
    })
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} }),
    ).rejects.toThrow('committed but staging cleanup failed')
    rename.mockRestore()
    expect(await readFile(join(outside, (await readdir(outside))[0]!, 'sentinel'), 'utf8')).toBe(
      'outside data',
    )
  })

  it('preserves recovery and outside sentinel when staging ancestry changes during rollback', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'old')
    const outside = join(f.vault, '..', 'holi-522-rollback-sentinel')
    await mkdir(outside, { recursive: true })
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: true,
        async guard() {
          if ((await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => '')) !== 'release v1')
            return
          const state = join(f.vault, '.holi/state')
          const [stage] = await readdir(state)
          const saved = join(f.vault, '.holi/state-recovery')
          await rename(state, saved)
          await mkdir(join(outside, stage!))
          await writeFile(join(outside, stage!, 'sentinel'), 'outside data')
          await symlink(outside, state)
          throw Error('final guard rejected')
        },
      }),
    ).rejects.toThrow('rollback incomplete')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('release v1')
    const [outsideStage] = await readdir(outside)
    expect(await readFile(join(outside, outsideStage!, 'sentinel'), 'utf8')).toBe('outside data')
    const [recoveryStage] = await readdir(join(f.vault, '.holi/state-recovery'))
    expect(
      await readFile(
        join(f.vault, '.holi/state-recovery', recoveryStage!, 'demo.original/SKILL.md'),
        'utf8',
      ),
    ).toBe('old')
  })

  it('rejects undeclared source files before opening them when authenticated metadata is supplied', async () => {
    const f = await fixture()
    await writeFile(join(f.source, 'skills/demo/extra.md'), 'not in git tree')
    await expect(
      transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], f.source, f.vault, {
        force: false,
        guard() {},
        expectedSnapshots: [
          {
            name: 'demo',
            directories: [],
            files: [{ path: 'SKILL.md', bytes: Buffer.from('release v1'), mode: 0o644 }],
          },
        ],
      }),
    ).rejects.toThrow('undeclared file')
  })

  it('restores earlier publications when cancellation occurs between folders', async () => {
    const f = await fixture()
    await mkdir(join(f.source, 'skills', 'other'), { recursive: true })
    await writeFile(join(f.source, 'skills/other/SKILL.md'), 'other')
    let calls = 0
    await expect(
      transactSkillRefresh(
        [
          { path: 'skills/demo', name: 'demo' },
          { path: 'skills/other', name: 'other' },
        ],
        f.source,
        f.vault,
        {
          force: false,
          async guard() {
            calls++
            if (
              await readFile(join(f.vault, '.claude/skills/demo/SKILL.md'), 'utf8').catch(
                () => null,
              )
            )
              throw Error('closed')
          },
        },
      ),
    ).rejects.toThrow('closed')
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
    expect(await readdir(join(f.vault, '.holi/state')).catch(() => [])).toEqual([])
  })

  it('restores an existing folder when its first publication rename fails', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'original bytes')
    const originalRename = skillTransactionFs.rename
    const rename = vi.spyOn(skillTransactionFs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/demo.new')) throw Error('publish failed')
      return originalRename(from, to)
    })
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} }),
    ).rejects.toThrow('publish failed')
    rename.mockRestore()
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('original bytes')
    expect(await readdir(join(f.vault, '.holi/state'))).toEqual([])
  })

  it('rolls back earlier replacements and new folders when a later publication fails', async () => {
    const f = await fixture()
    await mkdir(join(f.source, 'skills/other'), { recursive: true })
    await writeFile(join(f.source, 'skills/other/SKILL.md'), 'other new')
    const demo = join(f.vault, '.claude/skills/demo')
    const other = join(f.vault, '.claude/skills/other')
    await mkdir(demo, { recursive: true })
    await writeFile(join(demo, 'SKILL.md'), 'demo original')
    const originalRename = skillTransactionFs.rename
    const rename = vi.spyOn(skillTransactionFs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/other.new')) throw Error('later publish failed')
      return originalRename(from, to)
    })
    await expect(
      transactSkillRefresh(
        [
          { path: 'skills/demo', name: 'demo' },
          { path: 'skills/other', name: 'other' },
        ],
        f.source,
        f.vault,
        { force: true, guard() {} },
      ),
    ).rejects.toThrow('later publish failed')
    rename.mockRestore()
    expect(await readFile(join(demo, 'SKILL.md'), 'utf8')).toBe('demo original')
    await expect(readFile(join(other, 'SKILL.md'))).rejects.toThrow()
    expect(await readdir(join(f.vault, '.holi/state'))).toEqual([])
  })

  it('preserves the original backup and reports recovery when rollback rename fails', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'recover me')
    await writeFile(join(f.source, 'skills/demo/SKILL.md'), 'release v2')
    const originalRename = skillTransactionFs.rename
    const calls: string[] = []
    const rename = vi.spyOn(skillTransactionFs, 'rename').mockImplementation(async (from, to) => {
      calls.push(`${String(from)} -> ${String(to)}`)
      if (String(from).endsWith('/demo.new')) throw Error('publish failed')
      if (calls.length === 3) throw Error('restore failed')
      return originalRename(from, to)
    })
    let error: Error | undefined
    try {
      await refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} })
    } catch (caught) {
      error = caught as Error
    } finally {
      rename.mockRestore()
    }
    expect(calls).toHaveLength(3)
    expect(error?.message).toContain('rollback incomplete')
    expect(error?.message).toContain('.holi/state/community-skills.local.')
    const stages = await readdir(join(f.vault, '.holi/state'))
    expect(stages).toHaveLength(1)
    expect(
      await readFile(join(f.vault, '.holi/state', stages[0]!, 'demo.original/SKILL.md'), 'utf8'),
    ).toBe('recover me')
  })

  it('awaits asynchronous guards and restores after rejection between backup and publication', async () => {
    const f = await fixture()
    const target = join(f.vault, '.claude/skills/demo')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'original')
    let calls = 0
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: true,
        async guard() {
          if (++calls === 3) throw Error('async cancelled')
        },
      }),
    ).rejects.toThrow('async cancelled')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('original')
    expect(await readdir(join(f.vault, '.holi/state'))).toEqual([])
  })

  it('rejects external destination edits after preflight without overwriting them', async () => {
    const f = await fixture()
    await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} })
    const targetFile = join(f.vault, '.claude/skills/demo/SKILL.md')
    await writeFile(join(f.source, 'skills/demo/SKILL.md'), 'release v2')
    await expect(
      transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], f.source, f.vault, {
        force: true,
        guard() {},
        validateSnapshot: async () => writeFile(targetFile, 'external edit'),
      }),
    ).rejects.toThrow('changed during refresh')
    expect(await readFile(targetFile, 'utf8')).toBe('external edit')
    expect(await readdir(join(f.vault, '.holi/state'))).toEqual([])
  })

  it('does not follow a staging parent replaced after preflight', async () => {
    const f = await fixture()
    const state = join(f.vault, '.holi/state')
    const outside = join(f.vault, '..', 'holi-522-outside')
    await mkdir(outside, { recursive: true })
    await expect(
      transactSkillRefresh([{ path: 'skills/demo', name: 'demo' }], f.source, f.vault, {
        force: false,
        guard() {},
        validateSnapshot: async () => {
          await mkdir(join(f.vault, '.holi'), { recursive: true })
          await symlink(outside, state)
        },
      }),
    ).rejects.toThrow('unsafe skill staging path')
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects destination-parent and staging-directory replacement attacks', async () => {
    const f = await fixture()
    const outside = join(f.vault, '..', 'holi-522-attack')
    await mkdir(outside, { recursive: true })
    let guardCalls = 0
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: false,
        async guard() {
          guardCalls++
          if (!(await readdir(join(f.vault, '.holi/state')).catch(() => [])).length) return
          await rm(join(f.vault, '.claude/skills'), { recursive: true, force: true })
          await symlink(outside, join(f.vault, '.claude/skills'))
        },
      }),
    ).rejects.toThrow('unsafe skill destination')
    expect(await readdir(outside)).toEqual([])

    await rm(join(f.vault, '.claude'), { recursive: true, force: true })
    await mkdir(join(f.vault, '.claude/skills'), { recursive: true })
    guardCalls = 0
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: false,
        async guard() {
          guardCalls++
          const state = join(f.vault, '.holi/state')
          const [stage] = await readdir(state).catch(() => [])
          if (!stage) return
          await rm(join(state, stage), { recursive: true })
          await symlink(outside, join(state, stage))
        },
      }),
    ).rejects.toThrow('unsafe skill staging path')
    expect(guardCalls).toBe(3)
    expect(await readdir(outside)).toEqual([])
    expect(
      await readFile(join(f.vault, '.claude/skills/demo/SKILL.md'), 'utf8').catch(() => null),
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects special source and destination entries',
    async () => {
      const f = await fixture()
      for (const location of ['source', 'destination'] as const) {
        if (location === 'destination')
          await refreshSkills(f.manifest, f.source, f.vault, { force: false, guard() {} })
        const path =
          location === 'source'
            ? join(f.source, 'skills/demo/pipe')
            : join(f.vault, '.claude/skills/demo/pipe')
        const server = createServer()
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(path, resolve)
          })
          await expect(
            refreshSkills(f.manifest, f.source, f.vault, {
              force: location === 'destination',
              guard() {},
            }),
          ).rejects.toThrow(location === 'source' ? 'special file' : 'unsafe destination')
          expect((await lstat(path)).isSocket()).toBe(true)
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
      }
    },
  )

  it('rejects exact, case-aliased, and overlapping destination declarations', async () => {
    const f = await fixture()
    for (const sources of [
      [
        { path: 'skills/demo', name: 'demo' },
        { path: 'skills/demo', name: 'demo' },
      ],
      [
        { path: 'skills/demo', name: 'demo' },
        { path: 'skills/demo', name: 'Demo' },
      ],
      [
        { path: 'skills/demo', name: 'demo' },
        { path: 'skills/demo/child', name: 'child' },
      ],
    ]) {
      await expect(
        transactSkillRefresh(sources, f.source, f.vault, { force: true, guard() {} }),
      ).rejects.toThrow()
    }
  })

  it('checks cancellation before publishing', async () => {
    const f = await fixture()
    await expect(
      refreshSkills(f.manifest, f.source, f.vault, {
        force: false,
        guard() {
          throw Error('closed')
        },
      }),
    ).rejects.toThrow('closed')
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
  })
})
