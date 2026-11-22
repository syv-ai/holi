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
  // Private-use markers are parser syntax, not filename characters. Escape any
  // literal occurrences before parsing so they can never be mistaken for it.
  const safeCommand = command.replace(/[\uE000\uE100\uE101]/g, (char) => `%${char.charCodeAt(0)}%`)
  const words = asTheShellReads(safeCommand.split('<<')[0] ?? '')
  const tokens = words.split(/[\s|;&()]+/).filter(Boolean)
  const paths = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token === '--attach') {
      if (tokens[i + 1]) paths.push(tokens[++i].replaceAll('\uE000', ' ').replace(/\uE100(\d+)\uE101/g, (_, code) => String.fromCharCode(Number(code))).replace(/%(57344|57600|57601)%/g, (_, code) => String.fromCharCode(Number(code))))
    } else if (token.startsWith('--attach=')) {
      paths.push(token.slice('--attach='.length).replaceAll('\uE000', ' ').replace(/\uE100(\d+)\uE101/g, (_, code) => String.fromCharCode(Number(code))).replace(/%(57344|57600|57601)%/g, (_, code) => String.fromCharCode(Number(code))))
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
      if (next !== undefined && next !== '\n') out += /[;|&()<>]/.test(next) ? `\uE100${next.charCodeAt(0)}\uE101` : next === ' ' ? '\uE000' : next
    } else if (c === '$' && command[i + 1] === "'") {
      i += 2
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\' && i + 1 < command.length) {
          const [char, used] = ansiEscape(command, i + 1)
          out += /[\t\r\n;|&()<>]/.test(char) ? `\uE100${char.charCodeAt(0)}\uE101` : char === ' ' ? '\uE000' : char
          i += used + 1
        } else {
          const char = command[i++]
          out += char === ' ' ? '\uE000' : /[\t\r\n;|&()<>]/.test(char) ? `\uE100${char.charCodeAt(0)}\uE101` : char
        }
      }
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      out += (end < 0 ? command.slice(i + 1) : command.slice(i + 1, end)).replace(/ /g, '\uE000').replace(/[\t\r\n;|&()<>]/g, (x) => `\uE100${x.charCodeAt(0)}\uE101`)
      i = end < 0 ? command.length : end
    } else if (c === '"' || (c === '$' && command[i + 1] === '"')) {
      if (c === '$') i++
      for (i++; i < command.length && command[i] !== '"'; i++) {
        // Inside double quotes a backslash only escapes `$`, a backtick, `"`,
        // a backslash or a newline; before anything else it stays.
        if (command[i] === '\\' && '$`"\\\n'.includes(command[i + 1] ?? '')) {
          i++
          if (command[i] !== '\n') {
            const char = command[i]
            out += char === ' ' ? '\uE000' : /[\t\r\n;|&()<>]/.test(char) ? `\uE100${char.charCodeAt(0)}\uE101` : char
          }
        } else {
          const char = command[i]
          out += char === ' ' ? '\uE000' : /[\t\r\n;|&()<>]/.test(char) ? `\uE100${char.charCodeAt(0)}\uE101` : char
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
  const hex = /^x([0-9a-fA-F]{1,2})(?![0-9a-fA-F])/.exec(text.slice(at))
  if (hex) return [String.fromCharCode(parseInt(hex[1], 16)), hex[0].length]
  const uni = text[at] === 'u'
    ? /^u([0-9a-fA-F]{4})(?![0-9a-fA-F])/.exec(text.slice(at))
    : /^U([0-9a-fA-F]{8})(?![0-9a-fA-F])/.exec(text.slice(at))
  if (uni) {
    const code = parseInt(uni[1], 16)
    return [code <= 0x10ffff ? String.fromCodePoint(code) : '', uni[0].length]
  }
  const oct = /^[0-7]{1,3}/.exec(text.slice(at))
  if (oct) return [String.fromCharCode(parseInt(oct[0], 8)), oct[0].length]
  const named = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }
  return [Object.hasOwn(named, c) ? named[c] : c, 1]
}

/** Shell words that open a stage and leave its command word after them. */
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'command', 'builtin', 'exec'])
/** Commands that only print or search their words, so a `holi google send`
 *  among them runs nothing. Anything else may be running what it names, under
 *  options this cannot know (`sudo -u ada`, `gtimeout 30`, `find -exec`). */
const ONLY_READS_ITS_WORDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg'])
/**
 * The word that runs Holi: `holi`, a path ending in it (`./holi`, `/…/bin/holi`),
 * or `$HOLI_BIN` / `${HOLI_BIN}`. The name matches in any case, since macOS
 * finds `HOLI` and `…/Holi` as `holi`; the variable as written, since the
 * shell's names are case-sensitive. `holi-src` or `$HOLI_BINX` is not it.
 */
const HOLI_WORD = /^(?:\$\{?HOLI_BIN\}?|(?:.*\/)?[Hh][Oo][Ll][Ii])$/
const EXPANDS = /[`$]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Commands that run the command they are given: an expansion among their
 *  words may be Holi. After anything else (`cp "$a" google x`) it is not. */
const RUNNERS = new Set(['env', 'nohup', 'nice', 'sudo', 'xargs', 'timeout', 'gtimeout', 'stdbuf', 'setsid'])

const HIDDEN_VERB =
  'Part of this holi google command comes from a variable or a substitution, so Holi ' +
  'cannot tell whether it sends something. Check it before allowing.'

/**
 * Why to ask about `<holi> group verb next`, or `null`. Holi refuses any word
 * between its name and the verb, so these are the only places an outgoing verb
 * can be: an expansion later in the line cannot turn this into a send.
 */
function reasonForWords(group, verb, next, command) {
  if (group === undefined) return null
  if (EXPANDS.test(group)) return HIDDEN_VERB
  if (group !== 'google' || verb === undefined) return null
  if (EXPANDS.test(verb)) return HIDDEN_VERB
  if (!Object.hasOwn(REACHES_A_HUMAN, verb)) return null
  return REACHES_A_HUMAN[verb](command, next ?? '', verb)
}

const couldBeOutgoing = (word) =>
  word !== undefined && (EXPANDS.test(word) || Object.hasOwn(REACHES_A_HUMAN, word))

/** What the line's own variables hold of a `holi google` command, as in
 *  `G="holi google"; $G send` or `cmd="holi google send"; $cmd`. A walk over
 *  its words, once per line, since a line can be a long unbroken value. */
function heldInVariables(line) {
  const parts = line.split(/[\s\uE000|;&()]+/)
  const held = { group: false, verb: false, google: false }
  for (let i = 0; i < parts.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=google$/.test(parts[i])) held.google = true
    if (parts[i] !== 'google' || !/(?:holi|HOLI_BIN|\$[A-Za-z_][A-Za-z0-9_]*)(?:\}|\uE10041\uE101|\$_)?$/i.test(parts[i - 1] ?? '')) continue
    if (!parts.slice(Math.max(0, i - 3), i).some((part) => ASSIGNMENT.test(part))) continue
    held.group = true
    if (couldBeOutgoing(parts[i + 1])) held.verb = true
  }
  return held
}

/** Why to ask about a command word that is an expansion, followed by words
 *  other than `google`: only if the line's own variables could make it one. */
function reasonBehindExpansion(second, third, held) {
  if (held.verb) return HIDDEN_VERB
  if (held.group && couldBeOutgoing(second)) return HIDDEN_VERB
  if (held.google && EXPANDS.test(second ?? '') && couldBeOutgoing(third)) return HIDDEN_VERB
  return null
}

/** A stage's words, with its redirections taken out wherever they stand:
 *  `send>/dev/null`, `>"$T" send`, `2> err send`. */
function stageWords(stage) {
  const tokens = stage.trim().split(/[ \t]+/).filter(Boolean)
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const redirect = /^(.*?)\d*[<>]/.exec(tokens[i])
    if (redirect === null) {
      out.push(tokens[i])
      continue
    }
    if (redirect[1] !== '') out.push(redirect[1])
    if (/[<>]$/.test(tokens[i])) i++ // its target is the next word
  }
  return out
}

function reasonInStage(tokens, held, command) {
  let at = 0
  while (
    at < tokens.length &&
    (KEYWORDS.has(tokens[at]) ||
      ASSIGNMENT.test(tokens[at]) ||
      (/^-/.test(tokens[at]) && KEYWORDS.has(tokens[at - 1] ?? '')))
  ) {
    at++
  }
  const first = tokens[at]
  if (first === undefined) return null
  if (ONLY_READS_ITS_WORDS.has(first.slice(first.lastIndexOf('/') + 1))) return null
  // `holi google <verb>` anywhere in the stage: whatever runs it.
  const runs = (word, i) =>
    HOLI_WORD.test(word) || (EXPANDS.test(word) && (i === at || RUNNERS.has(first)))
  for (let i = at; i < tokens.length; i++) {
    if (tokens[i + 1] === 'google' && runs(tokens[i], i)) {
      const reason = reasonForWords('google', tokens[i + 2], tokens[i + 3], command)
      if (reason !== null) return reason
    }
  }
  if (RUNNERS.has(first)) {
    // `sudo -u ada holi $G send`: Holi behind a runner's own options is run the
    // same as Holi first. A word that is neither ends them (`env grep holi "$f"`).
    for (let i = at + 1; i < tokens.length; i++) {
      if (HOLI_WORD.test(tokens[i])) {
        const reason = reasonForWords(tokens[i + 1], tokens[i + 2], tokens[i + 3], command)
        if (reason !== null) return reason
        break
      }
      if (!/^-|^\d/.test(tokens[i]) && !ASSIGNMENT.test(tokens[i]) && !/^-/.test(tokens[i - 1])) break
    }
    const i = tokens.findIndex((word, j) => j > at && EXPANDS.test(word))
    if (i > 0) {
      const reason = reasonBehindExpansion(tokens[i + 1], tokens[i + 2], held)
      if (reason !== null) return reason
    }
  }
  if (HOLI_WORD.test(first)) return reasonForWords(tokens[at + 1], tokens[at + 2], tokens[at + 3], command)
  if (EXPANDS.test(first)) return reasonBehindExpansion(tokens[at + 1], tokens[at + 2], held)
  return null
}

/** The line with each `$(…)` and backtick substitution as one word that
 *  expands, so `$(which holi) google send` reads as a command and its words. */
function withSubstitutionsAsWords(words) {
  let out = words
  for (let before; before !== out; ) {
    before = out
    out = out.replace(/\$\([^()]*\)/g, '$$_').replace(/`[^`]*`/g, '$$_')
  }
  return out
}

/** Why to ask about one command line as a shell reads it, or `null`. */
function reasonInWords(words, command, held) {
  const line = withSubstitutionsAsWords(words)
    .replace(/&>/g, '>')
    .replace(/\d*[<>]&[\d-]+/g, ' ')
  for (const stage of line.split(/[|;&()\n]/)) {
    const reason = reasonInStage(stageWords(stage), held, command)
    if (reason !== null) return reason
  }
  return null
}

/** A line that hands a heredoc to a shell, whose body is therefore commands. */
const FEEDS_SHELL = /(?:^|[\s|;&(])(?:eval|source|(?:\S*\/)?(?:ba|z|da)?sh)(?:\s|<|$)|(?:^|[|;&(])\s*\.\s/

/**
 * The command without what is not code, read with its quotes in mind: comments
 * go, and a heredoc's body is text, so its words and apostrophes must not
 * count. A heredoc fed to a shell is commands and stays. `textBodies` are the
 * bodies with an unquoted tag, whose substitutions still run.
 */
function codeOf(command) {
  let code = ''
  const textBodies = []
  let pending = []
  let quote = null
  // A `$(…)` is code again inside double quotes, heredocs and all: the quote
  // waits here until its closing parenthesis.
  let depth = 0
  const frames = []
  for (let i = 0; i < command.length; ) {
    const c = command[i]
    if (quote === "'") {
      code += c
      if (c === "'") quote = null
      i++
    } else if (c === '\\') {
      code += command.slice(i, i + 2)
      i += 2
    } else if (quote === '"' && !(command.startsWith('$(', i) && command[i + 2] !== '(')) {
      code += c
      if (c === '"') quote = null
      i++
    } else if (command.startsWith('$(', i) && command[i + 2] !== '(') {
      frames.push({ quote, depth })
      quote = null
      depth = 0
      code += '$('
      i += 2
    } else if (c === "'" || c === '"') {
      quote = c
      code += c
      i++
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
      const end = command.indexOf('\n', i)
      i = end < 0 ? command.length : end
    } else if (command.startsWith('${', i) || command.startsWith('((', i)) {
      // A parameter's `#` and an arithmetic `<<` are neither comment nor heredoc.
      const close = c === '$' ? '}' : '))'
      const end = command.indexOf(close, i)
      const stop = end < 0 ? i + 1 : end + close.length
      code += command.slice(i, stop)
      i = stop
    } else if (c === '\n' && pending.length > 0) {
      const joined = code.replace(/\\\n/g, ' ')
      const line = joined.slice(joined.lastIndexOf('\n') + 1)
      const feedsShell = FEEDS_SHELL.test(line)
      code += '\n'
      i++
      for (const { dash, tag, expands } of pending) {
        const start = i
        for (;;) {
          const end = command.indexOf('\n', i)
          const text = command.slice(i, end < 0 ? command.length : end)
          const bodyEnd = i
          i = end < 0 ? command.length : end + 1
          if ((dash ? text.replace(/^\t+/, '') : text) === tag || end < 0) {
            const body = command.slice(start, end < 0 ? i : bodyEnd)
            if (feedsShell) code += `${body}\n`
            else if (expands) textBodies.push(body)
            break
          }
        }
      }
      pending = []
    } else if (c === '(') {
      depth++
      code += c
      i++
    } else if (c === ')') {
      if (depth === 0 && frames.length > 0) ({ quote, depth } = frames.pop())
      else depth = Math.max(0, depth - 1)
      code += c
      i++
    } else {
      const heredoc =
        c === '<' && command[i - 1] !== '<'
          ? /^<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([\w.-]+))/.exec(command.slice(i, i + 300))
          : null
      if (heredoc !== null) {
        pending.push({
          dash: heredoc[1] === '-',
          tag: heredoc[2] ?? heredoc[3] ?? heredoc[5],
          expands: heredoc[5] !== undefined && heredoc[4] === '',
        })
        // The operator goes with its body, or a later read would look for a
        // closing tag that is no longer there and take what follows as text.
        code += ' '
        i += heredoc[0].length
      } else {
        code += c
        i++
      }
    }
  }
  return { code, textBodies }
}

/** Where the `$(…)` opening before `from` closes, past any quoted parenthesis. */
function closingParen(source, from) {
  let depth = 1
  for (let j = from; j < source.length; j++) {
    const c = source[j]
    if (c === '\\') {
      j++
    } else if (c === "'") {
      const end = source.indexOf("'", j + 1)
      if (end < 0) return source.length
      j = end
    } else if (c === '"') {
      for (j++; j < source.length && source[j] !== '"'; j++) if (source[j] === '\\') j++
    } else if (c === '(') {
      depth++
    } else if (c === ')' && --depth === 0) {
      return j
    }
  }
  return source.length
}

/** What each `$(…)` and backtick substitution runs, quoted or not: a send
 *  inside `"$(…)"` is one word to `asTheShellReads` but runs all the same.
 *  `plain` is a heredoc's text, where quotes are only characters. */
function substitutionBodies(source, plain) {
  const bodies = []
  let inDouble = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      i++
    } else if (!plain && c === "'" && !inDouble) {
      const end = source.indexOf("'", i + 1)
      if (end < 0) break
      i = end
    } else if (!plain && c === '"') {
      inDouble = !inDouble
    } else if (c === '$' && source[i + 1] === '(') {
      const end = closingParen(source, i + 2)
      bodies.push(source.slice(i + 2, end))
      i = end
    } else if (c === '`') {
      let end = i + 1
      while (end < source.length && source[end] !== '`') end += source[end] === '\\' ? 2 : 1
      bodies.push(source.slice(i + 1, end).replace(/\\([`\\$])/g, '$1'))
      i = end
    }
  }
  return bodies
}

/** Words that hand their quoted argument to another shell. */
const WRAPPER = /(^|[\s|;&(])(?:eval|(?:\S*\/)?(?:ba|z|da)?sh(?:\s+[-+]\S+(?:\s+pipefail)?)*?\s+-\w*c)\b/g

/**
 * Why to ask about this command line, or `null`: does it invoke a `holi google`
 * verb that reaches someone, or leave one to a variable?
 *
 * Matched on the *invocation*, not on the presence of a word or a `$`: `grep
 * send notes.md` is not a send, `holi pdf render "$f"` and `$GH api …/holi/…`
 * cannot be one, and a gate that prompts on those teaches the user to click
 * through prompts. Every invocation in the line is checked, on the line as a
 * shell reads it, so quoting, escaping or a line continuation changes nothing.
 */
function reasonToAsk(command, shown = command, outer = null) {
  const { code, textBodies } = codeOf(command)
  const words = asTheShellReads(code)
  // A substitution sees the variables of the line around it.
  const own = heldInVariables(withSubstitutionsAsWords(words))
  const held = outer === null ? own : {
    group: own.group || outer.group,
    verb: own.verb || outer.verb,
    google: own.google || outer.google,
  }
  const direct = reasonInWords(words, shown, held)
  if (direct !== null) return direct
  const inner = [
    ...substitutionBodies(code, false),
    ...textBodies.flatMap((body) => substitutionBodies(body, true)),
  ]
  for (const body of inner) {
    const reason = reasonToAsk(body, shown, held)
    if (reason !== null) return reason
  }
  if (words.search(WRAPPER) < 0) return null
  // What eval or sh -c runs is one quoted word here. Read it as the shell it
  // is handed to will: its own commands, its own quotes.
  const unwrapped = words
    .replace(/\uE100(\d+)\uE101/g, (_, code) => String.fromCharCode(Number(code)))
    .replaceAll('\uE000', ' ')
    .replace(WRAPPER, '$1\n')
  return reasonToAsk(unwrapped, shown, held)
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
