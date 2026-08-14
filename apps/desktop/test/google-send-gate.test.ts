/**
 * The send gate (D70) — run as a real child process, over real stdin.
 *
 * This is the one piece of the design that has no second layer behind it. If it
 * returns `defer` for something it should have caught, mail leaves the building
 * with no prompt; if it crashes, the same. So the cases here are chosen for the
 * two ways a gate fails **open**: something it should match that it does not,
 * and an input it did not expect.
 *
 * `ask` is the decision, not `deny`, and that is the point — `ask` overrides
 * `permissions.allow` and a prior "don't ask again", which no permission rule
 * does. The user still decides; they just always get to.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/main/agent/hooks/google-send-gate.mjs',
)

interface Decision {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
}

/** Feed the hook a PreToolUse payload and read its decision. */
async function decide(payload: unknown): Promise<Decision & { code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE])
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

const decisionOf = (d: Decision) => d.hookSpecificOutput?.permissionDecision

describe('the send gate asks', () => {
  it('asks for a bare-name send', async () => {
    expect(decisionOf(await decide(bash('holi-google send --to ada@syv.ai --subject x')))).toBe(
      'ask',
    )
  })

  it('asks for a reply', async () => {
    expect(decisionOf(await decide(bash('holi-google reply t1')))).toBe('ask')
  })

  // The spelling the skill used before D70, and which still works. Missing this
  // is how the gate would be believed in while never firing.
  it('asks for the $HOLI_GOOGLE_BIN spelling', async () => {
    expect(decisionOf(await decide(bash('"$HOLI_GOOGLE_BIN" send --to ada@syv.ai')))).toBe('ask')
    expect(decisionOf(await decide(bash('$HOLI_GOOGLE_BIN reply t1')))).toBe('ask')
  })

  it('asks for an absolute path to the generated script', async () => {
    expect(
      decisionOf(await decide(bash('/Users/x/Library/Application Support/Holi/bin/holi-google send --to a@b.c'))),
    ).toBe('ask')
  })

  it('asks when the send is buried in a pipeline or a chain', async () => {
    expect(decisionOf(await decide(bash('cat body.txt | holi-google send --to ada@syv.ai')))).toBe(
      'ask',
    )
    expect(decisionOf(await decide(bash('cd /tmp && holi-google send --to ada@syv.ai')))).toBe(
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
    const reason = (await decide(bash('holi-google send --to ada@syv.ai --subject x')))
      .hookSpecificOutput?.permissionDecisionReason

    expect(reason).toContain('ada@syv.ai')
  })

  it('names every recipient, including cc', async () => {
    const reason = (
      await decide(bash('holi-google send --to ada@syv.ai --cc bo@syv.ai --subject x'))
    ).hookSpecificOutput?.permissionDecisionReason

    expect(reason).toContain('ada@syv.ai')
    expect(reason).toContain('bo@syv.ai')
  })

  // A reply's recipients are derived from the thread, so they are NOT in the
  // command. Saying so is the honest answer; implying the prompt showed them
  // would be worse than saying nothing.
  it('says plainly that a reply’s recipients are not visible in the command', async () => {
    const reason = (await decide(bash('holi-google reply t1'))).hookSpecificOutput
      ?.permissionDecisionReason

    expect(reason).toMatch(/thread/i)
    expect(reason).toMatch(/sender/i)
  })

  it('warns that reply --all widens the audience', async () => {
    const reason = (await decide(bash('holi-google reply t1 --all'))).hookSpecificOutput
      ?.permissionDecisionReason

    expect(reason).toMatch(/everyone|all/i)
  })

  it('still says it cannot be recalled, and that allowing it before does not skip this', async () => {
    const reason = (await decide(bash('holi-google send --to ada@syv.ai')))
      .hookSpecificOutput?.permissionDecisionReason

    expect(reason).toMatch(/recall|undo|cannot be/i)
  })
})

describe('the send gate defers', () => {
  // `defer` removes the hook's opinion and restores the normal permission flow.
  // Returning `allow` here would silently widen every other command the agent runs.
  it('defers the undoable writes', async () => {
    for (const command of [
      'holi-google archive t1',
      'holi-google trash t1',
      'holi-google draft --to ada@syv.ai --subject x',
      'holi-google mark-read t1',
      'holi-google unschedule ev-1',
    ]) {
      expect(decisionOf(await decide(bash(command)))).toBe('defer')
    }
  })

  it('defers the reads', async () => {
    expect(decisionOf(await decide(bash("holi-google search 'is:unread'")))).toBe('defer')
    expect(decisionOf(await decide(bash('holi-google agenda')))).toBe('defer')
  })

  it('defers an unrelated command that merely contains the word send', async () => {
    // The obvious substring match. `grep send notes.md` is not a send, and a
    // gate that prompts on it teaches the user to click through prompts.
    expect(decisionOf(await decide(bash('grep send notes.md')))).toBe('defer')
    expect(decisionOf(await decide(bash('git send-email --help')))).toBe('defer')
    expect(decisionOf(await decide(bash('echo "I will send this later"')))).toBe('defer')
  })

  it('defers a non-Bash tool', async () => {
    expect(
      decisionOf(
        await decide({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/holi-google send' },
        }),
      ),
    ).toBe('defer')
  })
})

describe('the send gate fails closed', () => {
  // A gate that crashes into `defer` is a gate that opens. Every unexpected
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
    expect((await decide(bash('holi-google send --to a@b.c'))).code).toBe(0)
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
    expect(decisionOf(await decide(bash('holi-google send --draft d-1')))).toBe('ask')
  })

  it('says the recipients are in the draft rather than pretending to show them', async () => {
    const reason = reasonOf(await decide(bash('holi-google send --draft d-1')))

    expect(reason).toMatch(/draft/i)
    expect(reason).toMatch(/not in this command|in the draft rather than/i)
  })

  it('does not claim it could not read the recipients', async () => {
    // The generic fallback would be a lie here: nothing failed to parse, there
    // is simply nothing to parse. Telling the user to "check the command" sends
    // them to look at something that does not contain the answer.
    const reason = reasonOf(await decide(bash('holi-google send --draft d-1')))

    expect(reason).not.toMatch(/could not read the recipients/i)
  })

  it('still asks through $HOLI_GOOGLE_BIN', async () => {
    expect(decisionOf(await decide(bash('"$HOLI_GOOGLE_BIN" send --draft d-1')))).toBe('ask')
  })

  it('does not fire on a draft subcommand, which reaches nobody', async () => {
    expect(decisionOf(await decide(bash('holi-google draft --to ada@syv.ai --subject x')))).toBe(
      'defer',
    )
  })
})
