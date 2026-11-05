#!/usr/bin/env node
// Holi PreToolUse hook — the send gate.
//
// Sending mail, replying and answering an invitation are the things the agent
// can do that reach another human and cannot be undone, and a raw `holi google
// api` call that is not a GET may be any of them. Everything else it can do to
// a mailbox or a calendar, the user can put back with one click.
//
// So this returns `ask` for those, and nothing at all for everything else.
// `ask` is the mechanism the whole design was chosen for: it overrides
// `permissions.allow` AND a prior "don't ask again", which no permission rule
// does. The user still decides — they just always get to. Printing nothing and
// exiting 0 is how a PreToolUse hook has no opinion, so the normal permission
// flow decides; returning `allow` instead would silently widen every other
// command the agent runs. Not `defer`: Claude Code reads that as "pause this
// tool call for someone outside", and in a conversation run (`claude -p`) the
// turn then ends with the command never run.
//
// **It fails closed.** Unparseable input, an unexpected shape, any internal
// error — all `ask`. A gate that crashes into no opinion is a gate that opens, and
// the cost of a needless prompt is a click while the cost of a missed one is an
// email that has already gone.
//
// **The honest limit**: this gates a *cooperative* agent, not
// an adversarial one. No string match survives `eval`, a variable, or `sh -c`.
// The claim it supports is "the agent never sends without you seeing it", not
// "the agent cannot send".

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  )
  // Always 0. A non-zero exit is a *hook error*, which is a different thing
  // from a decision and is not guaranteed to stop the tool call.
  process.exit(0)
}

const ask = (reason) => decide('ask', reason)
/** No opinion: print nothing, exit 0, and the normal permission flow decides. */
const pass = () => process.exit(0)

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(''))
  })
}

/**
 * Who this command reaches, as far as the command itself can say.
 *
 * The prompt is the entire consent surface, and consenting to a send means
 * knowing *to whom*. The body is on stdin and cannot be shown here, but the
 * recipients usually can.
 *
 * A `reply` is the exception: its recipients are derived from the thread inside
 * Holi, so they are nowhere in the command, and the prompt says so plainly.
 */
function audienceOf(command, verb) {
  // `send --draft <id>` is the second exception: the draft carries its own
  // recipients inside Gmail, and the user can go and look at it.
  if (/--draft\b/.test(command)) {
    return (
      'It sends a draft that already exists in Gmail. The recipients are in the ' +
      'draft rather than in this command, so open it in Drafts if you want to check them.'
    )
  }
  if (verb === 'reply') {
    return /--all\b/.test(command)
      ? 'It goes to everyone on the thread (--all). Holi works the recipients out ' +
          'from the thread, so they are not visible in this command.'
      : 'It goes to the sender of the thread. Holi works that out from the thread, ' +
          'so the recipient is not visible in this command.'
  }
  // `--to a@b.c --cc d@e.f`, repeated as often as the caller likes.
  const recipients = [...command.matchAll(/--(?:to|cc)[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter(Boolean)
  if (recipients.length === 0) {
    return 'Holi could not read the recipients out of this command, so check it before allowing.'
  }
  return `It goes to: ${recipients.join(', ')}.`
}

const attachmentsOf = (command) => {
  const words = asTheShellReads(command.split('<<')[0] ?? '')
  const tokens = words.split(/[\s|;&()]+/).filter(Boolean)
  const paths = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token === '--attach') {
      if (tokens[i + 1]) paths.push(tokens[++i].replaceAll('\uE000', ' '))
    } else if (token.startsWith('--attach=')) {
      paths.push(token.slice('--attach='.length).replaceAll('\uE000', ' '))
    }
  }
  return paths.length ? ` It attaches: ${paths.join(', ')}.` : ''
}

const MAIL_PROMPT = (command, _next, verb) =>
  `This sends mail from your account. ${audienceOf(command, verb)}${attachmentsOf(command)} ` +
  'It cannot be recalled, so Holi asks every time — even if you have allowed ' +
  'this command before. The message text is on stdin and is not shown here.'

/**
 * The `holi google` verbs that reach another person, and what the prompt for
 * each says. Each takes the command line as a shell reads it
 * (`asTheShellReads`), the word after the verb and the verb, and
 * answers the reason to ask, or `null` when this call reaches nobody. A verb
 * not here has no opinion.
 *
 * `api` is decided from the method alone: its body is on stdin, which this
 * cannot see, so every call that is not a GET asks, whatever it does. Holi
 * itself refuses the calls no answer may allow (a permanent delete, a path
 * outside Gmail and Calendar), so this only has to ask.
 */
const REACHES_A_HUMAN = {
  send: MAIL_PROMPT,
  reply: MAIL_PROMPT,
  respond: () =>
    'This answers a calendar invitation from your account, and Google tells the ' +
    'organizer, with any --comment in the command. Holi asks every time — even if ' +
    'you have allowed this command before.',
  api: (_command, method) =>
    method.toUpperCase() === 'GET'
      ? null
      : `This calls Google's API directly (${method || 'no method'}). Holi cannot tell ` +
        'from the command whether it reaches someone (sending mail, changing an event ' +
        'other people are invited to), so it asks for every call that is not a GET. ' +
        'Any body is on stdin and is not shown here. Holi refuses permanent deletes ' +
        'itself, whatever you answer.',
}

/**
 * The command line with its quoting taken away, as a shell would read the
 * words: a backslash-newline joins the lines, quotes go (`a""pi`, `'send'`,
 * `$'respond'`, `"$HOLI_BIN"`) and a backslash before a character leaves the
 * character (`s\end`). The text inside a quote is kept as it is, spaces
 * included, so a quoted path or a quoted `holi google send` in an `echo` reads
 * as words too: a needless prompt costs a click, a missed one a mail.
 * Expansions are left as written; no string match follows those.
 */
function asTheShellReads(command) {
  let out = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\') {
      const next = command[++i]
      if (next !== undefined && next !== '\n') out += next
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      out += (end < 0 ? command.slice(i + 1) : command.slice(i + 1, end)).replace(/ /g, '\uE000')
      i = end < 0 ? command.length : end
    } else if (c === '$' && command[i + 1] === "'") {
      i += 2
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\' && i + 1 < command.length) {
          const [char, used] = ansiEscape(command, i + 1)
          out += char
          i += used + 1
        } else {
          out += command[i++]
        }
      }
    } else if (c === '"' || (c === '$' && command[i + 1] === '"')) {
      if (c === '$') i++
      for (i++; i < command.length && command[i] !== '"'; i++) {
        // Inside double quotes a backslash only escapes `$`, a backtick, `"`,
        // a backslash or a newline; before anything else it stays.
        if (command[i] === '\\' && '$`"\\\n'.includes(command[i + 1] ?? '')) {
          i++
          if (command[i] !== '\n') out += command[i] === ' ' ? '\uE000' : command[i]
        } else {
          out += command[i] === ' ' ? '\uE000' : command[i]
        }
      }
    } else {
      out += c
    }
  }
  return out
}

/** One escape inside `$'…'`, read from just after its backslash: the
 *  character it stands for, and how many characters it took. */
function ansiEscape(text, at) {
  const c = text[at]
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(at))
  if (hex) return [String.fromCharCode(parseInt(hex[1], 16)), hex[0].length]
  const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(text.slice(at))
  if (uni) {
    const code = parseInt(uni[1], 16)
    return [code <= 0x10ffff ? String.fromCodePoint(code) : '', uni[0].length]
  }
  const oct = /^[0-7]{1,3}/.exec(text.slice(at))
  if (oct) return [String.fromCharCode(parseInt(oct[0], 8)), oct[0].length]
  const named = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }
  return [Object.hasOwn(named, c) ? named[c] : c, 1]
}

/**
 * Why to ask about this command line, or `null`: does it invoke a `holi google`
 * verb that reaches someone?
 *
 * Matched on the *invocation*, not on the presence of the word: `grep send
 * notes.md` is not a send, and a gate that prompts on it teaches the user to
 * click through prompts. Every invocation in the line is checked.
 *
 * Three spellings of the command are live, and all must match: the bare name
 * (resolved via PATH), `$HOLI_BIN`, and an absolute path to the generated
 * script. Matched on the line as a shell reads it, so quoting, escaping or a
 * line continuation anywhere in the words changes nothing. Missing one is a
 * gate that never fires. Holi refuses any word between `holi` and the verb,
 * so nothing can be slipped in between to step around this.
 */
function reasonToAsk(command) {
  const words = asTheShellReads(command)
  // The command word, however it was spelled, then `google`, then the verb,
  // then the word after it. `[^\s|;&]*` keeps them adjacent within one
  // pipeline stage, so `holi google search x | grep send` does not match.
  const invocation = new RegExp(
    String.raw`(?:^|[|;&(\n])\s*` + // start of a command
      String.raw`(?:command[ \t]+)?(?:\$\{?HOLI_BIN\}?|/[^|;&(\n]*?\bholi|[^\s|;&(\n]*\bholi)` + // the binary
      String.raw`[ \t]+google` + // the group; never cross a command boundary
      String.raw`[ \t]+([A-Za-z-]+)\b` + // the verb
      String.raw`(?:[ \t]+([^\s|;&(]*))?`, // the word after it
    'g',
  )
  for (const [, verb, next] of words.matchAll(invocation)) {
    if (!Object.hasOwn(REACHES_A_HUMAN, verb)) continue
    const reason = REACHES_A_HUMAN[verb](command, next ?? '', verb)
    if (reason !== null) return reason
  }
  return null
}

const raw = await readStdin()

let payload
try {
  payload = JSON.parse(raw)
} catch {
  ask('Holi could not read this tool call, so it is asking rather than assuming it is safe.')
}

if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
  ask('Holi could not read this tool call, so it is asking rather than assuming it is safe.')
}

/**
 * A claude.ai Gmail **connector** call.
 *
 * An MCP tool call is not a shell command, so the `Bash` matcher never sees it.
 * `disableClaudeAiConnectors` in the seeded settings is the real fix; this is
 * the fallback for a vault whose user turns the connector back on. Matched on
 * the tool *name*, which the harness supplies.
 *
 * **Two loose tests rather than one exact one**, because the point of a
 * fallback is the connector nobody enumerated (`send_email`, `messages_send`).
 * A false match costs one extra prompt; a miss costs a mail sent unasked.
 */
/** A sending verb standing alone in the name — so `messages_send` matches and
 *  `resend_webhook` does not. */
const SENDS = /(?:^|_)(send|reply|forward)(?:_|$)/i
/** …and it has to be about mail. The prompt this raises talks about a message
 *  reaching a person; asking it of `mcp__slack__send_message` would be a
 *  confusing lie rather than a cautious win. */
const MAILISH = /gmail|mail|email/i

if (typeof payload.tool_name === 'string' && payload.tool_name.startsWith('mcp__')) {
  const tool = payload.tool_name.slice(payload.tool_name.lastIndexOf('__') + 2)
  if (SENDS.test(tool) && MAILISH.test(payload.tool_name)) {
    ask(
      'This sends mail through a claude.ai Gmail connector rather than through Holi. ' +
        'Holi cannot see the recipients or the message, and none of its own protections ' +
        'apply — the mail is sent with a separate connection to Google. ' +
        'It cannot be recalled, so Holi asks every time.',
    )
  }
  // A read or a draft through the connector reaches nobody, so this hook has no
  // opinion — it gates what cannot be undone, not what it dislikes.
  pass()
}

// Not a shell command at all — nothing here can send anything.
if (payload.tool_name !== 'Bash') pass()

const command = payload.tool_input?.command
if (typeof command !== 'string') {
  ask('Holi could not read this command, so it is asking rather than assuming it is safe.')
}

let reason
try {
  reason = reasonToAsk(command)
} catch {
  ask('Holi could not read this command, so it is asking rather than assuming it is safe.')
}
if (reason !== null) ask(reason)

pass()
