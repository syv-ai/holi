import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createMdxConsentStore } from '../src/main/mdx-consent'

let dir: string
let file: string
let scope: Parameters<ReturnType<typeof createMdxConsentStore>['grant']>[0]
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-mdx-consent-'))
  file = join(dir, 'consent.json')
  scope = {
    origin: 'https://packages.example:8443',
    root: join(dir, 'vault'),
    remote: 'octocat/notes',
    accountId: '123',
  }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('reopens a grant only for the exact vault root, remote, account and HTTPS origin', async () => {
  await createMdxConsentStore(file).grant(scope)
  const reopened = createMdxConsentStore(file)
  expect(await reopened.allows({ ...scope })).toBe(true)
  for (const changed of [
    { root: join(dir, 'another-clone') },
    { remote: 'octocat/other-notes' },
    { accountId: '456' },
    { origin: 'https://packages.example' },
  ]) {
    expect(await reopened.allows({ ...scope, ...changed })).toBe(false)
  }

  for (const origin of [
    'http://packages.example:8443',
    'https://user@packages.example:8443',
    'https://packages.example:8443/dependency',
  ]) {
    await expect(reopened.grant({ ...scope, origin })).rejects.toThrow()
  }
  expect(await reopened.allows(scope)).toBe(true)
})

it('denies missing, corrupt, and malformed state, even beside a valid entry', async () => {
  const store = createMdxConsentStore(file)
  expect(await store.allows(scope)).toBe(false)
  for (const text of [
    '{',
    JSON.stringify({ version: 2, grants: [scope] }),
    JSON.stringify({ version: 1, grants: [scope, { ...scope, accountId: 123 }] }),
    JSON.stringify({ version: 1, grants: [scope, { ...scope, origin: `${scope.origin}/` }] }),
  ]) {
    await writeFile(file, text)
    expect(await store.allows(scope)).toBe(false)
  }
})

// A readable file in a non-writable directory exercises the actual write failure.
// Windows chmod and POSIX root do not enforce this fixture's directory permissions.
it.skipIf(process.getuid === undefined || process.getuid() === 0)(
  'denies failed grants and revocations even when the previous file survives',
  async () => {
    const revoked = { ...scope, origin: 'https://cdn.example' }
    const store = createMdxConsentStore(file)
    await store.grant(scope)
    await store.grant(revoked)

    await chmod(dir, 0o500)
    try {
      await expect(store.grant(scope)).rejects.toThrow()
      await expect(store.revoke(revoked)).rejects.toThrow()
    } finally {
      await chmod(dir, 0o700)
    }

    const reopened = createMdxConsentStore(file)
    expect(await reopened.allows(scope)).toBe(true)
    expect(await reopened.allows(revoked)).toBe(true)
    expect(await store.allows(scope)).toBe(false)
    expect(await store.allows(revoked)).toBe(false)

    await store.grant(scope)
    expect(await store.allows(scope)).toBe(true)
    expect(await store.allows(revoked)).toBe(false)
  },
)

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
