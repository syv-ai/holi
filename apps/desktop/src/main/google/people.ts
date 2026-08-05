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
 * **The two collections are not the same API wearing two URLs**, and assuming
 * they were is how `otherContacts` shipped returning nothing at all:
 *
 * - `connections.list` takes `personFields`; `otherContacts.list` takes
 *   **`readMask`**, and rejects the request outright without it.
 * - `connections.list` is covered by `contacts.readonly`; `otherContacts.list`
 *   needs its own **`contacts.other.readonly`** (see `GOOGLE_SCOPES`).
 *
 * Both failures are 4xx, both are swallowed by the `[]` policy below, and the
 * result was an address book that looked like it worked. A test whose fake
 * answered on URL alone could not have caught either — see `google-people`.
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
 * How many contacts to page, and how many pages.
 *
 * 1000 is the maximum both collections accept. **Two pages, not ten:** this is
 * a completion corpus, not a sync, and `getAll`'s default cap of ten would let
 * one dropdown cost twenty requests against a rate-limited API. Two pages per
 * collection is 2000 people each — past the point where the list stops being
 * the reason completion misses someone.
 */
const PAGE_SIZE = '1000'
const PAGE_CAP = 2

interface RawPerson {
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
}

export async function listContacts(api: GoogleApi): Promise<MailAddress[]> {
  // `Promise.all` is safe here only because `page` resolves to `[]` rather than
  // rejecting — one collection failing genuinely does not cost the other. The
  // containment is in `page`, not in this call; do not move it.
  const [connections, others] = await Promise.all([
    page(api, `${BASE}/people/me/connections`, 'connections', 'personFields'),
    // `readMask`, NOT `personFields` — see the module note.
    page(api, `${BASE}/otherContacts`, 'otherContacts', 'readMask'),
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

/**
 * One collection, paged, or `[]` if Google will not answer for it.
 *
 * `fieldsParam` is the whole reason this takes an argument for something that
 * looks like a constant: the two collections spell the same idea differently,
 * and sending the wrong one is a 400 that this function then hides.
 */
async function page(
  api: GoogleApi,
  url: string,
  key: string,
  fieldsParam: 'personFields' | 'readMask',
): Promise<RawPerson[]> {
  try {
    return await api.getAll<RawPerson>(
      url,
      { [fieldsParam]: FIELDS, pageSize: PAGE_SIZE },
      (raw) => (raw as unknown as Record<string, RawPerson[] | undefined>)[key] ?? [],
      PAGE_CAP,
    )
  } catch {
    return []
  }
}
