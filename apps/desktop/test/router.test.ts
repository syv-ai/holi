import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRouter } from '../src/main/router'
import { VaultRegistry } from '../src/main/vault/registry'

const REMOTE = 'syv-ai/1brain'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function rig(files: Record<string, string> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'holi-rt-'))
  dirs.push(base)
  const root = join(base, 'clone')
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(join(root, rel), text, 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), text, 'utf8')
    })
  }
  const registry = new VaultRegistry(join(base, 'vaults.json'))
  await registry.add({
    remote: REMOTE,
    path: root,
    name: '1brain',
    lastOpenedAt: '2026-07-01T00:00:00Z',
  })
  const caller = createRouter({ registry, now: () => '2026-07-21T12:00:00Z' }).createCaller({})
  return { caller, root, registry }
}

describe('vaults', () => {
  it('lists the registry', async () => {
    const { caller } = await rig()
    expect((await caller.vaults.list()).map((v) => v.remote)).toEqual([REMOTE])
  })

  it('open returns the vault contents and stamps lastOpenedAt', async () => {
    const { caller, registry } = await rig({ 'a.md': '# A\n' })
    const snap = await caller.vaults.open({ remote: REMOTE })
    expect(snap.docs.map((d) => d.path)).toEqual(['a.md'])
    expect((await registry.list())[0]!.lastOpenedAt).toBe('2026-07-21T12:00:00Z')
  })

  it('rejects an unknown vault once, in one place', async () => {
    const { caller } = await rig()
    await expect(caller.vaults.snapshot({ remote: 'nope/nope' })).rejects.toThrow(/no such vault/)
    await expect(caller.notes.read({ remote: 'nope/nope', path: 'a.md' })).rejects.toThrow(
      /no such vault/,
    )
  })

  it('remove deregisters the vault but leaves the clone on disk', async () => {
    const { caller, root } = await rig({ 'a.md': '# A\n' })
    await caller.vaults.remove({ remote: REMOTE })
    expect(await caller.vaults.list()).toEqual([])
    // unpublished work must never be a casualty of forgetting a vault
    await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('# A\n')
  })
})

describe('notes', () => {
  it('reads and writes', async () => {
    const { caller, root } = await rig({ 'a.md': '# A\n' })
    expect(await caller.notes.read({ remote: REMOTE, path: 'a.md' })).toBe('# A\n')

    await caller.notes.write({ remote: REMOTE, path: 'a.md', text: '# B\n' })
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# B\n')
  })

  it('creates, including the folders on the way', async () => {
    const { caller, root } = await rig()
    await caller.notes.create({ remote: REMOTE, path: 'projects/q2/new.md', text: 'hi' })
    expect(await readFile(join(root, 'projects/q2/new.md'), 'utf8')).toBe('hi')
  })

  it('refuses to create over an existing note', async () => {
    const { caller } = await rig({ 'a.md': 'mine\n' })
    await expect(
      caller.notes.create({ remote: REMOTE, path: 'a.md', text: 'theirs' }),
    ).rejects.toThrow(/already exists/)
  })

  it('reports a missing note rather than returning empty text', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE, path: 'ghost.md' })).rejects.toThrow(/ghost/)
  })

  it('deletes', async () => {
    const { caller } = await rig({ 'a.md': '# A\n' })
    await caller.notes.delete({ remote: REMOTE, path: 'a.md' })
    await expect(caller.notes.read({ remote: REMOTE, path: 'a.md' })).rejects.toThrow()
  })

  it('deleting something already gone is not an error', async () => {
    const { caller } = await rig()
    await expect(caller.notes.delete({ remote: REMOTE, path: 'ghost.md' })).resolves.toEqual({
      ok: true,
    })
  })
})

describe('path safety', () => {
  // The only thing between an input and the user's filesystem, now that
  // server-side authorization is gone.
  const escapes = ['../outside.md', '/etc/passwd', 'a/../../b.md']

  it('refuses to read outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.read({ remote: REMOTE, path })).rejects.toThrow()
    }
  })

  it('refuses to write outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.write({ remote: REMOTE, path, text: 'x' })).rejects.toThrow()
    }
  })

  it('refuses to delete outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.delete({ remote: REMOTE, path })).rejects.toThrow()
    }
  })
})

describe('input validation', () => {
  it('rejects a missing required field', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE } as never)).rejects.toThrow(/path is required/)
  })

  it('rejects a non-string where a string belongs', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE, path: 7 } as never)).rejects.toThrow(
      /path must be a string/,
    )
  })

  it('allows an optional field to be omitted', async () => {
    const { caller } = await rig()
    await expect(caller.notes.create({ remote: REMOTE, path: 'x.md' })).resolves.toEqual({
      path: 'x.md',
    })
  })
})
