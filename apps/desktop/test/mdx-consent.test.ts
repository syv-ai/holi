import { mkdirSync, renameSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createMdxConsentStore } from '../src/main/mdx-consent'

let dir: string
let file: string
let scope: Parameters<ReturnType<typeof createMdxConsentStore>['grant']>[0]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-mdx-consent-'))
  file = join(dir, 'consent.json')
  scope = {
    origin: 'https://packages.example',
    root: join(dir, 'vault'),
    remote: 'octocat/notes',
    accountId: '123',
  }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('reopens a grant only for the exact vault root, remote, account and HTTPS origin', async () => {
  const store = createMdxConsentStore(file)
  await store.grant(scope)
  const foreign = {
    origin: 'https://foreign.example',
    root: join(dir, 'absent-vault'),
    remote: 'someone/other',
    accountId: '456',
  }
  await store.grant(foreign)
  const reopened = createMdxConsentStore(file)
  expect(await reopened.allows(foreign)).toBe(true)
  expect(await reopened.listGrants(scope)).toEqual([{ origin: scope.origin }])
  expect(await reopened.allows({ ...scope })).toBe(true)
  for (const changed of [
    { root: join(dir, 'another-clone') },
    { remote: 'octocat/other-notes' },
    { accountId: '456' },
    { origin: 'https://cdn.example' },
  ]) {
    expect(await reopened.allows({ ...scope, ...changed })).toBe(false)
  }

  for (const origin of [
    'http://packages.example',
    'https://user@packages.example',
    'https://packages.example/dependency',
    'https://packages.example:8443',
    'https://*.packages.example',
  ]) {
    await expect(reopened.grant({ ...scope, origin })).rejects.toThrow()
  }
  expect(await reopened.allows(scope)).toBe(true)
})

it('denies missing, corrupt, and malformed state, even beside a valid entry', async () => {
  const store = createMdxConsentStore(file)
  expect(await store.allows(scope)).toBe(false)
  const invalid = [
    { accountId: 123 },
    { accountId: '0' },
    { accountId: '0123' },
    { accountId: '123\n' },
    { accountId: '9007199254740992' },
    { root: 'vault' },
    { root: `${scope.root}${sep}.${sep}folder` },
    { root: `${scope.root}${sep}..${sep}vault` },
    { root: `${scope.root}${sep}` },
    { root: `${scope.root}\0` },
    { remote: 'Octocat/notes' },
    { remote: 'https://github.com/octocat/notes.git' },
    { remote: 'octocat/.' },
    { origin: `${scope.origin}/` },
    { origin: `${scope.origin}:8443` },
    { origin: 'https://*.example' },
  ]
  for (const text of [
    '{',
    JSON.stringify({ version: 2, grants: [scope] }),
    ...invalid.map((fields) =>
      JSON.stringify({ version: 1, grants: [scope, { ...scope, ...fields }] }),
    ),
  ]) {
    await writeFile(file, text)
    expect(await store.allows(scope)).toBe(false)
    await expect(store.listGrants(scope)).rejects.toThrow()
  }
})

it('allows canonical Windows drive and UNC paths but denies mixed files with malformed components', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const store = createMdxConsentStore(file)
    const control = { ...scope, root: 'C:\\old\\vault' }
    const save = (grants: (typeof scope)[]) =>
      writeFile(file, JSON.stringify({ version: 1, grants }))
    for (const root of [
      'C:\\',
      '\\\\server\\share\\',
      '\\\\server\\share\\old\\vault',
      control.root,
    ]) {
      const grant = { ...scope, root }
      await save([grant])
      expect(await store.allows(grant), root).toBe(true)
    }

    for (const [anchor, part] of [
      ['C:\\old\\', 'bad\x01name'],
      ['C:\\old\\', 'bad\x1fname'],
      ['C:\\old\\', 'bad\x7fname'],
      ['C:\\old\\', 'cOn'],
      ['C:\\old\\', 'CONIN$'],
      ['C:\\old\\', 'conout$.txt'],
      ['C:\\old\\', 'PrN.txt'],
      ['C:\\old\\', 'AUX .txt'],
      ['C:\\old\\', 'Nul.tar.gz'],
      ['C:\\old\\', 'COM1'],
      ['C:\\old\\', 'lpt9.mdx'],
      ['C:\\old\\', 'COM¹.txt'],
      ['C:\\old\\', 'LPT²'],
      ['C:\\old\\', 'folder.'],
      ['C:\\old\\', 'folder '],
      ['C:\\old\\', 'file:stream'],
      ['C:\\old\\', 'file?name'],
      ['\\\\server\\share\\', 'LPT3.txt'],
    ]) {
      const malformed = { ...scope, root: `${anchor}${part}\\vault` }
      await save([control, malformed])
      expect(await store.allows(control), malformed.root).toBe(false)
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
  }
})

// A readable file in a non-writable directory exercises the actual write failure.
// Windows chmod and POSIX root do not enforce this fixture's directory permissions.
it.skipIf(process.getuid === undefined || process.getuid() === 0)(
  'denies failed grants and revocations even when the previous file survives',
  async () => {
    const revoked = { ...scope, origin: 'https://cdn.example' }
    const store = createMdxConsentStore(file)
    await store.grant(revoked)

    await chmod(dir, 0o500)
    try {
      await expect(store.grant(scope)).rejects.toThrow()
      await expect(store.revoke(revoked)).rejects.toThrow()
      await expect(store.drain()).rejects.toThrow()
    } finally {
      await chmod(dir, 0o700)
    }

    const reopened = createMdxConsentStore(file)
    expect(await reopened.allows(scope)).toBe(false)
    expect(await reopened.allows(revoked)).toBe(true)
    expect(await store.allows(scope)).toBe(false)
    expect(await store.allows(revoked)).toBe(false)
    expect(await store.listGrants(scope)).toEqual([
      { origin: revoked.origin, revocationPending: true },
    ])

    await expect(store.grant(revoked)).rejects.toThrow()
    await store.grant(scope)
    expect(await store.allows(scope)).toBe(true)
    expect(await store.allows(revoked)).toBe(false)
    await store.revoke(revoked)
    expect(await store.listGrants(scope)).toEqual([{ origin: scope.origin }])
    expect(await createMdxConsentStore(file).allows(revoked)).toBe(false)
  },
)

it('publishes only saved removals, even when a drain partially succeeds', async () => {
  const store = createMdxConsentStore(file)
  const alsoRevoked = { ...scope, origin: 'https://cdn.example', accountId: '456' }
  const kept = { ...scope, accountId: '789' }
  for (const grant of [scope, alsoRevoked, kept]) await store.grant(grant)
  const backup = `${file}.backup`
  const saved: (typeof scope)[] = []
  const stop = store.onRevocationSaved((removed) => {
    saved.push(removed)
    if (saved.length === 1) {
      // Storage fails again as soon as one removal is published.
      renameSync(file, backup)
      mkdirSync(file)
    }
  })
  await rename(file, backup)
  await mkdir(file)
  await expect(store.revoke(scope)).rejects.toThrow()
  await expect(store.revoke(alsoRevoked)).rejects.toThrow()
  await expect(store.drain()).rejects.toThrow()
  expect(saved).toEqual([])
  await rm(file, { recursive: true })
  await rename(backup, file)

  await expect(store.drain()).rejects.toThrow()
  expect(saved).toHaveLength(1)
  await rm(file, { recursive: true })
  await rename(backup, file)
  for (const revoked of [scope, alsoRevoked]) {
    const published = saved.some(({ origin }) => origin === revoked.origin)
    expect(await createMdxConsentStore(file).allows(revoked)).toBe(!published)
    expect(await store.allows(revoked)).toBe(false)
    expect(await store.listGrants(revoked)).toEqual(
      published ? [] : [{ origin: revoked.origin, revocationPending: true }],
    )
  }
  await expect(store.drain()).resolves.toBeUndefined()
  expect(saved).toHaveLength(2)
  expect(saved).toEqual(expect.arrayContaining([scope, alsoRevoked]))
  stop()
  const reopened = createMdxConsentStore(file)
  for (const revoked of [scope, alsoRevoked]) {
    expect(await store.allows(revoked)).toBe(false)
    expect(await reopened.allows(revoked)).toBe(false)
  }
  expect(await reopened.allows(kept)).toBe(true)
})

it('does not publish an approval after its owner retires during the grant', async () => {
  const store = createMdxConsentStore(file)
  const lifetime = new AbortController()
  const approval = store.grant(scope, () => !lifetime.signal.aborted)
  await Promise.resolve()
  lifetime.abort()
  await expect(approval).rejects.toThrow()
  expect(await store.allows(scope)).toBe(false)
  expect(await createMdxConsentStore(file).allows(scope)).toBe(false)
})

it('keeps unrelated concurrent grants without letting an older approval undo revocation', async () => {
  const store = createMdxConsentStore(file)
  const unrelated = { ...scope, origin: 'https://cdn.example' }
  const kept = { ...scope, origin: 'https://assets.example' }
  await store.grant(scope)
  await store.grant(kept)

  const approval = store.grant(scope)
  const checking = store.allows(scope)
  await Promise.resolve()
  await Promise.all([
    expect(approval).rejects.toThrow(),
    expect(checking).resolves.toBe(false),
    store.grant(unrelated),
    store.revoke(scope),
  ])

  const reopened = createMdxConsentStore(file)
  expect(await reopened.allows(scope)).toBe(false)
  expect(await reopened.allows(unrelated)).toBe(true)
  expect(await reopened.allows(kept)).toBe(true)
})
