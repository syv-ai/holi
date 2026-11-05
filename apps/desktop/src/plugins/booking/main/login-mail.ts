/**
 * Finding the booking site's login email in the person's Gmail, through the
 * Google plugin's capabilities (`google.search`, `google.thread`), and taking
 * the login link out of it.
 *
 * Mail is untrusted input. Only a link to the booking site's own auth
 * endpoint or callback is taken, only from a message that arrived after Holi
 * asked for it, and the link is worthless without the PKCE verifier Holi kept
 * (`auth.ts`). A phishing mail that names the site gets nowhere.
 */

/** The two Google reads this needs, as the capability host answers them. */
export interface MailLookup {
  search(query: string): Promise<{ id: string; date: string }[]>
  messages(threadId: string): Promise<{ date: string; body: string; html: string | null }[]>
}

/** What a login email carries: its link, or a one-time code. */
export type LoginSecret = { link: string } | { code: string }

/** Mail clocks and ours disagree by seconds; a message this much older than
 *  the request can still be its answer. */
const CLOCK_SLACK_MS = 60_000
/** Threads read per poll. A login email is the newest mail with the site in it. */
const THREADS_PER_POLL = 5

function loginQuery(host: string): string {
  return `newer_than:1d "${host}"`
}

/**
 * The login link or code in one message, or null.
 * @public exported for its test
 */
export function extractLoginSecret(
  message: { body: string; html: string | null },
  host: string,
): LoginSecret | null {
  const text = `${message.html ?? ''}\n${message.body}`.replace(/&amp;/g, '&')
  for (const match of text.matchAll(/https:\/\/[^\s"'<>()]+/g)) {
    let url: URL
    try {
      url = new URL(match[0])
    } catch {
      continue
    }
    if (url.host !== host) continue
    const verify = url.pathname === '/auth/v1/verify' && url.searchParams.has('token')
    const callback = url.pathname === '/callback' && url.searchParams.has('code')
    if (verify || callback) return { link: url.toString() }
  }
  const code = /\b(?:code|kode)\b[^0-9]{0,40}(\d{6,10})\b/i.exec(message.body)
  return code === null ? null : { code: code[1]! }
}

/** The link or code itself, which is how a secret already tried is known. */
export const secretText = (secret: LoginSecret): string =>
  'link' in secret ? secret.link : secret.code

/** The newest login secret that arrived since `since` and is not in `skip`,
 *  or null.
 * @public exported for its test
 */
export async function findLoginSecret(
  mail: MailLookup,
  host: string,
  since: number,
  skip: ReadonlySet<string> = new Set(),
): Promise<LoginSecret | null> {
  const after = since - CLOCK_SLACK_MS
  const threads = (await mail.search(loginQuery(host)))
    .filter((t) => Date.parse(t.date) >= after)
    .slice(0, THREADS_PER_POLL)
  for (const thread of threads) {
    const messages = (await mail.messages(thread.id))
      .filter((m) => Date.parse(m.date) >= after)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    for (const message of messages) {
      const secret = extractLoginSecret(message, host)
      if (secret !== null && !skip.has(secretText(secret))) return secret
    }
  }
  return null
}

/**
 * Poll for the login email until it arrives or `stop` says to give up: the
 * login is over, or its time has run out (the caller keeps the clock, so the
 * time Gmail takes to answer counts too). `skip` holds secrets already tried,
 * such as an older login's link that arrived within the clock slack. Null on
 * a stop; a Google failure (no account, plugin off) is thrown, so the caller
 * can say "paste the link instead".
 */
export async function waitForLoginSecret(
  mail: MailLookup,
  host: string,
  since: number,
  opts: {
    intervalMs: number
    stop: () => boolean
    sleep?: (ms: number) => Promise<void>
    skip?: ReadonlySet<string>
  },
): Promise<LoginSecret | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let first = true; ; first = false) {
    if (!first) await sleep(opts.intervalMs)
    if (opts.stop()) return null
    const found = await findLoginSecret(mail, host, since, opts.skip)
    if (found !== null) return found
  }
}
