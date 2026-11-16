import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentScratchRoots } from '../main/host/scratch-roots'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('assigns opaque private scratch roots to canonical remote and clone contexts', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'holi-agent-scratch-roots-'))
  dirs.push(userData)
  const vaultRoot = join(userData, 'vault')
  const aliasRoot = join(userData, 'alias')
  const otherRoot = join(userData, 'other-vault')
  await Promise.all([mkdir(vaultRoot), mkdir(otherRoot)])
  await symlink(vaultRoot, aliasRoot)

  const first = await agentScratchRoots(userData, {
    remote: '../../attacker/../repo',
    root: vaultRoot,
  })
  const alias = await agentScratchRoots(userData, {
    remote: '../../attacker/../repo',
    root: aliasRoot,
  })
  const otherClone = await agentScratchRoots(userData, {
    remote: '../../attacker/../repo',
    root: otherRoot,
  })
  const otherRemote = await agentScratchRoots(userData, {
    remote: '../other',
    root: vaultRoot,
  })

  expect(alias).toEqual(first)
  expect(otherClone.jobs).not.toBe(first.jobs)
  expect(otherRemote.jobs).not.toBe(first.jobs)
  for (const path of [first.jobs, first.fenced, otherClone.jobs, otherRemote.jobs]) {
    expect(path.startsWith(join(userData, 'agent-scratch') + sep)).toBe(true)
    expect(path).not.toContain('attacker')
    expect(path).not.toContain('..')
  }
  const ownerRoot = join(first.jobs, '..')
  const ownerStat = await lstat(ownerRoot)
  expect(ownerStat.isDirectory()).toBe(true)
  expect(ownerStat.mode & 0o077).toBe(0)
})
