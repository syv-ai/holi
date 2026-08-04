/**
 * Gmail label names.
 *
 * A message carries `Label_12`, which is not a thing to show anyone. The tests
 * here pin the lookup, that Gmail's own labels are excluded from it, and that
 * losing the lookup costs the chips rather than the inbox.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { fetchLabelNames } from '../src/main/google/labels'

/** A fake Gmail that answers by URL. */
function gmail(routes: Record<string, unknown>) {
  const seen: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (key === undefined) {
      return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) }
    }
    const body = routes[key]
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof globalThis.fetch

  return { api: new GoogleApi({ accessToken: async () => 'at', fetch: fetchImpl }), seen }
}

const LABELS = 'https://gmail.googleapis.com/gmail/v1/users/me/labels'

describe('fetchLabelNames', () => {
  it('maps a label id to its name', async () => {
    const { api } = gmail({
      [LABELS]: {
        labels: [
          { id: 'Label_12', name: 'Work/Clients', type: 'user' },
          { id: 'Label_13', name: 'Receipts', type: 'user' },
        ],
      },
    })

    const names = await fetchLabelNames(api)

    expect(names.get('Label_12')).toBe('Work/Clients')
    expect(names.get('Label_13')).toBe('Receipts')
  })

  it('omits system labels, which are not the user’s', async () => {
    const { api } = gmail({
      [LABELS]: {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
          { id: 'Label_12', name: 'Work/Clients', type: 'user' },
        ],
      },
    })

    // Gmail's own labels are not filing the user did, and rendering them as
    // chips would put "INBOX" on every row in the inbox.
    expect([...(await fetchLabelNames(api)).keys()]).toEqual(['Label_12'])
  })

  it('returns an empty map rather than throwing', async () => {
    // Labels are decoration. Losing them must not lose the inbox they decorate.
    const { api } = gmail({})

    expect((await fetchLabelNames(api)).size).toBe(0)
  })
})
