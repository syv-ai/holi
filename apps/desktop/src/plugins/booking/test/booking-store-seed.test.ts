import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOOKING_INFO } from '../info'
import { bookingSeed } from '../main/seed'
import type { SafeStorageLike } from '../../../main/plugin-api'
import { createSessionStore } from '../main/session-store'

const reversing = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...s].reverse().join('')),
  decryptString: (b) => [...b.toString()].reverse().join(''),
})

const tokens = {
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: 1,
  userId: 'u',
  email: 'me@example.test',
}

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('the booking session file', () => {
  it('round-trips, and holds no token in the clear', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holi-booking-'))
    const file = join(dir, 'booking-session.enc')
    const store = createSessionStore(file, reversing())
    await store.write(tokens)
    expect(await readFile(file, 'utf8')).not.toContain('refresh-secret')
    expect(await store.read()).toEqual(tokens)
    await store.clear()
    expect(await store.read()).toBeNull()
  })

  it('never writes when the keychain cannot encrypt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holi-booking-'))
    const file = join(dir, 'booking-session.enc')
    await expect(createSessionStore(file, reversing(false)).write(tokens)).rejects.toThrow(
      /keychain/,
    )
    await expect(readFile(file)).rejects.toThrow()
  })

  it('lands writes and a clear in the order they were asked for', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holi-booking-'))
    const store = createSessionStore(join(dir, 'booking-session.enc'), reversing())
    // Two writes at once (a refresh and a sign-in) both land, the later last.
    await Promise.all([store.write(tokens), store.write({ ...tokens, accessToken: 'newer' })])
    expect((await store.read())?.accessToken).toBe('newer')
    // A sign-out asked for while a refresh is still writing is not undone by it.
    await Promise.all([store.write(tokens), store.clear()])
    expect(await store.read()).toBeNull()
  })

  it('reads a file it cannot make sense of as signed out', async () => {
    dir = await mkdtemp(join(tmpdir(), 'holi-booking-'))
    const file = join(dir, 'booking-session.enc')
    await writeFile(file, '{"v":1,"data":"bm9wZQ=="}')
    expect(await createSessionStore(file, reversing()).read()).toBeNull()
  })
})

describe('Mødelokale Booking seed', () => {
  it('is the plugin of its id, off unless a vault turns it on', () => {
    expect(bookingSeed.id).toBe(BOOKING_INFO.id)
    expect(BOOKING_INFO.default).toBe(false)
  })

  it('seeds the app once under a .local. name, and the skill as shipped', () => {
    expect(Object.keys(bookingSeed.once).sort()).toEqual([
      'Booking.local.app/app.js',
      'Booking.local.app/app.yaml',
      'Booking.local.app/index.html',
      'Booking.local.app/style.css',
    ])
    expect(Object.keys(bookingSeed.shipped)).toEqual(['.claude/skills/room-booking/SKILL.md'])
  })

  it('declares the booking affordance it needs to reach holi.booking', () => {
    const manifest = bookingSeed.once['Booking.local.app/app.yaml'] as string
    expect(manifest).toMatch(/^dangerously-allow:\n {2}booking: /m)
  })

  it('asks before the agent books or cancels', () => {
    expect(bookingSeed.fragments?.['.claude/settings.json']).toEqual([
      { permissions: { ask: ['Bash(holi booking book:*)', 'Bash(holi booking cancel:*)'] } },
    ])
  })
})
