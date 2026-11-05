# Mødelokale Booking

Mødelokale Booking (the `booking` plugin) books the office's meeting rooms (the Garage rooms at
`booking.birdsatfive.dk`) from inside Holi: a seeded app shows the rooms as a plan, free or busy
for the slot you pick, and the agent books with `holi booking`. It is a plugin, off by default, because it serves one office.

## How it works

- **The site is a Next.js app on a self-hosted Supabase**, whose auth (`/auth/v1`) and data API
  (`/rest/v1`, PostgREST) share its origin. Holi signs in through `/auth/v1` and lists rooms
  through `/rest/v1`, with the site's public `anon` key, which its login page ships to every
  browser. The data API's row-level security shows a person only their own company's bookings,
  so the schedule and booking go through the site's own routes instead.
- **Schedules and bookings use the site's own routes**, the ones its pages call:
  `GET /api/rooms/{id}/schedule?date=` answers a day of half-hour slots, free or busy, for every
  company and the room's Outlook calendar; `POST /api/bookings` creates a booking and, on the
  server, its event in the room's Microsoft calendar. Those routes read the Supabase SSR session
  cookie (`sb-booking-auth-token`, `base64-` and the session JSON, split into numbered chunks above
  3180 characters), so Holi sends its session as that cookie; a redirect means signed out.
- **The site speaks its own wall clock.** Slots and bookings are local times with no offset in
  the site's zone (`Europe/Oslo`, the same clock as Copenhagen). `main/schedule.ts` converts both
  ways through `@date-fns/tz`, which knows daylight saving, and folds a run of busy slots that
  share a booking into one interval.
- **Sign-in is the site's emailed login link, asked for by Holi with PKCE.** `booking.login`
  sends `/auth/v1/otp` a challenge whose verifier stays in main's memory, with `create_user:
false` (Holi never signs anyone up), and the callback the site's own page uses. The link the
  email carries is useless without that verifier, so a forwarded or intercepted link signs no one
  in. Holi follows it one hop (to the `?code=` the callback would get) and exchanges the code for
  a session. A template that sends a one-time code instead works too (`/auth/v1/verify`).
- **Gmail delivers the link when Google is connected.** `booking.login` watches Gmail for about
  90 seconds all told, Gmail's own time included (inside the two minutes the agent's command
  gets), through Google's own `google.search` and `google.thread` at the UI door (`ctx.call`), so
  the booking plugin never imports Google's. It takes only a link to the site's
  `/auth/v1/verify` or `/callback`, only from mail newer than the request. Without Google (no
  account, or the plugin off, or Gmail refusing) or when the mail is slow, it answers
  `signedIn: false` with the email sent and why, and `booking.finish` takes the link the person
  pastes. A link the site refuses (an older login's email, landing within the minute of clock slack)
  is passed over and the watch goes on. It stops watching once its login is over another way: a
  pasted link, a newer login or a sign-out.
- **The session is per machine**, in `userData/booking-session.enc`, encrypted with
  `safeStorage`; never in a vault. Writes and clears of the file land one at a time, in order.
  Access tokens refresh five minutes before they expire, before the site's own client would (that
  would rotate the refresh token where Holi cannot see it), and single-flight because refresh
  tokens rotate. A refused refresh signs out, unless the file already holds a newer session; a
  network failure does not; a refresh that lands after a sign-out or a new sign-in writes nothing.
- **Settings shows the sign-in.** The plugin's Mødelokale Booking section of the settings tab says who
  this machine is signed in as, signs out, and signs in through the same `booking.login`, with the
  connected Google address offered as the email (read through a typed slice of `google.status`)
  and a field for the pasted link when Gmail does not deliver it. It only shows main's answer;
  it never sees a token.
- **The person's own bookings keep their exact times.** The schedule knows only half hours, so a
  13:30–14:15 booking fills the 14:00 slot and would read as ending at 14:30. `availability` and
  `book`'s clash check take the person's bookings' own start and end from the list the site's
  bookings page reads (`/api/bookings`), matched by id; other companies' bookings carry no id
  and keep the schedule's half hours, and so do the person's when that list does not answer.
- **One set of capabilities, three doors** (`booking.*`, [architecture](../architecture.md)):
  `status`, `login`, `finish`, `logout`, `rooms`, `availability` (every room's busy times on
  one of the site's days, today by default, with the id of each booking that is the person's),
  `book` and `cancel`. The agent reaches them as
  `holi booking <verb>`, the app as `holi.booking.*`. A room is named by id, mailbox, name or
  number (`"Garage 2"`, `2`); `book` takes ISO instants with an offset, never a bare local time,
  since main's zone is not the person's.
- **`book`** refuses past times, more than 12 hours, a span over two of the site's days and a slot
  the schedule shows busy (`CONFLICT`, as is the site refusing an overlap), then posts the booking
  in the site's local time. The site keeps the last word. A lost sign-in is `UNAUTHORIZED`, whose
  next step tells the agent to run `holi booking login`.
- **`cancel`** takes a booking id and deletes it through the site's own route, as its bookings
  page does; the site checks the booking is the caller's and takes it off the room's Outlook
  calendar.
- **The app** is `Booking.local.app`, seeded once and kept on this machine. It places rooms by the
  number in their mailbox: the three meeting rooms on top, the two small MuteBoxes and the MuteBox
  Meet below, sized by how many fit; a room the site adds later lands under "Other rooms". Each
  room shows its day, 08 to 18, as the site's half-hour blocks (free, taken, yours, faded once
  past), with the blocks the chosen slot covers at full strength and a bar under its exact span,
  and says how long it stays free or when it is next free. A slot is a start and an end, each in
  quarter hours, picked in a panel of hours and quarter hours; a new start keeps the length, an
  hour by default. A booking is one button, titled "Meeting" for the site, which wants a title.
  The chosen room's list of the day gives each of the person's own bookings a Cancel button that
  asks once more before it cancels. It looks again, sign-in
  included, every minute and when Holi comes back to the front; a plan left open on today moves
  to the new day at midnight.
- **The agent** gets the shipped `room-booking` skill, and `ask` rules on `holi booking book`
  and `holi booking cancel` merged into `.claude/settings.json`, so a booking is never made or
  cancelled unseen.

## Rules

- At the app door every `booking.*` entry needs the `booking` affordance
  (`dangerously-allow: [booking]`), approved as mail and calendar are: the session is one
  person's, and `book` and `cancel` act in their name. The seeded `Booking.local.app` is personal, so it needs
  the flag and no approval ([vault apps](vault-apps.md)); a shared app that asks is approved by
  each person.
- Mail is untrusted input: only an `https:` link to the site's own host is ever followed, and only
  one hop. Only a PKCE code is taken from it, never tokens a link carries, so no link can sign the
  person in as whoever made it.
- Never store the session in a vault or an app's records.

## Rejected

- An MCP server: a lifecycle and handshake to deliver JSON a command already returns.
- Driving the site's web pages: its server actions change with every deploy; its routes do not.
- Inserting bookings through the data API: the row would skip the site's server step that puts
  it in the room's Outlook calendar, and the data API shows only one's own company's bookings.
- Signing in with Microsoft: the site offers it, but it needs a browser session Holi cannot hold
  for the agent, and the person's Google mail is already here.

## Not verified

- **The answers to a booking and a cancel.** Both have been made from Holi against the live site,
  through the requests its own pages send (`POST /api/bookings`, `DELETE /api/bookings/{id}`).
  Neither answer's body is read: success is any 2xx, so a site that answered 2xx without acting
  would go unnoticed until the next look at the schedule.

## Code

- `apps/desktop/src/plugins/booking/`: `info.ts`; `main/` with `site.ts` (the origin and public
  key), `api.ts` (the HTTP client, no state), `schedule.ts` (the site's clock and slots), `auth.ts` (PKCE login, refresh), `session-store.ts`,
  `login-mail.ts` (finding the link in Gmail), `capabilities.ts`, `electron.ts` (the keychain,
  loaded at activation) and `seed.ts` with `vault/once/Booking.local.app/` and
  `vault/shipped/.claude/skills/room-booking/`; `renderer/booking-section.tsx`, the settings
  section.
