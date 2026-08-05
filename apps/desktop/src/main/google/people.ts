/**
 * The address book — what `@`-completion completes from (D68).
 *
 * **Two collections, and reading only the first is the mistake to avoid.**
 * `people/me/connections` is the contacts a user has explicitly *saved*, which
 * for a Workspace account is frequently almost nobody. `otherContacts` is the
 * set Google auto-collects from correspondence — everyone actually written to.
 * An address book built from `connections` alone works perfectly and is empty
 * for the person it was built for.
 *
 * **Never throws.** A refusal, a cold API, a timeout — all answer `[]`, because
 * completion has a second source (senders across loaded threads, in `MailView`)
 * and degrading to it is correct. A dropdown that breaks because a contacts
 * request failed would be worse than one that is merely less complete.
 *
 * Returns `MailAddress`, the shape `gmail.ts` already defines. A second address
 * type would be one more place for `{ name, email }` to drift.
 */
import type { GoogleApi } from './api'
import type { MailAddress } from './gmail'

const BASE = 'https://people.googleapis.com/v1'

/** The only two fields a completion row shows. Asking for everything would page
 *  a great deal of data to render two strings. */
const FIELDS = 'names,emailAddresses'

/**
 * How many contacts to page.
 *
 * Google's maximum page size differs between the two collections (1000 for
 * connections, 1000 for otherContacts), and `getAll`'s own cap bounds the loop.
 * This is a completion source, not a sync: the first few pages are the people
 * anyone actually types.
 */
const PAGE_SIZE = '1000'

interface RawPerson {
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
}

export async function listContacts(api: GoogleApi): Promise<MailAddress[]> {
  // Settled, not `all`: one collection failing must not cost the other. In
  // practice `otherContacts` is the newer surface and the likelier to refuse.
  const [connections, others] = await Promise.all([
    page(api, `${BASE}/people/me/connections`, 'connections'),
    page(api, `${BASE}/otherContacts`, 'otherContacts'),
  ])

  const byEmail = new Map<string, MailAddress>()
  for (const raw of [...connections, ...others]) {
    const email = raw.emailAddresses?.[0]?.value?.trim().toLowerCase()
    // No address means nothing to complete to. A name alone cannot go in a
    // `from:` query.
    if (email === undefined || email === '') continue
    // First writer wins, and the order above is why: a saved contact's name
    // beats the one Google guessed from a header.
    if (byEmail.has(email)) continue
    // The same fallback `parseAddress` uses in gmail.ts — a row always has
    // something to print.
    byEmail.set(email, { name: raw.names?.[0]?.displayName?.trim() || email, email })
  }
  return [...byEmail.values()]
}

/** One collection, paged, or `[]` if Google will not answer for it. */
async function page(api: GoogleApi, url: string, key: string): Promise<RawPerson[]> {
  try {
    return await api.getAll<RawPerson>(
      url,
      { personFields: FIELDS, pageSize: PAGE_SIZE },
      (raw) => (raw as unknown as Record<string, RawPerson[] | undefined>)[key] ?? [],
    )
  } catch {
    return []
  }
}
