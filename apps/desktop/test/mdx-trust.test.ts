import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalGitHubRemote, createMdxTrustStore } from '../src/main/mdx-trust'

// Force an asynchronous rename to yield before submitting its filesystem work.
// The production ownership guard and synchronous atomic commit must not yield.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await Promise.resolve()
      return actual.rename(...args)
    },
  }
})

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-mdx-trust-'))
  file = join(dir, 'mdx-trust.json')
})
afterEach(async () => rm(dir, { recursive: true, force: true }))

const alice = { accountId: '42', remote: 'Syv-Ai/Notes' }

describe('mdx trust', () => {
  it('canonicalizes HTTPS, SSH, and plain remotes', () => {
    expect(canonicalGitHubRemote('https://github.com/Syv-Ai/Notes.git')).toBe('syv-ai/notes')
    expect(canonicalGitHubRemote('git@github.com:SYV-AI/NOTES.git')).toBe('syv-ai/notes')
  })

  it('persists grants over restart and isolates accounts and remotes', async () => {
    const first = createMdxTrustStore(file)
    await first.approve(alice)
    const restarted = createMdxTrustStore(file)
    expect(
      await restarted.status({ ...alice, remote: 'https://github.com/syv-ai/notes.git' }),
    ).toBe(true)
    expect(await restarted.status({ ...alice, accountId: '43' })).toBe(false)
    expect(await restarted.status({ ...alice, remote: 'syv-ai/other' })).toBe(false)
  })

  it('fails closed on malformed, unsupported, and unreadable state', async () => {
    const store = createMdxTrustStore(file)
    await writeFile(file, '{bad')
    await expect(store.status(alice)).rejects.toThrow()
    await writeFile(file, JSON.stringify({ version: 2, grants: [] }))
    await expect(store.status(alice)).rejects.toThrow()
    await rm(file)
    await writeFile(file, 'locked')
    await rm(file)
    await writeFile(file, 'not json')
    await expect(store.approve(alice)).rejects.toThrow()
  })

  it('rechecks ownership immediately before the atomic persistence commit', async () => {
    const store = createMdxTrustStore(file)
    let owned = true
    await store.approve(alice, () => owned)
    expect(await store.status(alice)).toBe(true)
    owned = false
    await expect(store.revoke(alice, () => owned)).rejects.toThrow(/context changed/)
    expect(await store.status(alice)).toBe(true)
  })

  it('fails writes without reporting approval and keeps concurrent grants', async () => {
    const store = createMdxTrustStore(dir)
    await expect(store.approve(alice)).rejects.toThrow()
    const working = createMdxTrustStore(file)
    await Promise.all([
      working.approve(alice),
      working.approve({ accountId: '42', remote: 'syv-ai/other' }),
      working.approve({ accountId: '43', remote: 'syv-ai/notes' }),
    ])
    const state = JSON.parse(await readFile(file, 'utf8')) as { grants: string[] }
    expect(state.grants).toHaveLength(3)
    await working.revoke(alice)
    expect(await working.status(alice)).toBe(false)
    expect((JSON.parse(await readFile(file, 'utf8')) as { grants: string[] }).grants).toHaveLength(
      2,
    )
  })
})

it('rejects malformed grant entries even alongside a valid matching grant', async () => {
  await writeFile(file, JSON.stringify({ version: 1, grants: ['42:syv-ai/notes', 'not-a-grant'] }))
  await expect(createMdxTrustStore(file).status(alice)).rejects.toThrow(/unreadable/)
})

it('refuses unverified account identities and recovers after a failed atomic write', async () => {
  const store = createMdxTrustStore(file)
  await expect(store.approve({ ...alice, accountId: '-1' })).rejects.toThrow(/identity/)
  await mkdir(`${file}.tmp`)
  await expect(store.approve(alice)).rejects.toThrow()
  expect(await store.status(alice)).toBe(false)
  await rm(`${file}.tmp`, { recursive: true })
  await store.approve(alice)
  expect(await store.status(alice)).toBe(true)
})

it('treats an unreadable directory as an error, not an approved or repairable trust file', async () => {
  await mkdir(file)
  const store = createMdxTrustStore(file)
  await expect(store.status(alice)).rejects.toThrow()
  await expect(store.approve(alice)).rejects.toThrow()
})

it('atomically commits before an owner change queued by the final guard can run', async () => {
  const store = createMdxTrustStore(file)
  let owned = true
  let committedBeforeDeparture = false
  await store.approve(alice, () => {
    queueMicrotask(() => {
      committedBeforeDeparture = existsSync(file)
      owned = false
    })
    return owned
  })
  expect(owned).toBe(false)
  expect(committedBeforeDeparture).toBe(true)
  // Departure after the atomic commit cannot turn prior explicit consent into
  // a departure-spanning write. The committed grant belonged to its live owner.
  expect(await store.status(alice)).toBe(true)
})
