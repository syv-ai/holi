import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalGitHubRemote, createMdxTrustStore } from '../src/main/mdx-trust'

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
