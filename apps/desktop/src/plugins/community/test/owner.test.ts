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

  test('forwards server events only to its captured vault and stops its own servers', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'holi-community-owner-'))
    roots.push(userData)
    const owner = communityOwner({ userData })
    const eventsA: unknown[] = []
    const eventsB: unknown[] = []
    const a = owner.attach('/vault/a', 'a', {
      emit: (_remote, _name, payload) => eventsA.push(payload),
      frameOrigin: () => () => {},
    })
    const b = owner.attach('/vault/b', 'b', {
      emit: (_remote, _name, payload) => eventsB.push(payload),
      frameOrigin: () => () => {},
    })
    owner.supervisor
      .acquire('/vault/a\0sample\0a.md', {
        cwd: userData,
        argv: () => [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        env: () => process.env,
      })
      .catch(() => {})
    expect(eventsA).toHaveLength(1)
    expect(eventsB).toHaveLength(0)
    await a.close(async () => {})
    await a.close(async () => {})
    expect(a.isLive()).toBe(false)
    expect(eventsA).toHaveLength(1)
    await b.close(async () => {})
    await owner.supervisor.dispose()
  })

  test('notifies every attachment and closes admission before draining work', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'holi-community-owner-'))
    roots.push(userData)
    const owner = communityOwner({ userData })
    let notificationsA = 0
    let notificationsB = 0
    const a = owner.attach('/vault/a', 'a', { emit: () => {}, frameOrigin: () => () => {} })
    const b = owner.attach('/vault/b', 'b', { emit: () => {}, frameOrigin: () => () => {} })
    a.observeMutations(async () => {
      notificationsA++
    })
    b.observeMutations(async () => {
      notificationsB++
    })
    await owner.mutate(async () => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notificationsA).toBe(1)
    expect(notificationsB).toBe(1)

    let release!: () => void
    let entered!: () => void
    const enteredWork = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = a.run(async () => {
      entered()
      await blocked
    })
    await enteredWork
    let cleanupCount = 0
    const closing = a.close(async () => {
      cleanupCount++
    })
    expect(a.isLive()).toBe(false)
    await expect(a.run(async () => {})).rejects.toThrow('closed')
    const sameClose = a.close(async () => {
      cleanupCount++
    })
    expect(() =>
      owner.attach('/vault/a', 'a-new', { emit: () => {}, frameOrigin: () => () => {} }),
    ).toThrow('already active')
    release()
    await Promise.all([running, closing, sameClose])
    expect(cleanupCount).toBe(1)
    const reopened = owner.attach('/vault/a', 'a-new', {
      emit: () => {},
      frameOrigin: () => () => {},
    })
    await reopened.close(async () => {})
    await b.close(async () => {})
    await owner.supervisor.dispose()
  })
})
