/**
 * The send gate — run as a real child process, over real stdin.
 *
 * This is the one piece of the design that has no second layer behind it. If it
 * has no opinion on something it should have caught, mail leaves the building
 * with no prompt; if it crashes, the same. So the cases here are chosen for the
 * two ways a gate fails **open**: something it should match that it does not,
 * and an input it did not expect.
 *
 * `ask` is the decision, not `deny`, and that is the point — `ask` overrides
 * `permissions.allow` and a prior "don't ask again", which no permission rule
 * does. The user still decides; they just always get to.
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { googleSeed } from '../main/seed'

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../main/vault/shipped/.claude/hooks/google-send-gate.mjs',
)

interface Decision {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
}

/** Feed the hook a PreToolUse payload and read its decision. */
const maintainedSettings = googleSeed.fragments?.['.claude/settings.json'] as
  { hooks?: { command?: string }[] }[] | undefined
const maintainedCommand = maintainedSettings![0]!.hooks![0]!.command!
const maintainedMatch = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/.exec(maintainedCommand)!
const maintainedSource = Buffer.from(maintainedMatch[1]!, 'base64')
  .toString('utf8')
  .replace("const raw = process.env.HOLI_HOOK_STDIN ?? ''", 'const raw = await readStdin()')

async function decide(payload: unknown, maintained = false): Promise<Decision & { code: number }> {
  return new Promise((resolve, reject) => {
    const child = maintained
      ? spawn(process.execPath, ['-e', maintainedSource])
      : spawn(process.execPath, [GATE])
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      let parsed: Decision = {}
      try {
        parsed = JSON.parse(stdout) as Decision
      } catch {
        // left empty — a hook that prints nothing parseable is itself a finding
      }
      resolve({ ...parsed, code: code ?? 0 })
    })
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  })
}

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
})

/** The hook's decision, or `none` when it printed nothing: no opinion, so the
 *  normal permission flow decides. */
const decisionOf = (d: Decision) => d.hookSpecificOutput?.permissionDecision ?? 'none'

describe('both maintained and shipped gates cover shell spellings', () => {
  const commands = [
    '"/Users/Ada/Library/Application Support/Holi/bin/holi" google respond e2 --yes',
    '"$HOLI_BIN" google \\\nrespond e2 --yes',
    'holi google re\\spond e2 --yes',
    'command "$HOLI_BIN" google api POST gmail/v1/users/me/messages/send --body -',
    '("$HOLI_BIN" google respond e2 --yes)',
    '("$HOLI_BIN" google api POST gmail/v1/users/me/messages/send --body -)',
  ]

  it.each(commands)('asks for %s in either hook', async (command) => {
    expect(decisionOf(await decide(bash(command)))).toBe('ask')
    expect(decisionOf(await decide(bash(command), true))).toBe('ask')
  })

  it.each([
    `holi google send --attach 'Board; deck.pptx' --to a@b.c`,
    `holi google send --attach $'Board deck.pptx' --to a@b.c`,
    `holi google send --attach "Board; deck.pptx" --to a@b.c`,
    `holi google send --attach Board\\;\\ deck.pptx --to a@b.c`,
    `holi google $'respond' e1 --yes`,
    `holi google $'api' POST gmail/v1/users/me/messages/send --body '{}'`,
    'if true; then holi google send --attach q2.pdf --to a@b.c; fi',
    'if true; then "$HOLI_BIN" google respond e1 --yes; fi',
    'for x in once; do "$HOLI_BIN" google respond e1 --yes; done',
    'for x in once; do holi google respond e1 --yes; done',
    'if true; then holi google api POST gmail/v1/users/me/messages/send --body "{}"; fi',
    'eval "holi google send --to a@b.c"',
    'cmd=holi; $cmd google send --to a@b.c',
  ])('asks for risky syntax: %s', async (command) => {
    expect(decisionOf(await decide(bash(command)))).toBe('ask')
    expect(decisionOf(await decide(bash(command), true))).toBe('ask')
  })

  it.each([
    'holi google agenda today',
    'holi google api GET calendar/v3/calendars/primary/events',
    'holi google search x | grep send',
    'echo holi google respond e2 --yes',
  ])('does not ask for a safe/non-invocation command: %s', async (command) => {
    expect(decisionOf(await decide(bash(command)))).toBe('none')
    expect(decisionOf(await decide(bash(command), true))).toBe('none')
  })
})

describe('the send gate asks', () => {
  it('reports shell-decoded attachment names, independently checked by Bash', async () => {
    const commands = [
      `holi google send --to a@b.c --attach "Board; deck.pptx"`,
      `holi google send --to a@b.c --attach Board\\;\\ deck.pptx`,
      `holi google send --to a@b.c --attach $'line\\tbreak\\nname'`,
      `holi google send --to a@b.c --attach 'marker\uE000\uE100\uE101'`,
    ]
    for (const command of commands) {
      const shellArgument = command.match(/--attach\s+(.+?)(?:\s+--to|$)/)?.[1]
      expect(shellArgument).toBeDefined()
      const oracle = spawnSync('bash', ['-c', `eval "set -- ${shellArgument}"; printf %s "$1"`], {
        encoding: 'utf8',
      })
      const reason =
        (await decide(bash(command))).hookSpecificOutput?.permissionDecisionReason ?? ''
      expect(oracle.status).toBe(0)
      expect(reason).toContain(oracle.stdout)
    }
  })
  it('asks for a bare-name send', async () => {
    expect(decisionOf(await decide(bash('holi google send --to ada@syv.ai --subject x')))).toBe(
      'ask',
    )
  })

  it('asks for a reply', async () => {
    expect(decisionOf(await decide(bash('holi google reply t1')))).toBe('ask')
  })

  // The agent's env names the script as `$HOLI_BIN`. Missing this spelling is
  // how the gate would be believed in while never firing.
  it('asks for the $HOLI_BIN spelling', async () => {
    expect(decisionOf(await decide(bash('"$HOLI_BIN" google send --to ada@syv.ai')))).toBe('ask')
    expect(decisionOf(await decide(bash('$HOLI_BIN google reply t1')))).toBe('ask')
    expect(decisionOf(await decide(bash('${HOLI_BIN} google reply t1')))).toBe('ask')
  })

  it('asks when the words are quoted', async () => {
    expect(decisionOf(await decide(bash('holi "google" "send" --to ada@syv.ai')))).toBe('ask')
    expect(decisionOf(await decide(bash("holi 'google' reply t1")))).toBe('ask')
  })

  it('asks for an absolute path to the generated script', async () => {
    expect(
      decisionOf(
        await decide(
          bash('/Users/x/Library/Application Support/Holi/bin/holi google send --to a@b.c'),
        ),
      ),
    ).toBe('ask')
    expect(
      decisionOf(
        await decide(bash('"/Users/x/Library/Application Support/Holi/bin/holi" google reply t1')),
      ),
    ).toBe('ask')
  })

  it('asks when the send is buried in a pipeline or a chain', async () => {
    expect(decisionOf(await decide(bash('cat body.txt | holi google send --to ada@syv.ai')))).toBe(
      'ask',
    )
    expect(decisionOf(await decide(bash('cd /tmp && holi google send --to ada@syv.ai')))).toBe(
      'ask',
    )
  })

  /**
   * The prompt is the whole consent surface, and consent to send needs to know
   * *to whom*. The body is on stdin and cannot be shown — but the recipients
   * usually can be, and a prompt that says only "this sends mail" asks the user
   * to approve something they cannot see.
   */
  it('names the recipients in the reason, so the prompt is not blind', async () => {
    const reason = (await decide(bash('holi google send --to ada@syv.ai --subject x')))
      .hookSpecificOutput?.permissionDecisionReason

    expect(reason).toContain('ada@syv.ai')
  })

  it('names every recipient, including cc', async () => {
    const reason = (
      await decide(bash('holi google send --to ada@syv.ai --cc bo@syv.ai --subject x'))
    ).hookSpecificOutput?.permissionDecisionReason

    expect(reason).toContain('ada@syv.ai')
    expect(reason).toContain('bo@syv.ai')
  })

  // A reply's recipients are derived from the thread, so they are NOT in the
  // command. Saying so is the honest answer; implying the prompt showed them
  // would be worse than saying nothing.
  it('says plainly that a reply’s recipients are not visible in the command', async () => {
    const reason = (await decide(bash('holi google reply t1'))).hookSpecificOutput
      ?.permissionDecisionReason

    expect(reason).toMatch(/thread/i)
    expect(reason).toMatch(/sender/i)
  })

  // Files leave the machine too, and unlike the body they are on the command
  // line, so the person sees which ones before they go.
  it('names every attached file, on a send and on a reply', async () => {
    const send = (
      await decide(
        bash(`holi google send --to ada@syv.ai --attach q2.pdf --attach "Board deck.pptx"`),
      )
    ).hookSpecificOutput?.permissionDecisionReason
    const reply = (await decide(bash('holi google reply t1 --attach=notes/plan.md')))
      .hookSpecificOutput?.permissionDecisionReason
    const concatenated = 'holi google send --attach "Board"" deck.pptx" --attach "Møde résumé.pdf"'

    expect(send).toContain('q2.pdf')
    expect(send).toContain('Board deck.pptx')
    expect(reply).toContain('notes/plan.md')
    for (const maintained of [false, true]) {
      const reason = (await decide(bash(concatenated), maintained)).hookSpecificOutput
        ?.permissionDecisionReason
      expect(reason).toContain('Board deck.pptx')
      expect(reason).toContain('Møde résumé.pdf')
    }

    // An escaped space is one name; a body that mentions `--attach` is no file.
    const odd = (
      await decide(
        bash(
          "holi google send --to ada@syv.ai --attach Board\\ deck.pptx <<'EOF'\nuse --attach x\nEOF",
        ),
      )
    ).hookSpecificOutput?.permissionDecisionReason
    expect(odd).toContain('It attaches: Board deck.pptx.')
  })

  it('warns that reply --all widens the audience', async () => {
    const reason = (await decide(bash('holi google reply t1 --all'))).hookSpecificOutput
      ?.permissionDecisionReason

    expect(reason).toMatch(/everyone|all/i)
  })

  // Google tells the organizer, so an answer to an invite reaches a person.
  it('asks for answering an invitation', async () => {
    expect(decisionOf(await decide(bash('holi google respond ev-1 --no --comment x')))).toBe('ask')
    expect(decisionOf(await decide(bash('"$HOLI_BIN" google "respond" ev-1 --yes')))).toBe('ask')
  })

  // The body is on stdin, out of the hook's sight, so the method decides:
  // every raw call that is not a GET asks, however its method is spelled.
  it('does not let a following command replace the current invocation argument', async () => {
    for (const command of [
      `"$HOLI_BIN" google agenda\n"$HOLI_BIN" google respond e1 --yes`,
      `"$HOLI_BIN" google agenda\n"$HOLI_BIN" google api POST calendar/v3/freeBusy --body -`,
      `"$HOLI_BIN" google agenda\n"$HOLI_BIN" google send --to a@b.c`,
    ]) {
      expect(decisionOf(await decide(bash(command))), command).toBe('ask')
    }
  })

  it('asks for every raw api call that is not a GET', async () => {
    for (const command of [
      'holi google api POST gmail/v1/users/me/messages/send --body -',
      'holi google api patch calendar/v3/calendars/primary/events/e1 --body -',
      "holi google api 'DELETE' calendar/v3/calendars/primary/events/e1",
      'holi google api "$M" gmail/v1/users/me/labels',
      'holi google api --method GET gmail/v1/users/me/labels',
      'holi google api GET gmail/v1/users/me/labels && holi google api PUT x',
    ]) {
      expect(decisionOf(await decide(bash(command))), command).toBe('ask')
    }
  })

  // A shell joins these into the plain words before it runs them, so the gate
  // must read them the same way, for every verb.
  it('asks when a word is partly quoted, escaped or split across lines', async () => {
    for (const command of [
      'holi google a""pi POST gmail/v1/users/me/messages/send --body -',
      'holi google s\\end --to a@b.c',
      "holi google $'respond' e1 --yes",
      'holi \\\ngoogle api POST gmail/v1/users/me/messages/send',
      "holi google re'ply' t1",
      'holi google api P""OST gmail/v1/users/me/drafts/send',
    ]) {
      expect(decisionOf(await decide(bash(command))), command).toBe('ask')
    }
  })

  it('still names the recipients of an escaped send', async () => {
    const reason = (await decide(bash('holi google s\\end --to "ada@syv.ai"'))).hookSpecificOutput
      ?.permissionDecisionReason
    expect(reason).toContain('ada@syv.ai')
  })

  it('still says it cannot be recalled, and that allowing it before does not skip this', async () => {
    const reason = (await decide(bash('holi google send --to ada@syv.ai'))).hookSpecificOutput
      ?.permissionDecisionReason

    expect(reason).toMatch(/recall|undo|cannot be/i)
  })
})

describe('the send gate has no opinion', () => {
  // No output is no opinion, and the normal permission flow decides. Not
  // `defer`, which Claude Code reads as "pause for someone outside".
  // Returning `allow` here would silently widen every other command the agent runs.
  it('passes on the undoable writes', async () => {
    for (const command of [
      'holi google archive t1',
      'holi google trash t1',
      'holi google draft --to ada@syv.ai --subject x',
      'holi google mark-read t1',
      'holi google unschedule ev-1',
    ]) {
      expect(decisionOf(await decide(bash(command)))).toBe('none')
    }
  })

  it('passes on the reads', async () => {
    expect(decisionOf(await decide(bash("holi google search 'is:unread'")))).toBe('none')
    expect(decisionOf(await decide(bash('holi google agenda')))).toBe('none')
    expect(decisionOf(await decide(bash('holi google api GET gmail/v1/users/me/labels')))).toBe(
      'none',
    )
    expect(decisionOf(await decide(bash("holi google api 'get' calendar/v3/colors")))).toBe('none')
  })

  it('passes on an unrelated command that merely contains the word send', async () => {
    // The obvious substring match. `grep send notes.md` is not a send, and a
    // gate that prompts on it teaches the user to click through prompts.
    expect(decisionOf(await decide(bash('grep send notes.md')))).toBe('none')
    expect(decisionOf(await decide(bash('git send-email --help')))).toBe('none')
    expect(decisionOf(await decide(bash('echo "I will send this later"')))).toBe('none')
  })

  it('passes on a non-Bash tool', async () => {
    expect(
      decisionOf(
        await decide({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/holi google send' },
        }),
      ),
    ).toBe('none')
  })
})

describe('the send gate fails closed', () => {
  // A gate that crashes into no opinion is a gate that opens. Every unexpected
  // input has to land on `ask`, because the cost of a needless prompt is a
  // click and the cost of a missed one is an email.
  it('asks when stdin is not JSON', async () => {
    expect(decisionOf(await decide('this is not json'))).toBe('ask')
  })

  it('asks when stdin is empty', async () => {
    expect(decisionOf(await decide(''))).toBe('ask')
  })

  it('asks when the payload has an unexpected shape', async () => {
    expect(decisionOf(await decide({ tool_name: 'Bash' }))).toBe('ask')
    expect(decisionOf(await decide({ tool_name: 'Bash', tool_input: 'not-an-object' }))).toBe('ask')
    expect(decisionOf(await decide([1, 2, 3]))).toBe('ask')
  })

  it('always exits 0 — a non-zero exit is a hook error, not a decision', async () => {
    expect((await decide(bash('holi google send --to a@b.c'))).code).toBe(0)
    expect((await decide('garbage')).code).toBe(0)
  })
})

/**
 * `send --draft` (2026-08-14).
 *
 * A draft send still reaches a human, so it must still ask — and the prompt has
 * to be honest about what it can and cannot show. The recipients live in the
 * draft, not in the command, and claiming otherwise is worse than saying so.
 */
describe('sending an existing draft', () => {
  const reasonOf = (d: Decision) => d.hookSpecificOutput?.permissionDecisionReason ?? ''

  it('asks, exactly as a composed send does', async () => {
    expect(decisionOf(await decide(bash('holi google send --draft d-1')))).toBe('ask')
  })

  it('says the recipients are in the draft rather than pretending to show them', async () => {
    const reason = reasonOf(await decide(bash('holi google send --draft d-1')))

    expect(reason).toMatch(/draft/i)
    expect(reason).toMatch(/not in this command|in the draft rather than/i)
  })

  it('does not claim it could not read the recipients', async () => {
    // The generic fallback would be a lie here: nothing failed to parse, there
    // is simply nothing to parse. Telling the user to "check the command" sends
    // them to look at something that does not contain the answer.
    const reason = reasonOf(await decide(bash('holi google send --draft d-1')))

    expect(reason).not.toMatch(/could not read the recipients/i)
  })

  it('still asks through $HOLI_BIN', async () => {
    expect(decisionOf(await decide(bash('"$HOLI_BIN" google send --draft d-1')))).toBe('ask')
  })

  it('does not fire on a draft subcommand, which reaches nobody', async () => {
    expect(decisionOf(await decide(bash('holi google draft --to ada@syv.ai --subject x')))).toBe(
      'none',
    )
  })
})

/**
 * Gmail's MCP connectors (2026-08-14).
 *
 * The agent used one in preference to `holi google`, and every such call sailed
 * past this gate — an MCP tool call is not a shell command, so a `Bash` matcher
 * never saw it. `disableClaudeAiConnectors` is the real fix; this is the
 * fallback for a vault whose settings regress.
 */
describe('the claude.ai Gmail connector', () => {
  const mcp = (name: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: { to: ['ada@syv.ai'] },
  })

  it('asks before a connector send', async () => {
    expect(decisionOf(await decide(mcp('mcp__claude_ai_Gmail__send_message')))).toBe('ask')
  })

  it('asks before a connector reply and a forward', async () => {
    expect(decisionOf(await decide(mcp('mcp__claude_ai_Gmail__reply')))).toBe('ask')
    expect(decisionOf(await decide(mcp('mcp__claude_ai_Gmail__forward')))).toBe('ask')
  })

  it('says the mail bypasses Holi, because that is the part the user cannot see', async () => {
    const d = await decide(mcp('mcp__claude_ai_Gmail__send_message'))

    expect(d.hookSpecificOutput?.permissionDecisionReason ?? '').toMatch(
      /connector|rather than through Holi/i,
    )
  })

  it('has no opinion on a connector draft, which reaches nobody', async () => {
    // This gates what cannot be undone, not what it dislikes.
    expect(decisionOf(await decide(mcp('mcp__claude_ai_Gmail__create_draft')))).toBe('none')
  })

  it('has no opinion on reading mail through a connector', async () => {
    expect(decisionOf(await decide(mcp('mcp__claude_ai_Gmail__search_threads')))).toBe('none')
  })

  it('ignores an unrelated MCP server entirely', async () => {
    expect(decisionOf(await decide(mcp('mcp__azure_devops__create_pr')))).toBe('none')
  })

  /**
   * The point of a fallback is the case nobody enumerated.
   *
   * Keying on the server being called `Gmail` and the tool *starting* with
   * `send` describes one connector that exists today. A Workspace connector
   * (`send_email`) or a resource-first name (`messages_send`) is the same act
   * under a name this rule never learned, and the cost of missing one is a mail
   * that reached a person unasked — against one extra prompt for a false match.
   */
  it('asks for a send however the connector spells it', async () => {
    for (const name of [
      'mcp__google_workspace__send_email',
      'mcp__gmail__messages_send',
      'mcp__my_mail_tools__forward_message',
      'mcp__email_relay__reply_all',
    ]) {
      expect(decisionOf(await decide(mcp(name))), name).toBe('ask')
    }
  })

  it('still ignores a send that has nothing to do with mail', async () => {
    // The prompt this gate raises is about mail reaching a person. Asking it of
    // a chat message would be a confusing lie, not a cautious win.
    for (const name of ['mcp__slack__send_message', 'mcp__azure_devops__resend_webhook']) {
      expect(decisionOf(await decide(mcp(name))), name).toBe('none')
    }
  })
})
