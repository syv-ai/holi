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

// Not a shell command at all — nothing here can send anything.
if (payload.tool_name !== 'Bash') defer()

const command = payload.tool_input?.command
if (typeof command !== 'string') {
  ask('Holi could not read this command, so it is asking rather than assuming it is safe.')
}

if (isSend(command)) {
  ask(
    'This sends mail from your account to someone else. It cannot be recalled, ' +
      'so Holi asks every time — even if you have allowed this command before.',
  )
}

defer()
