import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { communityOwner } from '../main/owner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('community installation owner', () => {
  test('shares installation and consent stores and serializes machine mutations', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'holi-community-owner-'))
    roots.push(userData)
    const first = communityOwner({ userData })
    const second = communityOwner({ userData })
    expect(first).toBe(second)

    const entered: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const a = first.mutate(async () => {
      entered.push('a-start')
      await blocked
      entered.push('a-end')
    })
    const b = second.mutate(async () => {
      entered.push('b')
    })
    await Promise.resolve()
    expect(entered).toEqual(['a-start'])
    release()
    await Promise.all([a, b])
    expect(entered).toEqual(['a-start', 'a-end', 'b'])
  })

  test('forwards server events only to the attachment for the captured vault', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'holi-community-owner-'))
    roots.push(userData)
    const owner = communityOwner({ userData })
    const eventsA: unknown[] = []
    const eventsB: unknown[] = []
    const detachA = owner.attach('/vault/a', 'a', {
      emit: (_remote, _name, payload) => eventsA.push(payload),
      frameOrigin: () => () => {},
    })
    owner.attach('/vault/b', 'b', {
      emit: (_remote, _name, payload) => eventsB.push(payload),
      frameOrigin: () => () => {},
    })
    // State changes from the shared supervisor carry the starting vault root.
    owner.supervisor
      .acquire('/vault/a\0sample\0a.md', {
        cwd: userData,
        argv: () => [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        env: () => process.env,
      })
      .catch(() => {})
    // The starting state is synchronous, before readiness waits for the child.
    expect(eventsA).toHaveLength(1)
    expect(eventsB).toHaveLength(0)
    await detachA()
    await owner.supervisor.dispose()
  })
})
