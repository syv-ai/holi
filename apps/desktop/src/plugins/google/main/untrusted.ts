/**
 * What `holi google` hands the agent, with every string somebody else wrote
 * fenced as untrusted (`fenceUntrusted`, docs/features/google.md). The other
 * doors get the same values unfenced: the UI and a vault app render them, and
 * only the agent reads them as text it might act on.
 *
 * **Fenced in place, field by field**, so the JSON keeps its shape: `--json`,
 * the default print and a spilled file read with `jq` all carry the marker on
 * the very string that came from outside. A list of untrusted field names
 * beside the data would be lost the moment one field is picked out.
 *
 * **Every mail and every event, whoever wrote it.** A message the person sent
 * quotes the one it answers, and an event on their own calendar may be an
 * invite's title copied in: Holi cannot tell which text is theirs, so none of
 * it is. Ids, addresses, dates, links and flags are left as they are: they are
 * what the agent passes back to a command, and none is free prose.
 */
import { fenceUntrusted } from '@holi/shared'
import type { CalendarEvent } from './calendar'
import type { AgentMailThread, MailAddress, MailThreadSummary } from './gmail'

const mail = (text: string, from?: string): string =>
  fenceUntrusted(text, 'mail', from === undefined ? {} : { from })

const person = (address: MailAddress): MailAddress => ({ ...address, name: mail(address.name) })

/** `holi google search`'s threads. */
export function fenceThreads(threads: MailThreadSummary[]): MailThreadSummary[] {
  return threads.map((t) => ({
    ...t,
    subject: mail(t.subject),
    snippet: mail(t.snippet, t.from.email),
    from: person(t.from),
  }))
}

/** `holi google read`'s thread: each body fenced with its sender's address. */
export function fenceThread(thread: AgentMailThread): AgentMailThread {
  return {
    ...thread,
    subject: mail(thread.subject),
    messages: thread.messages.map((m) => ({
      ...m,
      from: person(m.from),
      to: m.to.map(person),
      cc: m.cc.map(person),
      bcc: m.bcc.map(person),
      attachments: m.attachments.map((a) => ({ ...a, filename: mail(a.filename) })),
      body: mail(m.body, m.from.email),
    })),
  }
}

const calendar = (text: string): string => fenceUntrusted(text, 'calendar')

/** `holi google agenda`'s events. */
export function fenceEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.map((e) => ({
    ...e,
    title: calendar(e.title),
    ...(e.location === undefined ? {} : { location: calendar(e.location) }),
    description: e.description === null ? null : calendar(e.description),
    organizer: e.organizer === null ? null : calendar(e.organizer),
  }))
}
