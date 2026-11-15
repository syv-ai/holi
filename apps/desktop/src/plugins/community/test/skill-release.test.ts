import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SkillSnapshot } from '../main/skill-transaction'
import { assertManifestPinned, gitModeMatches, validateSkillSnapshot } from '../main/skill-release'
import { refreshSkills } from '../main/skills'

const roots: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function fixture(path = '') {
  const root = await mkdtemp(join(tmpdir(), 'holi-522-release-'))
  roots.push(root)
  const release = join(root, 'release')
  const plugin = join(release, path)
  const vault = join(root, 'vault')
  const skill = join(plugin, 'skills/demo')
  await mkdir(skill, { recursive: true })
  await mkdir(vault)
  await writeFile(join(skill, 'SKILL.md'), 'description\n')
  await writeFile(join(skill, 'binary.bin'), Buffer.from([0, 255, 10, 13]))
  await writeFile(join(skill, 'trailing.txt'), 'ends with newline\n')
  await writeFile(join(plugin, 'holi-plugin.json'), '{}')
  git(release, 'init', '-q', '-b', 'main')
  git(release, 'add', '.')
  git(
    release,
    '-c',
    'user.name=Holi',
    '-c',
    'user.email=holi@example.test',
    'commit',
    '-qm',
    'release',
  )
  const commit = git(release, 'rev-parse', 'HEAD')
  return { release, plugin, skill, vault, commit, sourcePath: path, skills: ['skills/demo'] }
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>): Promise<SkillSnapshot[]> {
  let found: readonly SkillSnapshot[] | undefined
  const stop = new Error('captured snapshot')
  await expect(
    refreshSkills({ skills: f.skills }, f.plugin, f.vault, {
      force: true,
      guard() {},
      validateSnapshot(value) {
        found = value
        throw stop
      },
    }),
  ).rejects.toBe(stop)
  return found!.map((item) => ({
    name: item.name,
    directories: [...item.directories],
    files: item.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
  }))
}

async function commit(f: Awaited<ReturnType<typeof fixture>>) {
  git(f.release, 'add', '.')
  git(
    f.release,
    '-c',
    'user.name=Holi',
    '-c',
    'user.email=holi@example.test',
    'commit',
    '-qm',
    'change',
  )
  return git(f.release, 'rev-parse', 'HEAD')
}

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

describe('pinned skill release verification', () => {
  it.each(['', 'nested/plugin'])(
    'verifies virtual output including contained directory and nested file links (%s)',
    async (path) => {
      const f = await fixture(path)
      await mkdir(join(f.plugin, 'shared/nested'), { recursive: true })
      await writeFile(join(f.plugin, 'content.bin'), Buffer.from([0, 255, 0]))
      await writeFile(join(f.plugin, 'shared/nested/file.md'), 'nested\n')
      await symlink('../../shared', join(f.skill, 'linked-dir'))
      await symlink('../../content.bin', join(f.plugin, 'shared/nested/file-link.bin'))
      await symlink('../../shared/nested', join(f.skill, 'nested-link'))
      await chmod(join(f.skill, 'binary.bin'), 0o755)
      const pin = await commit(f)
      const files = await snapshot(f)
      await expect(
        validateSkillSnapshot(f.release, pin, path, f.skills, files),
      ).resolves.toBeDefined()
      expect(files[0]!.files.map(({ path: name }) => name)).toContain(
        'linked-dir/nested/file-link.bin',
      )
      expect(files[0]!.files.map(({ path: name }) => name)).toContain('nested-link/file.md')
    },
  )

  it('rejects cyclic and escaping Git symlinks while preserving the original snapshot proof', async () => {
    const f = await fixture()
    const original = await snapshot(f)
    await symlink('loop', join(f.skill, 'loop'))
    const cycle = await commit(f)
    await expect(validateSkillSnapshot(f.release, cycle, '', f.skills, original)).rejects.toThrow(
      /cyclic/,
    )
    await rm(join(f.skill, 'loop'))
    await symlink('../../../outside', join(f.skill, 'escape'))
    const escape = await commit(f)
    await expect(validateSkillSnapshot(f.release, escape, '', f.skills, original)).rejects.toThrow(
      /escapes/,
    )
  })

  it('rejects required-file symlinks and changed, extra, or missing snapshot shape', async () => {
    const f = await fixture()
    const files = await snapshot(f)
    const original = f.commit
    await writeFile(join(f.skill, 'working-tree-only.txt'), 'not in pin')
    await expect(
      validateSkillSnapshot(f.release, original, '', f.skills, files),
    ).resolves.toBeDefined()
    await expect(
      validateSkillSnapshot(f.release, original, '', f.skills, [
        {
          ...files[0]!,
          files: [...files[0]!.files, { path: 'extra', bytes: Buffer.from('x'), mode: 0o644 }],
        },
      ]),
    ).rejects.toThrow(/shape/)
    await expect(
      validateSkillSnapshot(f.release, original, '', f.skills, [
        { ...files[0]!, files: files[0]!.files.slice(1) },
      ]),
    ).rejects.toThrow(/shape/)
    await expect(
      validateSkillSnapshot(f.release, original, '', f.skills, [
        {
          ...files[0]!,
          files: [files[0]!.files[0]!, files[0]!.files[0]!, ...files[0]!.files.slice(2)],
        },
      ]),
    ).rejects.toThrow(/shape/)
    await expect(
      validateSkillSnapshot(f.release, original, '', f.skills, [
        { ...files[0]!, directories: ['missing'] },
      ]),
    ).rejects.toThrow(/shape/)
    await rm(join(f.skill, 'SKILL.md'))
    await symlink('binary.bin', join(f.skill, 'SKILL.md'))
    const pin = await commit(f)
    await expect(validateSkillSnapshot(f.release, pin, '', f.skills, files)).rejects.toThrow(
      /SKILL.md/,
    )
  })

  it('rejects a missing promisor blob without executing an ext transport helper', async () => {
    const f = await fixture()
    const marker = join(f.release, 'helper-ran')
    const blob = git(f.release, 'rev-parse', `${f.commit}:skills/demo/SKILL.md`)
    const object = join(f.release, '.git/objects', blob.slice(0, 2), blob.slice(2))
    await rm(object)
    git(f.release, 'config', 'extensions.partialClone', 'origin')
    git(f.release, 'config', 'remote.origin.promisor', 'true')
    git(f.release, 'config', 'remote.origin.partialCloneFilter', 'blob:none')
    git(f.release, 'config', 'remote.origin.url', `ext::touch ${marker}`)
    git(f.release, 'config', 'protocol.ext.allow', 'always')
    const started = Date.now()
    const sourceSnapshot = await snapshot(f)
    await expect(
      validateSkillSnapshot(f.release, f.commit, '', f.skills, sourceSnapshot),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(4_000)
    await expect(readFile(marker)).rejects.toThrow()
  })

  it('authenticates commit and every raw tree object before trusting paths', async () => {
    const f = await fixture()
    const commitObject = join(f.release, '.git/objects', f.commit.slice(0, 2), f.commit.slice(2))
    const packedCommit = inflateSync(await readFile(commitObject))
    await chmod(commitObject, 0o644)
    const commitBody = packedCommit.subarray(packedCommit.indexOf(0) + 1)
    const changedCommit = Buffer.from(commitBody.toString().replace('release', 'tamper!'))
    await writeFile(
      commitObject,
      deflateSync(Buffer.concat([Buffer.from(`commit ${changedCommit.length}\0`), changedCommit])),
    )
    await expect(validateSkillSnapshot(f.release, f.commit, '', f.skills, [])).rejects.toThrow(
      /commit/,
    )
  })

  it('rejects loose tree tampering under the original object name', async () => {
    const f = await fixture()
    const treeOid = git(f.release, 'rev-parse', `${f.commit}:skills/demo`)
    const treeObject = join(f.release, '.git/objects', treeOid.slice(0, 2), treeOid.slice(2))
    await chmod(treeObject, 0o644)
    const packedTree = inflateSync(await readFile(treeObject))
    const treeBody = packedTree.subarray(packedTree.indexOf(0) + 1)
    const altered = Buffer.from(treeBody)
    const blob = git(f.release, 'rev-parse', `${f.commit}:skills/demo/SKILL.md`)
    const oidBytes = Buffer.from(blob, 'hex')
    const index = altered.indexOf(oidBytes)
    expect(index).toBeGreaterThanOrEqual(0)
    altered[index] = altered[index]! ^ 1
    await writeFile(
      treeObject,
      deflateSync(Buffer.concat([Buffer.from(`tree ${altered.length}\0`), altered])),
    )
    await expect(validateSkillSnapshot(f.release, f.commit, '', f.skills, [])).rejects.toThrow(
      /tree/,
    )
  })

  it('accepts equivalent normalized manifests and rejects meaningful differences', async () => {
    const f = await fixture()
    const manifest = {
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      skills: f.skills,
    }
    await writeFile(join(f.plugin, 'holi-plugin.json'), JSON.stringify(manifest))
    const pin = await commit(f)
    const parsed = { skills: f.skills, version: '1.0.0', name: 'Demo', id: 'demo', opens: [] }
    await expect(assertManifestPinned(f.release, pin, '', parsed)).resolves.toBeUndefined()
    await expect(
      assertManifestPinned(f.release, pin, '', { ...parsed, name: 'Other' }),
    ).rejects.toThrow(/manifest/)
  })

  it('accepts private read/write modes while enforcing Git executable intent', async () => {
    const f = await fixture()
    await writeFile(join(f.skill, 'run.sh'), '#!/bin/sh\ntrue\n')
    await chmod(join(f.skill, 'binary.bin'), 0o600)
    await chmod(join(f.skill, 'run.sh'), 0o700)
    const pin = await commit(f)
    const files = await snapshot(f)
    expect(files[0]!.files.find((file) => file.path === 'binary.bin')!.mode & 0o777).toBe(0o600)
    expect(files[0]!.files.find((file) => file.path === 'run.sh')!.mode & 0o111).not.toBe(0)
    await expect(validateSkillSnapshot(f.release, pin, '', f.skills, files)).resolves.toBeDefined()
  })

  it('compares executable intent rather than private permission bits', () => {
    expect(gitModeMatches('100644', 0o600, 'linux')).toBe(true)
    expect(gitModeMatches('100755', 0o700, 'linux')).toBe(true)
    expect(gitModeMatches('100644', 0o755, 'linux')).toBe(false)
    expect(gitModeMatches('100755', 0o666, 'win32')).toBe(true)
    expect(gitModeMatches('100644', 0o777, 'win32')).toBe(true)
    expect(gitModeMatches('120000', 0o777, 'win32')).toBe(false)
  })
})
