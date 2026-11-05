// Booking: the Garage rooms as a plan, free or busy for the slot you pick,
// and a booking in two clicks. Everything goes through holi.booking, which
// holds the sign-in in Holi (never in this app) and talks to the site.
const $ = (id) => document.getElementById(id)
// Holi says its mode in the page's address; the native date picker follows
// it rather than the system's.
const MODE = new URLSearchParams(location.search).get('mode') === 'dark' ? 'dark' : 'light'
document.documentElement.style.colorScheme = MODE
document.documentElement.dataset.mode = MODE
const prefs = holi.store('prefs')

// Where each room sits, by the number in its mailbox (Garage4@…): the three
// meeting rooms on top, the two small MuteBoxes and the MuteBox Meet below.
// A room the site adds later lands under "Other rooms".
const LAYOUT = {
  1: { zone: 'large', kind: 'Meeting room' },
  2: { zone: 'large', kind: 'Meeting room' },
  3: { zone: 'large', kind: 'Meeting room' },
  4: { zone: 'booths', kind: 'MuteBox' },
  5: { zone: 'booths', kind: 'MuteBox' },
  6: { zone: 'booths', kind: 'MuteBox Meet' },
}
const ZONES = [
  { id: 'large', label: 'Meeting rooms' },
  { id: 'booths', label: 'MuteBoxes' },
  { id: 'other', label: 'Other rooms' },
]
// The site's bookable day, 08:00 to 18:00: the timeline's span and the
// start times offered. Days and times here are on this machine's clock,
// which is the office's (Copenhagen and Oslo keep the same time) for anyone
// in it; main checks the site's own day before it books.
const DAY_START = 8
const DAY_END = 18

const state = {
  signedIn: false,
  email: null,
  rooms: [],
  bookings: [], // the day in bookingsDay
  bookingsDay: null,
  day: today(),
  start: nextHalfHour(), // minutes after midnight, in quarter hours
  length: 60, // the length the person chose: an hour unless they pick another end
  minutes: 60, // that length, cut short where the day ends first
  selected: null, // a room id
  confirming: null, // the id of a booking whose Cancel was pressed once
  cancelling: null, // the id of the booking being cancelled
}

// ── time ────────────────────────────────────────────────────────────────────
function today() {
  const d = new Date()
  return ymd(d)
}
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function pad(n) {
  return String(n).padStart(2, '0')
}
function nextHalfHour() {
  const d = new Date()
  const m = d.getHours() * 60 + d.getMinutes()
  const next = Math.ceil((m + 1) / 30) * 30
  return Math.min(Math.max(next, DAY_START * 60), (DAY_END - 1) * 60)
}
/** A local day plus minutes after midnight, as a Date. */
function at(day, minutes) {
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60)
}
function hm(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function slot() {
  const start = at(state.day, state.start)
  return { start, end: new Date(start.getTime() + state.minutes * 60_000) }
}
function overlaps(b, from, to) {
  return new Date(b.start) < to && new Date(b.end) > from
}
function prettyDay(day) {
  return at(day, 0).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

// ── status line ─────────────────────────────────────────────────────────────
function say(text) {
  $('status').textContent = text || ''
}
function fail(e) {
  say(String(e && e.message ? e.message : e))
  holi.log(String(e && e.stack ? e.stack : e))
}

// The day this app last took for today. A plan left open on today moves to
// the new day at midnight, with the next start time, rather than offering
// slots that have passed.
let seenToday = state.day
function followToday() {
  const now = today()
  if (now === seenToday) return
  if (state.day === seenToday) {
    state.day = now
    state.start = nextHalfHour()
    $('day').value = now
    syncTimes()
  }
  seenToday = now
}

// ── loading ─────────────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await holi.booking.status()
  state.signedIn = s.signedIn
  state.email = s.email
  renderAccount()
}

async function loadRooms() {
  state.rooms = await holi.booking.rooms()
}

/** The site's own schedule for `day`: every company's bookings and the
 *  rooms' Outlook events, not only the ones this account may list. */
async function fetchBookings(day) {
  if (!state.signedIn) return []
  const answer = await holi.booking.availability(day)
  return answer.rooms.flatMap((room) =>
    room.busy.map((b) => ({
      id: b.bookingId,
      roomId: room.id,
      start: b.start,
      end: b.end,
      title: b.title || 'Busy',
      mine: b.mine,
      organizer: b.organizer,
    })),
  )
}

// Each look is numbered, so a slow answer for a day already left behind
// never paints over a newer one.
let looks = 0

/** Look again: the sign-in (it may have changed in Holi's settings), the
 *  rooms if they have not loaded yet, and the chosen day's bookings. */
async function refresh() {
  followToday()
  const look = ++looks
  const day = state.day
  try {
    await loadStatus()
    if (state.rooms.length === 0) await loadRooms()
    const bookings = await fetchBookings(day)
    if (look !== looks) return
    state.bookings = bookings
    state.bookingsDay = day
    say('')
  } catch (e) {
    if (look !== looks) return
    // A dead session: show the sign-in again rather than a broken plan.
    if (e && e.code === 'UNAUTHORIZED') {
      state.signedIn = false
      renderAccount()
    }
    fail(e)
  }
  render()
}

// ── account ─────────────────────────────────────────────────────────────────
// Who the corner shows. It is drawn again only when that changes, so the look
// every minute never takes the focus off Sign out.
let shownAccount

function renderAccount() {
  $('signin').hidden = state.signedIn
  const account = state.signedIn ? state.email || '' : null
  if (account === shownAccount) return
  shownAccount = account
  const el = $('account')
  el.replaceChildren()
  if (!state.signedIn) return
  const who = document.createElement('span')
  who.className = 'muted'
  who.textContent = state.email || 'Signed in'
  const out = document.createElement('button')
  out.className = 'link'
  out.textContent = 'Sign out'
  out.onclick = async () => {
    try {
      await holi.booking.logout()
      await refresh()
    } catch (e) {
      fail(e)
    }
  }
  el.append(who, out)
}

async function sendLink() {
  // Enter in the field reaches here while a login is already being watched.
  if ($('sendLink').disabled) return
  const email = $('email').value.trim()
  if (!email) return $('email').focus()
  $('sendLink').disabled = true
  $('signinStatus').textContent = 'Sending the login email, then watching Gmail for it…'
  try {
    await prefs.put('main', { email })
    const r = await holi.booking.login(email)
    if (r.signedIn) {
      $('signinStatus').textContent = ''
      $('pasteRow').hidden = true
      await refresh()
    } else {
      $('signinStatus').textContent = r.message || 'Check your email for the login link.'
      $('pasteRow').hidden = false
      $('link').focus()
    }
  } catch (e) {
    $('signinStatus').textContent = String(e.message || e)
  } finally {
    $('sendLink').disabled = false
  }
}

async function useLink() {
  if ($('useLink').disabled) return
  const link = $('link').value.trim()
  if (!link) return $('link').focus()
  $('useLink').disabled = true
  try {
    await holi.booking.finish(link)
    $('link').value = ''
    $('pasteRow').hidden = true
    $('signinStatus').textContent = ''
    await refresh()
  } catch (e) {
    $('signinStatus').textContent = String(e.message || e)
  } finally {
    $('useLink').disabled = false
  }
}

// ── the plan ────────────────────────────────────────────────────────────────
/** "Garage 4 – (MuteBox)" and "Garage1" both read as "Garage 4", "Garage 1":
 *  the kind is shown on its own line. */
function shortName(room) {
  return room.name.replace(/\s*[–-]?\s*\(.*\)\s*$/, '').replace(/^garage\s*(\d+)/i, 'Garage $1')
}

function placeOf(room) {
  const m = /garage\s*(\d+)/i.exec(room.email) || /(\d+)/.exec(room.name)
  return (m && LAYOUT[Number(m[1])]) || { zone: 'other', kind: 'Room' }
}

function roomState(room) {
  if (!state.signedIn) return { cls: 'unknown', text: 'Sign in to see bookings' }
  if (state.bookingsDay !== state.day) return { cls: 'unknown', text: 'Loading…' }
  const { start, end } = slot()
  const clash = state.bookings.find((b) => b.roomId === room.id && overlaps(b, start, end))
  if (!clash) {
    const next = state.bookings.find((b) => b.roomId === room.id && Date.parse(b.start) >= end)
    const closes = at(state.day, DAY_END * 60)
    return next && Date.parse(next.start) < closes.getTime()
      ? { cls: 'free', text: `Free until ${hm(new Date(next.start))}` }
      : { cls: 'free', text: 'Free rest of day' }
  }
  if (clash.mine) return { cls: 'mine', text: `Yours: ${clash.title}` }
  return { cls: 'busy', text: `Busy until ${hm(new Date(freeFrom(room.id, clash)))}` }
}

/** When the room is next free after `clash`: bookings back to back, or
 *  overlapping, are one stretch. A room's bookings come in time order. */
function freeFrom(roomId, clash) {
  let until = Date.parse(clash.end)
  for (const b of state.bookings) {
    if (b.roomId !== roomId || Date.parse(b.start) > until) continue
    until = Math.max(until, Date.parse(b.end))
  }
  return until
}

// The room's day as half-hour blocks, the site's own slots: green when free,
// red when taken, the link colour when it is yours, faded once it has
// passed. The blocks the chosen slot covers stand out at full strength, with
// a bar under them in the room's state colour.
const HALF_HOUR = 30 * 60_000

function timeline(room) {
  const from = at(state.day, DAY_START * 60).getTime()
  const to = at(state.day, DAY_END * 60).getTime()
  const pct = (t) => `${(Math.min(Math.max(t, from), to) - from) / (to - from) * 100}%`
  const now = Date.now()
  const shown = state.bookingsDay === state.day ? state.bookings : []
  const roomBookings = shown.filter((b) => b.roomId === room.id)
  const known = state.signedIn && state.bookingsDay === state.day

  const { start, end } = slot()
  const cells = document.createElement('span')
  cells.className = 'cells'
  for (let t = from; t < to; t += HALF_HOUR) {
    const cell = document.createElement('span')
    const taken = roomBookings.find((b) => overlaps(b, new Date(t), new Date(t + HALF_HOUR)))
    const kind = !known ? 'unknown' : taken ? (taken.mine ? 'yours' : 'taken') : 'open'
    const chosen = t < end.getTime() && t + HALF_HOUR > start.getTime()
    cell.className = `cell ${kind}${chosen ? ' chosen' : t + HALF_HOUR <= now ? ' past' : ''}`
    cells.append(cell)
  }

  const track = document.createElement('span')
  track.className = 'track'
  if (end.getTime() > from && start.getTime() < to) {
    const mark = document.createElement('span')
    mark.className = 'slot'
    mark.style.left = pct(start.getTime())
    mark.style.right = `calc(100% - ${pct(end.getTime())})`
    track.append(mark)
  }

  // Every other hour under the bar, each under its own boundary.
  const hours = document.createElement('span')
  hours.className = 'hours'
  hours.setAttribute('aria-hidden', 'true')
  for (let h = DAY_START; h <= DAY_END; h += 2) {
    const label = document.createElement('span')
    label.textContent = pad(h)
    label.style.left = pct(at(state.day, h * 60).getTime())
    if (h === DAY_START) label.className = 'first'
    else if (h + 2 > DAY_END) label.className = 'last'
    hours.append(label)
  }
  const wrap = document.createElement('span')
  wrap.className = 'day-bar'
  wrap.append(cells, track, hours)
  return wrap
}

function roomTile(room) {
  const place = placeOf(room)
  const st = roomState(room)
  const tile = document.createElement('button')
  tile.className = `room ${st.cls}`
  tile.dataset.room = room.id
  tile.setAttribute('aria-pressed', String(state.selected === room.id))
  tile.onclick = () => select(room.id)

  // Spans only: a button holds phrasing content. The tile is a flex column,
  // so each part still lays out as a block.
  const head = document.createElement('span')
  head.className = 'head'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = shortName(room)
  const kind = document.createElement('span')
  kind.className = 'kind'
  kind.textContent = place.kind + (room.capacity ? ` · ${room.capacity} people` : '')
  head.append(name, kind)

  const text = document.createElement('span')
  text.className = 'state'
  text.textContent = st.text
  const top = document.createElement('span')
  top.className = 'top'
  top.append(head, text)

  tile.append(top, timeline(room))
  return tile
}

function render() {
  const plan = $('plan')
  // The tiles are drawn anew; a keyboard user keeps their place on the plan.
  const focused = plan.contains(document.activeElement) ? document.activeElement.dataset.room : null
  plan.replaceChildren()
  for (const zone of ZONES) {
    const rooms = state.rooms.filter((r) => placeOf(r).zone === zone.id)
    if (rooms.length === 0) continue
    const label = document.createElement('h2')
    label.className = 'zone-label'
    label.textContent = zone.label
    const grid = document.createElement('div')
    grid.className = `zone ${zone.id}`
    grid.append(...rooms.map(roomTile))
    plan.append(label, grid)
  }
  if (focused) {
    const tile = [...plan.querySelectorAll('.room')].find((t) => t.dataset.room === focused)
    if (tile) tile.focus()
  }
  renderSheet()
}

// ── the booking sheet ───────────────────────────────────────────────────────
function select(id) {
  state.selected = state.selected === id ? null : id
  state.confirming = null
  selectedAt = Date.now()
  render()
  if (state.selected && !$('book').hidden) $('book').focus()
}

// A held or doubled press reaches past the button it began on: Enter held on
// a room repeats onto Book room, which select() just focused, and the second
// click of a double-click on Cancel lands on "Yes, cancel" where it appeared.
// A press that soon after the one before is not a decision.
const SETTLE_MS = 600
let selectedAt = 0
let askedAt = 0
function renderSheet() {
  const room = state.rooms.find((r) => r.id === state.selected)
  $('sheet').hidden = !room
  if (!room) return
  const { start, end } = slot()
  const st = roomState(room)
  $('sheetRoom').textContent = shortName(room)
  $('sheetWhen').textContent = ` · ${prettyDay(state.day)}, ${hm(start)}–${hm(end)}`
  $('book').hidden = st.cls !== 'free'

  const list = $('sheetDay')
  // The list is drawn anew; a keyboard user keeps their place on its buttons.
  const focused = list.contains(document.activeElement)
    ? document.activeElement.dataset.booking
    : null
  list.replaceChildren()
  if (!state.signedIn || state.bookingsDay !== state.day) return
  const day = state.bookings.filter((b) => b.roomId === room.id)
  if (day.length === 0) {
    const li = document.createElement('li')
    li.className = 'muted'
    li.textContent = 'Nothing booked this day.'
    list.append(li)
  }
  for (const b of day) {
    const li = document.createElement('li')
    if (b.mine) li.className = 'mine'
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = `${hm(new Date(b.start))}–${hm(new Date(b.end))}`
    const w = document.createElement('span')
    w.className = 'what'
    w.textContent = b.title + (b.mine ? ' (yours)' : b.organizer ? ` · ${b.organizer}` : '')
    li.append(t, w)
    if (b.mine && b.id) li.append(cancelButton(b, room))
    list.append(li)
  }
  if (focused) list.querySelector(`[data-booking="${CSS.escape(focused)}"]`)?.focus()
}

/** Cancel asks once more before it acts: the first press turns the button
 *  into "Yes, cancel", and only that one cancels. */
function cancelButton(b, room) {
  const when = `${hm(new Date(b.start))}–${hm(new Date(b.end))}`
  const asking = state.confirming === b.id
  const going = state.cancelling === b.id
  const button = document.createElement('button')
  button.className = asking || going ? 'danger compact' : 'ghost compact'
  button.textContent = going ? 'Cancelling…' : asking ? 'Yes, cancel' : 'Cancel'
  // One cancel at a time: every button waits while one is on its way.
  button.disabled = state.cancelling !== null
  button.dataset.booking = b.id
  // The name starts with the words on the button, so voice control finds it.
  button.setAttribute('aria-label', `${button.textContent} ${when}`)
  button.onclick = () => {
    if (!asking) return askToCancel(b.id)
    if (Date.now() - askedAt < SETTLE_MS) return
    cancel(b, room, when)
  }
  return button
}

function askToCancel(id) {
  state.confirming = id
  askedAt = Date.now()
  renderSheet()
  $('sheetDay').querySelector(`[data-booking="${CSS.escape(id)}"]`)?.focus()
}

async function cancel(b, room, when) {
  if (state.cancelling !== null) return
  // The button says so, and stays shut, until the plan has looked again: a
  // second press meanwhile would ask the site to cancel it twice.
  state.cancelling = b.id
  state.confirming = null
  renderSheet()
  say(`Cancelling ${shortName(room)}, ${when}…`)
  let failed = null
  try {
    await holi.booking.cancel(b.id)
  } catch (e) {
    failed = e
  }
  try {
    await refresh()
  } finally {
    state.cancelling = null
    renderSheet()
  }
  // A disabled button lost the focus: give it back to the row's button when
  // the booking is still there, else to the sheet.
  if (!$('sheet').hidden) {
    const row = $('sheetDay').querySelector(`[data-booking="${CSS.escape(b.id)}"]`)
    ;(row ?? $('closeSheet')).focus()
  }
  if (failed) return fail(failed)
  say(`Cancelled ${shortName(room)}, ${when}.`)
}

async function book() {
  if ($('book').disabled || Date.now() - selectedAt < SETTLE_MS) return
  const room = state.rooms.find((r) => r.id === state.selected)
  if (!room) return
  const { start, end } = slot()
  $('book').disabled = true
  say(`Booking ${shortName(room)}…`)
  try {
    await holi.booking.book({
      room: room.id,
      start: start.toISOString(),
      end: end.toISOString(),
      // The site wants a title; the room and the time say the rest.
      title: 'Meeting',
    })
  } catch (e) {
    // Most likely taken meanwhile: show the plan as it is now, then why.
    await refresh()
    fail(e)
    return
  } finally {
    $('book').disabled = false
  }
  // Booked, whatever the next look says: it is the line left showing.
  await refresh()
  say(`Booked ${shortName(room)}, ${hm(start)}–${hm(end)}.`)
}

// ── the time picker ─────────────────────────────────────────────────────────
// Start and end are buttons that open one small panel: hours on the left,
// quarter hours on the right. The end can never come before the start, so
// earlier times are greyed out, and a new start carries the end along.
const STEP = 15
const picker = { which: null } // 'start' or 'end' while the panel is open

function clock(m) {
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}
function length(m) {
  const h = Math.floor(m / 60)
  if (h === 0) return `${m} min`
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}
function bounds(which) {
  return which === 'start'
    ? { min: DAY_START * 60, max: DAY_END * 60 - STEP }
    : { min: state.start + STEP, max: DAY_END * 60 }
}
function timeOf(which) {
  return which === 'start' ? state.start : state.start + state.minutes
}
function setTime(which, m) {
  // A new start keeps the chosen length, cut short at the end of the day
  // without forgetting it; only a new end changes it.
  if (which === 'start') state.start = m
  else state.length = m - state.start
  syncTimes()
  render()
}

/** The two buttons and the length beside them, from the state. */
function syncTimes() {
  state.minutes = Math.min(state.length, DAY_END * 60 - state.start)
  $('start').querySelector('.value').textContent = clock(state.start)
  $('end').querySelector('.value').textContent = clock(state.start + state.minutes)
  $('duration').textContent = length(state.minutes)
  if (picker.which) fillPicker()
}

function option(label, selected, disabled, pick) {
  const b = document.createElement('button')
  b.className = 'option'
  b.setAttribute('role', 'option')
  b.setAttribute('aria-selected', String(selected))
  b.disabled = disabled
  b.textContent = label
  b.onclick = pick
  return b
}

function fillPicker() {
  const which = picker.which
  const { min, max } = bounds(which)
  const now = timeOf(which)
  const hour = Math.floor(now / 60)
  const minute = now % 60
  // Redrawing drops the focused option: put focus back on its column's pick.
  const focusedColumn = document.activeElement?.closest?.('.column')?.id

  const hours = $('pickHours')
  hours.replaceChildren()
  for (let h = Math.floor(min / 60); h <= Math.floor(max / 60); h++) {
    // Another hour keeps the minutes where they fit, else the nearest that do.
    const pick = () => setTime(which, Math.min(Math.max(h * 60 + minute, min), max))
    hours.append(option(pad(h), h === hour, false, pick))
  }
  const minutes = $('pickMinutes')
  minutes.replaceChildren()
  for (let m = 0; m < 60; m += STEP) {
    const t = hour * 60 + m
    const pick = () => {
      setTime(which, t)
      closePicker(true)
    }
    minutes.append(option(pad(m), m === minute, t < min || t > max, pick))
  }
  if (focusedColumn) $(focusedColumn).querySelector('[aria-selected="true"]')?.focus()
}

function openPicker(which) {
  if (picker.which === which) return closePicker(true)
  picker.which = which
  const pop = $('picker')
  pop.setAttribute('aria-label', which === 'start' ? 'Start time' : 'End time')
  for (const id of ['start', 'end']) $(id).setAttribute('aria-expanded', String(id === which))
  pop.hidden = false
  fillPicker()
  // Under its button, kept inside the window.
  const r = $(which).getBoundingClientRect()
  const left = Math.min(r.left, document.documentElement.clientWidth - pop.offsetWidth - 8)
  pop.style.left = `${Math.max(8, left) + window.scrollX}px`
  pop.style.top = `${r.bottom + window.scrollY + 6}px`
  for (const column of pop.querySelectorAll('.column')) {
    const chosen = column.querySelector('[aria-selected="true"]')
    if (chosen) column.scrollTop = chosen.offsetTop - (column.clientHeight - chosen.offsetHeight) / 2
  }
  $('pickHours').querySelector('[aria-selected="true"]')?.focus({ preventScroll: true })
}

function closePicker(refocus) {
  if (!picker.which) return
  const trigger = $(picker.which)
  picker.which = null
  $('picker').hidden = true
  for (const id of ['start', 'end']) $(id).setAttribute('aria-expanded', 'false')
  if (refocus) trigger.focus()
}

/** Up and down walk a column, left and right cross to the other one. */
function pickerKeys(e) {
  if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault()
    return closePicker(true)
  }
  const column = e.target.closest('.column')
  if (!column) return
  const enabled = (col) => [...col.querySelectorAll('.option:not(:disabled)')]
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const other = column.id === 'pickHours' ? $('pickMinutes') : $('pickHours')
    const target =
      other.querySelector('[aria-selected="true"]:not(:disabled)') ?? enabled(other)[0]
    target?.focus()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const options = enabled(column)
    const next = options[options.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1)]
    next?.focus()
    next?.scrollIntoView({ block: 'nearest' })
  }
}

// ── controls ────────────────────────────────────────────────────────────────
const CLOCK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.75" /><path d="M8 5v3l2 1.25" /></svg>'

function buildControls() {
  for (const which of ['start', 'end']) {
    const button = $(which)
    button.innerHTML = `${CLOCK}<span class="value"></span>`
    button.onclick = () => openPicker(which)
  }
  $('picker').addEventListener('keydown', pickerKeys)
  document.addEventListener('pointerdown', (e) => {
    if (picker.which && !e.target.closest('#picker, #start, #end')) closePicker(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picker.which) closePicker(true)
  })
  window.addEventListener('resize', () => closePicker(false))
  syncTimes()

  const dayInput = $('day')
  dayInput.value = state.day
  const setDay = (day) => {
    state.day = day
    state.confirming = null
    dayInput.value = day
    refresh()
  }
  dayInput.onchange = () => dayInput.value && setDay(dayInput.value)
  const shift = (n) => {
    const d = at(state.day, 0)
    d.setDate(d.getDate() + n)
    setDay(ymd(d))
  }
  $('prevDay').onclick = () => shift(-1)
  $('nextDay').onclick = () => shift(1)

  // No <form>: an app's frame may not submit one, so Enter is handled here.
  const onEnter = (el, fn) => el.addEventListener('keydown', (e) => e.key === 'Enter' && fn())
  $('sendLink').onclick = sendLink
  onEnter($('email'), sendLink)
  $('useLink').onclick = useLink
  onEnter($('link'), useLink)
  $('book').onclick = book
  $('closeSheet').onclick = () => select(state.selected)
}

// ── start ───────────────────────────────────────────────────────────────────
async function main() {
  buildControls()
  const saved = await prefs.get('main').catch(() => null)
  if (saved && saved.email) $('email').value = saved.email
  await refresh()
  // Others book too: look again every minute, and whenever Holi comes back.
  setInterval(refresh, 60_000)
  document.addEventListener(
    'visibilitychange',
    () => document.visibilityState === 'visible' && refresh(),
  )
}

main()
