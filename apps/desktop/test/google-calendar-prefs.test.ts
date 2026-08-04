/**
 * Which calendars are switched on, on disk.
 *
 * Small, but it is the file that makes the toggle mean something to the *agent*
 * as well as the panel — both read it, so "I turned Jane's calendar off" is one
 * fact rather than a UI preference the agent knows nothing about.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCalendarPrefs } from '../src/main/google/calendar-prefs'

let dir: string
const pathFor = () => join(dir, 'google-calendars.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-calprefs-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createCalendarPrefs', () => {
  it('is empty before anything has been chosen, so the defaults apply', async () => {
    expect(await createCalendarPrefs(pathFor()).read()).toEqual({})
  })

  it('remembers a choice across instances', async () => {
    await createCalendarPrefs(pathFor()).set('jane@syv.ai', true)

    expect(await createCalendarPrefs(pathFor()).read()).toEqual({ 'jane@syv.ai': true })
  })

  it('records switching something OFF as explicitly as switching it on', async () => {
    // Not the same as absent: absent means "follow the default", and for a
    // calendar the user owns the default is ON. Storing only the enabled ones
    // would make "turn my holidays calendar off" un-expressible.
    const prefs = createCalendarPrefs(pathFor())
    await prefs.set('holidays', false)

    expect(await prefs.read()).toEqual({ holidays: false })
  })

  it('merges rather than replacing', async () => {
    const prefs = createCalendarPrefs(pathFor())
    await prefs.set('a', true)
    await prefs.set('b', false)

    expect(await prefs.read()).toEqual({ a: true, b: false })
  })

  it('treats an unreadable file as no choices, never as a crash', async () => {
    await writeFile(pathFor(), '{ this is not json', 'utf8')

    // A corrupt preferences file must cost the user their toggles, not their
    // agenda — the same stance `google-token-store` takes on a bad envelope.
    expect(await createCalendarPrefs(pathFor()).read()).toEqual({})
  })

  it('ignores entries that are not booleans', async () => {
    await writeFile(pathFor(), JSON.stringify({ good: true, bad: 'yes', worse: null }), 'utf8')

    expect(await createCalendarPrefs(pathFor()).read()).toEqual({ good: true })
  })

  it('writes a file a human can read and edit', async () => {
    // Holi's users are developers ([[holi-users-are-developers]]) and this is
    // ordinary config, not a credential — there is nothing here worth
    // encrypting, and a readable file is one they can fix by hand.
    await createCalendarPrefs(pathFor()).set('jane@syv.ai', false)

    expect(JSON.parse(await readFile(pathFor(), 'utf8'))).toEqual({ 'jane@syv.ai': false })
  })
})
