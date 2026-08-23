import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVaultAccounts } from '../src/main/google/vault-accounts'

const dirs: string[] = []
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-vault-accounts-'))
  dirs.push(dir)
  return join(dir, 'google-vault-accounts.json')
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const VAULT = 'nthomsencph/privat'
const WORK = 'syv/krifa'
const SUB = '104729384756102938475'
const OTHER_SUB = '118273645500011122233'

describe('createVaultAccounts', () => {
  it('reads as empty before anything is written', async () => {
    const store = createVaultAccounts(await tempFile())
    expect(await store.subFor(VAULT)).toBeNull()
    expect(await store.all()).toEqual({})
  })

  it('remembers which account a vault uses', async () => {
    const store = createVaultAccounts(await tempFile())
    await store.link(VAULT, SUB)
    expect(await store.subFor(VAULT)).toBe(SUB)
  })

  it('replaces a vault choice rather than accumulating one', async () => {
    const store = createVaultAccounts(await tempFile())
    await store.link(VAULT, SUB)
    await store.link(VAULT, OTHER_SUB)
    expect(await store.subFor(VAULT)).toBe(OTHER_SUB)
    expect(await store.all()).toEqual({ [VAULT]: OTHER_SUB })
  })

  it('lets two vaults share one account', async () => {
    // Many-to-one is the shape D87 asks for: a vault has at most one account,
    // an account may serve several vaults.
    const store = createVaultAccounts(await tempFile())
    await store.link(VAULT, SUB)
    await store.link(WORK, SUB)
    expect(await store.all()).toEqual({ [VAULT]: SUB, [WORK]: SUB })
  })

  it('unlinks one vault and leaves the other alone', async () => {
    const store = createVaultAccounts(await tempFile())
    await store.link(VAULT, SUB)
    await store.link(WORK, SUB)

    await store.unlinkVault(VAULT)

    expect(await store.subFor(VAULT)).toBeNull()
    expect(await store.subFor(WORK)).toBe(SUB)
  })

  it('unlinks every vault pointing at a removed account, and only those', async () => {
    const store = createVaultAccounts(await tempFile())
    await store.link(VAULT, SUB)
    await store.link(WORK, SUB)
    await store.link('a/third', OTHER_SUB)

    await store.unlinkAccount(SUB)

    expect(await store.all()).toEqual({ 'a/third': OTHER_SUB })
  })

  it('unlinking a vault that was never linked is a no-op, not an error', async () => {
    const store = createVaultAccounts(await tempFile())
    await store.unlinkVault(VAULT)
    expect(await store.all()).toEqual({})
  })

  it('reads a corrupt file as empty rather than throwing', async () => {
    // A hand-edit gone wrong costs the user their links, never their mail.
    const path = await tempFile()
    await writeFile(path, '{ not json', 'utf8')
    const store = createVaultAccounts(path)
    expect(await store.all()).toEqual({})
  })

  it('drops an entry that is not a string and keeps its siblings', async () => {
    const path = await tempFile()
    await writeFile(path, JSON.stringify({ [VAULT]: SUB, [WORK]: 42 }), 'utf8')
    const store = createVaultAccounts(path)
    expect(await store.all()).toEqual({ [VAULT]: SUB })
  })

  it('leaves no temporary file behind', async () => {
    // Written aside and renamed, so a crash mid-write cannot truncate the file
    // and cost every link at once.
    const path = await tempFile()
    const store = createVaultAccounts(path)
    await store.link(VAULT, SUB)
    const entries = await readdir(join(path, '..'))
    expect(entries).toEqual(['google-vault-accounts.json'])
  })
})
