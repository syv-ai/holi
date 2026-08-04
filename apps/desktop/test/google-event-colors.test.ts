/**
 * Google's own event palette.
 *
 * A per-event `colorId` is an index into a palette Google owns, not a colour —
 * `"5"` means nothing without the lookup. The tests here pin that the lookup
 * happens, and that losing it costs the colour rather than the agenda.
 */
import { describe, expect, it, vi } from 'vitest'
import { GoogleApi } from '../src/main/google/api'
import { fetchEventColors } from '../src/main/google/event-colors'

/**
 * A fake Google that answers by URL. Deliberately a copy of the one in
 * `google-calendar.test.ts` rather than a shared helper — it is twenty lines,
 * and the two files version independently.
 */
function googleApi(routes: Record<string, unknown | unknown[]>) {
  const seen: string[] = []
  const pageCounts: Record<string, number> = {}

  const fetchImpl = vi.fn(async (url: string) => {
    seen.push(url)
    const key = Object.keys(routes).find((k) => url.startsWith(k))
    if (key === undefined) {
      return { ok: false, status: 404, text: async () => '{}', json: async () => ({}) }
    }
    const route = routes[key]!
    const body = Array.isArray(route) ? route[pageCounts[key] ?? 0] : route
    pageCounts[key] = (pageCounts[key] ?? 0) + 1
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }) as unknown as typeof globalThis.fetch

  return {
    api: new GoogleApi({ accessToken: async () => 'at-1', fetch: fetchImpl }),
    seen,
    fetchImpl,
  }
}

const COLORS = 'https://www.googleapis.com/calendar/v3/colors'

describe('fetchEventColors', () => {
  it('maps a colorId to the hex Google actually uses', async () => {
    const { api } = googleApi({
      [COLORS]: {
        // Google returns both maps; only `event` indexes a per-event colorId.
        calendar: { '1': { background: '#ac725e', foreground: '#1d1d1d' } },
        event: {
          '5': { background: '#fbd75b', foreground: '#1d1d1d' },
          '11': { background: '#dc2127', foreground: '#1d1d1d' },
        },
      },
    })

    const palette = await fetchEventColors(api)

    expect(palette['5']).toBe('#fbd75b')
    expect(palette['11']).toBe('#dc2127')
  })

  it('returns an empty map rather than throwing when the palette is unavailable', async () => {
    // No route matches, so the fake refuses. A palette is decoration: losing it
    // must cost the colour, never the agenda it was going to colour.
    const { api } = googleApi({})

    await expect(fetchEventColors(api)).resolves.toEqual({})
  })
})
