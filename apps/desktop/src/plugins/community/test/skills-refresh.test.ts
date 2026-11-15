import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshSkills } from '../main/skills'

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
    expect(await refreshSkills(f.manifest, f.source, f.vault, { force: true, guard() {} })).toEqual(
      ['.claude/skills/demo'],
    )
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('release v1')
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
