/**
 * Removing a deleted meeting's files from the vault: its own files go, a task
 * made from it keeps the folder, and an emptied folder goes too. A path
 * outside the vault is refused.
 */
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { removeVaultFiles } from '../main/vault-write'

const FOLDER = 'Meetings/2026-11-02 Planning'

async function vault(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-vault-'))
  await mkdir(join(root, FOLDER), { recursive: true })
  for (const f of files) await writeFile(join(root, FOLDER, f), 'x')
  return root
}

const own = ['transcript.local.md', 'minutes.local.md', 'minutes.md'].map((f) => `${FOLDER}/${f}`)

test('a task made from the meeting keeps its folder', async () => {
  const root = await vault(['transcript.local.md', 'minutes.local.md', 'task.export.md'])
  await removeVaultFiles(root, own, FOLDER)
  expect(await readdir(join(root, FOLDER))).toEqual(['task.export.md'])
})

test('a folder left empty goes with the files', async () => {
  const root = await vault(['transcript.local.md', 'minutes.md'])
  await removeVaultFiles(root, own, FOLDER)
  expect(await readdir(join(root, 'Meetings'))).toEqual([])
})

test('a path outside the vault is refused', async () => {
  const root = await vault(['transcript.local.md'])
  await expect(removeVaultFiles(root, ['../outside.md'], FOLDER)).rejects.toThrow()
  expect(await readdir(join(root, FOLDER))).toEqual(['transcript.local.md'])
})
