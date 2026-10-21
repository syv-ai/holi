/**
 * GitHub logins, the names a vault's members go by. One rule says which
 * logins are one person (GitHub ignores case) and how a list of them is made,
 * so no caller spells it out again.
 */

/** A login as written by hand or typed after `@`: trimmed, without the `@`. */
export function normalizeLogin(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim()
}

/** Whether two logins are one person. GitHub ignores a login's case, so every
 *  comparison of logins goes through here and none spells it out again. */
export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether `login` is among `logins`, whatever its case. */
export function hasLogin(logins: readonly string[], login: string): boolean {
  return logins.some((l) => sameLogin(l, login))
}

/**
 * Logins as a clean list: each without its `@`, the empty ones dropped, and
 * each person once whatever the case, in the spelling given first. A task's
 * assignees and every list of people to pick from are made with it.
 */
export function cleanLogins(raw: Iterable<string>): string[] {
  const out: string[] = []
  for (const entry of raw) {
    const login = normalizeLogin(entry)
    if (login !== '' && !hasLogin(out, login)) out.push(login)
  }
  return out
}

/** `logins` without `login` if it is there, in whatever case, and with it if
 *  not: one switch per person, however their name was typed. */
export function toggleLogin(logins: readonly string[], login: string): string[] {
  return hasLogin(logins, login) ? logins.filter((l) => !sameLogin(l, login)) : [...logins, login]
}
