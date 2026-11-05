---
name: room-booking
description: See, book and cancel the office meeting rooms (Garage 1–3, the MuteBoxes and the MuteBox Meet) at booking.birdsatfive.dk. Use whenever the user asks for a room, whether a room is free, what is booked, or to cancel a booking.
---

# Mødelokale Booking

Holi is signed in to the office's booking site on the user's behalf. One
command, `holi booking`, reads, books and cancels the rooms. Everything prints text;
add `--json` for JSON.

```sh
holi booking status                      # signed in? as whom
holi booking rooms                       # name, mailbox, id
holi booking availability [YYYY-MM-DD]   # every room's busy times that day (today)
holi booking book <room> <start> <end> "<title>" ["<description>"]
holi booking cancel <booking id>         # one of the user's own bookings
```

- `<room>` is a name (`"Garage 2"`), a number (`2`), a mailbox or an id.
- `book` takes ISO instants **with an offset**: `2026-11-05T10:00:00+01:00`.
  Use the offset in force on the booking's day, not today's: `date +%z` is
  today's, and Copenhagen is `+01:00` in winter but `+02:00` from the last
  Sunday of March to the last Sunday of October. Never send a bare local time.
- `availability` prints times on the office's clock (Copenhagen/Oslo time),
  and shows every booking, other companies' and Outlook's included.
- Check `holi booking availability <day>` before you book, and say what you
  are about to book. `book` refuses a slot the schedule shows taken, and a
  booking must start and end on the same day.
- `availability` marks the user's own bookings `(yours, id …)`; that id is
  what `cancel` takes. Say which booking you are about to cancel first.
- Holi asks the user before every `book` and `cancel`. That prompt is expected.

## The rooms

| Room                    | What it is                         |
| ----------------------- | ---------------------------------- |
| Garage 1, 2, 3          | Large meeting rooms                |
| Garage 4, 5 (MuteBox)   | Small one-person booths, for calls |
| Garage 6 (MuteBox Meet) | A larger booth for a small meeting |

## Signing in

If a command says the user is not signed in, run
`holi booking login <their email>`. It emails a login link and, when Google
is connected, picks it up from Gmail by itself (it can take a minute). If it
answers that the email has not arrived, ask the user to paste the link from
the email, then run `holi booking finish "<link>"`.

The user can also book visually: `holi apps open Booking.local.app`.
