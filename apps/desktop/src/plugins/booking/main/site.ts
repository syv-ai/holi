/**
 * The booking site Holi talks to: a Next.js app on a self-hosted Supabase,
 * whose auth (`/auth/v1`) and data API (`/rest/v1`) sit on the same origin.
 *
 * `anonKey` is the site's **public** Supabase key, the one its own login page
 * ships to every browser. It is not a secret: it names the project and the
 * `anon` role, and the database's row-level security decides what a signed-in
 * person may do. A person's session is the credential, and it is kept
 * encrypted on this machine (`session-store.ts`), never here.
 */
export interface BookingSite {
  /** The origin, with no trailing slash. */
  base: string
  anonKey: string
  /** Where the emailed login link lands. The site allows this redirect; it is
   *  what its own login page asks for, so the link has the same shape. */
  callback: string
  /** The wall clock the site's schedule and bookings are in. */
  timeZone: string
}

const BASE = 'https://booking.birdsatfive.dk'

export const BIRDS_AT_FIVE: BookingSite = {
  base: BASE,
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkzMTI1MjY0LCJleHAiOjIxMDg0ODUyNjR9.MrYSz4pyuWCxp2p9tIYmtsdSzPa8BpfibZxuuK9YUCs',
  callback: `${BASE}/callback`,
  timeZone: 'Europe/Oslo',
}
