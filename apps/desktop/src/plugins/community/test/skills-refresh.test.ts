import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshSkills } from '../main/skills'
import { transactSkillRefresh } from '../main/skill-transaction'

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
          guard() {
            if (++calls === 3) throw Error('closed')
          },
        },
      ),
    ).rejects.toThrow('closed')
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
    expect(await readdir(join(f.vault, '.holi/state'))).toEqual([])
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
