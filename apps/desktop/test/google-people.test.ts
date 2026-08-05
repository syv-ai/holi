/**
 * The address book behind `@`-completion (D68).
 *
 * Two sources, and **`otherContacts` is the one people forget.**
 * `connections` is the contacts a user has explicitly saved, which in a
 * Workspace account is often almost nobody; `otherContacts` is everyone they
 * have actually corresponded with, auto-collected by Google. Reading only the
 * first gives a technically-working address book that is empty for the person
 * it was built for.
 *
 * A failure returns `[]` rather than throwing. Completion degrading to the
 * local sender corpus is correct behaviour; a dropdown that breaks because a
 * contacts request timed out is not.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { listContacts } from '../src/main/google/people'

interface RawPerson {
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
}

/** A People API answering both collections, recording what it was asked. */
function people(
  connections: RawPerson[],
  otherContacts: RawPerson[] = [],
  { fail = false } = {},
) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    if (fail) {
      return {
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }),
      }
    }
    const body = url.includes('otherContacts')
      ? { otherContacts }
      : { connections }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  })
  const api = new GoogleApi({
    accessToken: async () => 'at-1',
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  })
  return { api, seen }
}

const person = (name: string, email: string): RawPerson => ({
  names: [{ displayName: name }],
  emailAddresses: [{ value: email }],
})

describe('listContacts', () => {
  it('reads saved contacts AND the auto-collected ones', async () => {
    const { api, seen } = people([person('Jane Doe', 'jane@syv.ai')], [person('Lars', 'lars@syv.ai')])

    const contacts = await listContacts(api)

    expect(contacts).toEqual([
      { name: 'Jane Doe', email: 'jane@syv.ai' },
      { name: 'Lars', email: 'lars@syv.ai' },
    ])
    // Both collections, or the address book is empty for anyone who does not
    // manually save contacts — which is most people.
    expect(seen.some((u) => u.includes('/people/me/connections'))).toBe(true)
    expect(seen.some((u) => u.includes('/otherContacts'))).toBe(true)
  })

  it('asks for names and addresses, which are the only fields it uses', async () => {
    const { api, seen } = people([])

    await listContacts(api)

    const connections = seen.find((u) => u.includes('/connections'))!
    // Requesting every field would page far more data for a dropdown that shows
    // two strings.
    expect(new URL(connections).searchParams.get('personFields')).toBe('names,emailAddresses')
  })

  it('drops a contact with no address — there is nothing to complete to', async () => {
    const { api } = people([{ names: [{ displayName: 'No Email' }] }, person('Jane', 'jane@syv.ai')])

    expect(await listContacts(api)).toEqual([{ name: 'Jane', email: 'jane@syv.ai' }])
  })

  it('falls back to the address when a contact has no name', async () => {
    const { api } = people([{ emailAddresses: [{ value: 'anon@syv.ai' }] }])

    // The same rule `parseAddress` follows in gmail.ts: a row always has
    // something to print.
    expect(await listContacts(api)).toEqual([{ name: 'anon@syv.ai', email: 'anon@syv.ai' }])
  })

  it('collapses duplicates on the lowercased address', async () => {
    // The same person in both collections, and Google is not consistent about
    // case in an address.
    const { api } = people([person('Jane Doe', 'Jane@Syv.ai')], [person('jane', 'jane@syv.ai')])

    const contacts = await listContacts(api)

    expect(contacts).toHaveLength(1)
    // First writer wins, so a saved contact's name beats an auto-collected one.
    expect(contacts[0]).toEqual({ name: 'Jane Doe', email: 'jane@syv.ai' })
  })

  it('answers with nothing when Google refuses, rather than throwing', async () => {
    const { api } = people([], [], { fail: true })

    // A cold or unpermitted contacts API must leave completion working off the
    // local corpus, not break the dropdown.
    await expect(listContacts(api)).resolves.toEqual([])
  })
})
