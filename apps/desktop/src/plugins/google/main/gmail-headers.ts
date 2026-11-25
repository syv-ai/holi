/**
 * A person on a message, as the header spelled them.
 *
 * Both halves are kept: `name` is what a list shows, `email` is what identifies
 * them.
 */
export interface MailAddress {
  /** The display name, falling back to the address when the header had none. */
  name: string
  /** The bare address, lowercased, or `''` when the header carried nothing that
   *  looks like one. Empty means "do not offer a mailto:". */
  email: string
}

/**
 * `"Ada Holm" <ada@syv.ai>` → `{ name, email }`.
 *
 * **Both halves travel.** The name is what a list shows, but the address is the
 * only thing that identifies a person, and a renderer cannot recover what main
 * threw away.
 *
 * `email` is lowercased because addresses are compared, not just shown, and the
 * local part's case is not significant in any mail system anyone uses. `name`
 * falls back to the address so a display always has something to print.
 */
export function parseAddress(value: string | null): MailAddress {
  if (value === null) return { name: '', email: '' }
  const match = /^\s*(?:"((?:[^"\\]|\\[\s\S])*)"|([^"<]*?))\s*<([^<>]+)>\s*$/.exec(value)
  if (match !== null) {
    const email = match[3]!.trim().toLowerCase()
    const name = (match[1] ?? match[2] ?? '').replace(/\\([\s\S])/g, '$1').trim()
    return { name: name === '' ? email : name, email }
  }
  // A bare address, or a header this pattern does not fit. Treated as an
  // address when it looks like one at all, so `mailto:` still works.
  const bare = value.trim()
  return { name: bare, email: bare.includes('@') ? bare.toLowerCase() : '' }
}

function stripGroupLabel(mailbox: string): string {
  let quoted = false
  let escaped = false
  let angleDepth = 0
  for (let index = 0; index < mailbox.length; index += 1) {
    const character = mailbox[index]!
    if (escaped) escaped = false
    else if (character === '\\' && quoted) escaped = true
    else if (character === '"') quoted = !quoted
    else if (!quoted && character === '<') angleDepth += 1
    else if (!quoted && character === '>') angleDepth = Math.max(0, angleDepth - 1)
    else if (!quoted && angleDepth === 0 && character === ':') return mailbox.slice(index + 1)
  }
  return mailbox
}

export function parseAddresses(value: string | null): MailAddress[] {
  if (value === null) return []
  // RFC 5322 address lists can contain nested comments and named groups in
  // addition to quoted commas. Remove comments outside quoted strings, then
  // split only at top-level commas/semicolons; a group's label is not a mailbox.
  let uncommented = ''
  let quoted = false
  let escaped = false
  let commentDepth = 0
  for (const character of value) {
    if (escaped) {
      if (commentDepth === 0) uncommented += character
      escaped = false
    } else if (character === '\\' && quoted) {
      if (commentDepth === 0) uncommented += character
      escaped = true
    } else if (character === '"' && commentDepth === 0) {
      quoted = !quoted
      uncommented += character
    } else if (!quoted && character === '(') {
      commentDepth += 1
    } else if (!quoted && character === ')' && commentDepth > 0) {
      commentDepth -= 1
    } else if (commentDepth === 0) {
      uncommented += character
    }
  }

  const addresses: MailAddress[] = []
  let part = ''
  quoted = false
  escaped = false
  let angleDepth = 0
  for (const character of uncommented) {
    if (escaped) {
      part += character
      escaped = false
    } else if (character === '\\' && quoted) {
      part += character
      escaped = true
    } else if (character === '"') {
      quoted = !quoted
      part += character
    } else if (!quoted && character === '<') {
      angleDepth += 1
      part += character
    } else if (!quoted && character === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
      part += character
    } else if (!quoted && angleDepth === 0 && (character === ',' || character === ';')) {
      const mailbox = part.trim()
      const candidate = stripGroupLabel(mailbox)
      if (candidate !== '') addresses.push(parseAddress(candidate))
      part = ''
    } else {
      part += character
    }
  }
  if (part.trim() !== '') {
    addresses.push(parseAddress(stripGroupLabel(part)))
  }
  return addresses.filter((address) => address.name !== '')
}

/** Parse a header value and its complete RFC-style parameter list. */
export function parseHeaderParameters(
  value: string,
): { main: string; parameters: Map<string, string> } | null {
  const parts: string[] = []
  let part = ''
  let quoted = false
  let escaped = false
  for (const character of value) {
    if (escaped) {
      part += character
      escaped = false
    } else if (quoted && character === '\\') {
      part += character
      escaped = true
    } else if (character === '"') {
      quoted = !quoted
      part += character
    } else if (character === ';' && !quoted) {
      parts.push(part.trim())
      part = ''
    } else {
      part += character
    }
  }
  if (quoted || escaped) return null
  parts.push(part.trim())
  const main = parts.shift()
  if (!main) return null
  const parameters = new Map<string, string>()
  for (const entry of parts) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(.*)$/.exec(entry)
    if (!match || !match[2]) return null
    const name = match[1]!.toLowerCase()
    const raw = match[2]!
    let parsed: string
    if (raw.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\[\s\S])*"$/.test(raw)) return null
      parsed = raw.slice(1, -1).replace(/\\([\s\S])/g, '$1')
    } else {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(raw)) return null
      parsed = raw
    }
    if (parameters.has(name)) return null
    parameters.set(name, parsed)
  }
  return { main, parameters }
}

export function normalizeMessageIds(value: string, strictAngles = false): string[] | null {
  const unfolded = value.replace(/\r\n[\t ]+/g, ' ')
  if (/[\r\n]/.test(unfolded)) return null
  let clean = ''
  let comments = 0
  let escaped = false
  let quoted = false
  let inAngle = false
  for (const char of unfolded) {
    if (escaped) {
      if (comments === 0) clean += char
      escaped = false
    } else if (char === '\\') {
      if (comments === 0) clean += char
      escaped = true
    } else if (comments > 0) {
      if (char === '(') comments++
      else if (char === ')') comments--
    } else if (char === '"') {
      quoted = !quoted
      clean += char
    } else if (char === '(' && !quoted && !inAngle) comments++
    else {
      if (strictAngles && !quoted && (char === '<' || char === '>')) inAngle = char === '<'
      clean += char
    }
  }
  if (comments !== 0 || escaped || quoted) return null
  const text = strictAngles ? clean.replace(/^[\t ]+|[\t ]+$/g, '') : clean.trim()
  if (text === '') return []
  const ids = text.match(/<[^<>]+>/g) ?? []
  const gap = strictAngles ? /^[\t ]*$/ : /^\s*$/
  if (ids.length === 0 || !gap.test(text.replace(/<[^<>]+>/g, ''))) return null
  const valid = ids.every((token) => {
    const id = token.slice(1, -1)
    const at = id.lastIndexOf('@')
    if (at < 1 || at === id.length - 1) return false
    const atom = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~]+"
    const local = id.slice(0, at)
    const domain = id.slice(at + 1)
    return (
      new RegExp(`^(?:${atom}(?:\\.${atom})*|\"(?:[^\"\\\\\\r\\n]|\\\\[\\x00-\\x7f])*\")$`).test(
        local,
      ) && new RegExp(`^(?:${atom}(?:\\.${atom})*|\\[[^\\]\\r\\n]+\\])$`).test(domain)
    )
  })
  return valid ? ids : null
}
