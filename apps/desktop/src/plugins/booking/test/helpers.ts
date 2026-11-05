/** Fakes shared by the booking tests: a site, a recorded `fetch`, rooms. */
import type { Room } from '../main/api'
import type { BookingSite } from '../main/site'

export const SITE: BookingSite = {
  base: 'https://booking.example.test',
  anonKey: 'anon-key',
  callback: 'https://booking.example.test/callback',
  timeZone: 'Europe/Oslo',
}

export interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A `fetch` that records each request and answers from `respond`. */
export function fakeFetch(respond: (req: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch
  seen: Seen[]
} {
  const seen: Seen[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    seen.push(req)
    return respond(req)
  }
  return { fetch: fn as typeof fetch, seen }
}

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

export const ROOMS: Room[] = [
  'Garage1',
  'Garage2',
  'Garage3',
  'Garage 4 – (MuteBox)',
  'Garage 5 (MuteBox)',
  'Garage 6 – (MuteBox Meet)',
].map((name, i) => ({
  id: `room-${i + 1}`,
  name,
  email: `Garage${i + 1}@example.test`,
  capacity: null,
}))
