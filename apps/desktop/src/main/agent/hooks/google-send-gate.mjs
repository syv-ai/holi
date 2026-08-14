#!/usr/bin/env node
// Holi PreToolUse hook — the send gate (D70).
//
// Sending mail and replying are the two things the agent can do that reach
// another human and cannot be undone. Everything else it can do to a mailbox or
// a calendar, the user can put back with one click.
//
// So this returns `ask` for those two, and `defer` for everything else. `ask` is
// the mechanism the whole design was chosen for: it overrides `permissions.allow`
// AND a prior "don't ask again", which no permission rule does. The user still
// decides — they just always get to. `defer` removes this hook's opinion and
// restores the normal permission flow; returning `allow` instead would silently
// widen every other command the agent runs.
//
// **It fails closed.** Unparseable input, an unexpected shape, any internal
// error — all `ask`. A gate that crashes into `defer` is a gate that opens, and
// the cost of a needless prompt is a click while the cost of a missed one is an
// email that has already gone.
//
// **The honest limit** (recorded in D70): this gates a *cooperative* agent, not
// an adversarial one. No string match survives `eval`, a variable, or `sh -c`.
// The claim it supports is "the agent never sends without you seeing it", not
// "the agent cannot send".

/** The two subcommands that reach another person. */
const REACHES_A_HUMAN = ['send', 'reply']

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
const defer = () => decide('defer', 'not a Holi send')

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
 * Does this command line invoke `holi-google send` or `holi-google reply`?
 *
 * Matched on the *invocation*, not on the presence of the word: `grep send
 * notes.md` is not a send, and a gate that prompts on it teaches the user to
 * click through prompts — which is how a real one gets approved by reflex.
 *
 * Three spellings are live, and all three must match. The bare name (what the
 * skill now teaches, resolved via PATH), `$HOLI_GOOGLE_BIN` (what it used
 * before D70, still exported and still working), and an absolute path to the
 * generated script. Missing any one of them is how a gate gets believed in
 * while never firing — see D67 §5, whose rule matched none of them.
 */
/**
 * Who this command reaches, as far as the command itself can say.
 *
 * The prompt is the entire consent surface, and consenting to a send means
 * knowing *to whom*. The body is on stdin and genuinely cannot be shown here —
 * but the recipients usually can be, and "this sends mail" alone asks the user
 * to approve something they cannot see.
 *
 * A `reply` is the honest exception: its recipients are derived from the thread
 * inside Holi, so they are nowhere in the command. Saying so plainly is better
 * than a reassuring sentence that implies the prompt showed them.
 */
function audienceOf(command) {
  // `send --draft <id>` is the second honest exception. The draft carries its
  // own recipients inside Gmail, so like a reply they are nowhere in the
  // command — and unlike a reply, the user can go and look at the draft.
  if (/--draft\b/.test(command)) {
    return (
      'It sends a draft that already exists in Gmail. The recipients are in the ' +
      'draft rather than in this command, so open it in Drafts if you want to check them.'
    )
  }
  if (/\breply\b/.test(command)) {
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

function isSend(command) {
  // The command word, however it was spelled, followed by the subcommand.
  // `[^|;&]*` keeps the two adjacent within one pipeline stage, so
  // `holi-google search x | grep send` does not match.
  const invocation = new RegExp(
    String.raw`(^|[|;&]|\s)` + // start of a command
      String.raw`(?:["']?\$\{?HOLI_GOOGLE_BIN\}?["']?|[^\s|;&]*\bholi-google)` + // the binary
      String.raw`\s+(?:${REACHES_A_HUMAN.join('|')})\b`, // the subcommand
  )
  return invocation.test(command)
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
 * A claude.ai Gmail **connector** call (2026-08-14).
 *
 * The agent reached for one of these in preference to `holi-google`, and every
 * such call used to sail straight past this gate — an MCP tool call is not a
 * shell command, so the `Bash` matcher never saw it. `disableClaudeAiConnectors`
 * in the seeded settings is the real fix; this is the fallback for a vault whose
 * settings regress or whose user turns the connector back on deliberately.
 *
 * Matched on the tool *name*, which the harness supplies — there is no command
 * string to parse and nothing to spell three ways.
 */
const MCP_SENDS = /^mcp__.*[Gg]mail.*__(send|reply|forward)/

if (typeof payload.tool_name === 'string' && payload.tool_name.startsWith('mcp__')) {
  if (MCP_SENDS.test(payload.tool_name)) {
    ask(
      'This sends mail through a claude.ai Gmail connector rather than through Holi. ' +
        'Holi cannot see the recipients or the message, and none of its own protections ' +
        'apply — the mail is sent with a separate connection to Google. ' +
        'It cannot be recalled, so Holi asks every time.',
    )
  }
  // A read or a draft through the connector reaches nobody, so this hook has no
  // opinion — it gates what cannot be undone, not what it dislikes.
  defer()
}

// Not a shell command at all — nothing here can send anything.
if (payload.tool_name !== 'Bash') defer()

const command = payload.tool_input?.command
if (typeof command !== 'string') {
  ask('Holi could not read this command, so it is asking rather than assuming it is safe.')
}

if (isSend(command)) {
  ask(
    `This sends mail from your account. ${audienceOf(command)} ` +
      'It cannot be recalled, so Holi asks every time — even if you have allowed ' +
      'this command before. The message text is on stdin and is not shown here.',
  )
}

defer()
