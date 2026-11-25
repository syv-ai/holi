import { expect, test } from 'vitest'
import {
  conferenceUrlIn,
  googleEventUrl,
  httpsLink,
  providerConferenceUrl,
} from '../shared/meeting-links'

test('normalizes explicit HTTPS destinations without labeling unknown hosts as providers', () => {
  const mail = ' HTTPS://BÜCHER.example.test:443/call?room=42 '
  expect(httpsLink(mail)).toBe('https://xn--bcher-kva.example.test/call?room=42')
  expect(providerConferenceUrl(mail)).toBeNull()
  expect(conferenceUrlIn(`Join at ${mail.trim()}`)).toBeNull()
})

test.each([
  'https://guest@meet.google.com/abc-defg-hij',
  'https://@meet.google.com/abc-defg-hij',
  'https://meet.google.com:444/abc-defg-hij',
  'https://%6deet.google.com/abc-defg-hij',
  'https://meet.google.com/junk/../abc-defg-hij',
  'http://meet.google.com/abc-defg-hij',
])('rejects unsafe explicit and conference destinations: %s', (url) => {
  expect(httpsLink(url)).toBeNull()
  expect(providerConferenceUrl(url)).toBeNull()
})

test('extracts the first known conference from Calendar HTML or Mail prose', () => {
  const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0'
  const zoom = 'https://example.zoom.us/j/123456789'
  expect(
    conferenceUrlIn(
      `<a href="https://notzoom.us/j/123">Lookalike</a>` +
        `<a href="${teams}?tenant=a&amp;join=b">Join</a> ${zoom}.`,
    ),
  ).toBe(`${teams}?tenant=a&join=b`)
  expect(conferenceUrlIn(`Join: (${zoom}).`)).toBe(zoom)
  expect(providerConferenceUrl('https://MEET.GOOGLE.COM:443/abc-defg-hij')).toBe(
    'https://meet.google.com/abc-defg-hij',
  )
})

test.each([
  'https://zoom.us.example.test/j/123',
  'https://examplezoom.us/j/123',
  'https://meet.google.com/abc-defg-hij/redirect',
  'https://zoom.us/j/123/redirect',
  'https://teams.microsoft.com/l/meetup-join/not%2fa%2froom/0',
  'https://teams.live.com/meet/',
])('does not promote lookalikes or nonconference paths found in prose: %s', (url) => {
  expect(providerConferenceUrl(url)).toBeNull()
  expect(conferenceUrlIn(`Join here: ${url}.`)).toBeNull()
})

test('Google Calendar actions require an event path and one event ID', () => {
  expect(googleEventUrl('https://CALENDAR.GOOGLE.COM:443/calendar/event?eid=abc-42')).toBe(
    'https://calendar.google.com/calendar/event?eid=abc-42',
  )
  expect(googleEventUrl('https://calendar.google.com/event?eid=event')).not.toBeNull()
  for (const url of [
    'https://calendar.google.com.fake.test/calendar/event?eid=abc',
    'https://calendar.google.com:8443/calendar/event?eid=abc',
    'https://calendar.google.com/calendar/r?eid=abc',
    'https://calendar.google.com/calendar/event?eid=abc&eid=other',
    'https://calendar.google.com/calendar/event?eid=',
  ])
    expect(googleEventUrl(url)).toBeNull()
})
