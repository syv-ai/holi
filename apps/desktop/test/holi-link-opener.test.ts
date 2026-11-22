import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { VaultEntry } from '@holi/shared'
import { openHoliLink } from '../src/main/holi-link-opener'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holi-link-'))
  roots.push(root)
  const vault = join(root, 'vault')
  await mkdir(join(vault, 'notes'), { recursive: true })
  await writeFile(join(vault, 'notes', 'Topic.md'), '# Heading\n')
  const entry: VaultEntry = {
    remote: 'syv-ai/team-notes',
    path: vault,
    name: 'team-notes',
    lastOpenedAt: '2026-01-01T00:00:00Z',
  }
  const showPath = vi.fn()
  const vaults = async () => [entry]
  const deps = { vaults, showPath }
  return { root, vault, entry, deps, showPath }
}

test('returns the parser failure without opening', async () => {
  const { deps, showPath } = await fixture()
  await expect(openHoliLink('holi://open?bad=true', deps)).resolves.toEqual({
    ok: false,
    message: 'This link cannot be opened.',
    detail: expect.any(String),
  })
  expect(showPath).not.toHaveBeenCalled()
})

test('reports a vault that is not registered', async () => {
  const { showPath } = await fixture()
  await expect(
    openHoliLink('holi://open?vault=other/repo&path=notes/Topic.md', {
      vaults: async () => [],
      showPath,
    }),
  ).resolves.toMatchObject({ ok: false, message: 'other/repo is not on this computer.' })
  expect(showPath).not.toHaveBeenCalled()
})

test('reports a missing file', async () => {
  const { deps, showPath } = await fixture()
  await expect(
    openHoliLink('holi://open?vault=syv-ai/team-notes&path=missing.md', deps),
  ).resolves.toMatchObject({ ok: false, message: 'missing.md is not in syv-ai/team-notes.' })
  expect(showPath).not.toHaveBeenCalled()
})

test('opens the HTTPS sharing format through the same authoritative checks', async () => {
  const { deps, entry, showPath } = await fixture()
  await expect(
    openHoliLink(
      'https://syv-ai.github.io/holi/#vault=syv-ai/team-notes&path=notes%2FTopic.md&heading=the-heading',
      deps,
    ),
  ).resolves.toEqual({ ok: true })
  expect(showPath).toHaveBeenCalledWith(entry.remote, 'notes/Topic.md', { heading: 'the-heading' })
})

test('matches remote case and forwards path and heading to the shared route', async () => {
  const { deps, entry, showPath } = await fixture()
  await expect(
    openHoliLink(
      'holi://open?vault=SYV-AI/TEAM-NOTES&path=notes/Topic.md&heading=the-heading',
      deps,
    ),
  ).resolves.toEqual({ ok: true })
  expect(showPath).toHaveBeenCalledWith(entry.remote, 'notes/Topic.md', { heading: 'the-heading' })
})

test('exactPath rejects a symlink out of the vault', async () => {
  const { root, vault, deps, showPath } = await fixture()
  await writeFile(join(root, 'outside.md'), 'outside')
  await symlink(join(root, 'outside.md'), join(vault, 'escape.md'))
  await expect(
    openHoliLink('holi://open?vault=syv-ai/team-notes&path=escape.md', deps),
  ).resolves.toMatchObject({ ok: false, message: 'escape.md is not in syv-ai/team-notes.' })
  expect(showPath).not.toHaveBeenCalled()
})
