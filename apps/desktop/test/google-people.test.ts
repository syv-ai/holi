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

/**
 * A People API that **checks what it was asked**, not only which URL was hit.
 *
 * This is the difference between a fake and a recording, and it is the reason
 * `otherContacts` shipped returning nothing at all. The two collections do not
 * take the same parameter — `connections.list` wants `personFields` and
 * `otherContacts.list` wants `readMask` — and a fake that answers on the URL
 * alone happily returns contacts for a request Google would have rejected with
 * a 400. The suite was green and the address book was empty.
 *
 * So this one refuses the way Google does. It cannot prove the scope half of
 * the same bug (`contacts.other.readonly`) — nothing here talks to Google, and
 * no fake can — but it can stop the parameter half coming back.
 */
function people(
  connections: RawPerson[],
  otherContacts: RawPerson[] = [],
  { fail = false } = {},
) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const refuse = (status: number, reason: string) => ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { errors: [{ reason }] } }),
    })
    if (fail) return refuse(403, 'insufficientPermissions')

    const params = new URL(url).searchParams
    const other = url.includes('otherContacts')
    // Required, and named differently on each collection. Google answers 400
    // when the required one is missing; it does not quietly ignore it.
    if (other && params.get('readMask') === null) return refuse(400, 'badRequest')
    if (!other && params.get('personFields') === null) return refuse(400, 'badRequest')

    const body = other ? { otherContacts } : { connections }
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

  it('asks otherContacts with readMask, which is what that collection takes', async () => {
    // The parameter names differ between the two collections, and sending
    // `personFields` to `otherContacts` is a 400 — swallowed by the `[]`
    // policy, so the only symptom is an address book missing everyone the user
    // has actually corresponded with.
    const { api, seen } = people([], [person('Lars', 'lars@syv.ai')])

    const contacts = await listContacts(api)

    const other = new URL(seen.find((u) => u.includes('/otherContacts'))!)
    expect(other.searchParams.get('readMask')).toBe('names,emailAddresses')
    expect(other.searchParams.get('personFields')).toBeNull()
    // And the consequence, stated as the outcome rather than the parameter:
    // the collection that matters actually answers.
    expect(contacts).toEqual([{ name: 'Lars', email: 'lars@syv.ai' }])
  })

  it('pages a bounded number of times — a dropdown is not a sync', async () => {
    // `getAll`'s default cap is ten, which would be twenty requests across the
    // two collections every time the address book is built.
    const { api, seen } = people([person('Jane', 'jane@syv.ai')])

    await listContacts(api)

    expect(seen).toHaveLength(2)
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
