/**
 * The quick agent's hooks, end to end: the inline shells Claude Code runs
 * (`ASK_HOOK`, `RESULT_HOOK`), the bridge they post to, and the desk that holds
 * a question until it is answered. The shell's quoting and every way of not
 * answering are what this pins: each must print nothing.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBridgeServer, type BridgeServer } from '../../../main/bridge/server'
import { createClaudeCli } from '../main/claude/cli'
import {
  ASK_HOOK,
  QUICK_FLAGS,
  QUICK_SETTINGS,
  QUICK_SYSTEM_PROMPT,
  RESULT_HOOK,
} from '../main/claude/quick'
import { registerAgentRoutes } from '../main/claude/routes'
import { createQuestionDesk, type QuestionDesk } from '../main/host/questions'

const VAULT = 'syv/vault'
const JOB = 'abcd1234'

const TOOL_INPUT = {
  questions: [
    {
      question: "Which one's it?",
      header: 'Pick',
      multiSelect: false,
      options: [{ label: 'A "quoted" one (Recommended)' }, { label: 'B' }],
    },
  ],
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function rig(opts: { take?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'holi-quick-hook-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.holi/state'), { recursive: true })
  await writeFile(join(root, '.holi/vault'), '')
  const desk: QuestionDesk = createQuestionDesk({ onChange: () => {} })
  const results: Array<{ remote: string; job: string; message: string }> = []
  const server: BridgeServer = createBridgeServer({ log: () => {} })
  registerAgentRoutes(server, {
    onJobTurn: () => {},
    onAsk: (_remote, job, input, signal) =>
      opts.take === false ? Promise.resolve(null) : desk.ask(job, input, signal),
    onQuickResult: (remote, job, message) => void results.push({ remote, job, message }),
    log: () => {},
  })
  await server.start()
  cleanups.push(() => server.stop())
  const token = server.tokenForVault(VAULT)
  await writeFile(
    join(root, '.holi/state/bridge.local.env'),
    `HOLI_BRIDGE_PORT=${server.port()}\nHOLI_BRIDGE_TOKEN=${token}\n`,
  )
  return { root, desk, results }
}

/** Run the result hook as Claude Code would as a turn ends. */
function runResultHook(
  cwd: string,
  env: Record<string, string | undefined>,
  message: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn('sh', ['-c', RESULT_HOOK], { cwd, env: { PATH: process.env.PATH, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => (stdout += c))
  child.stderr.on('data', (c) => (stderr += c))
  child.stdin.end(
    JSON.stringify({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: message,
    }),
  )
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
}

/** Run the hook as Claude Code would: `sh -c`, the tool call on stdin. */
function runHook(
  cwd: string,
  env: Record<string, string | undefined>,
): { done: Promise<{ code: number | null; stdout: string }>; kill: () => void } {
  const child = spawn('sh', ['-c', ASK_HOOK], { cwd, env: { PATH: process.env.PATH, ...env } })
  let stdout = ''
  child.stdout.on('data', (c) => (stdout += c))
  child.stdin.end(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_9',
      tool_input: TOOL_INPUT,
    }),
  )
  return {
    done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout }))),
    kill: () => child.kill('SIGKILL'),
  }
}

describe('the quick hook', () => {
  it('waits for the answer and prints what Claude Code takes', async () => {
    const { root, desk } = await rig()
    const hook = runHook(root, { CLAUDE_JOB_DIR: `/home/x/.claude/jobs/${JOB}` })
    await vi.waitFor(() => expect(desk.has(JOB)).toBe(true), { timeout: 5_000 })
    expect(desk.answer('toolu_9', { "Which one's it?": 'A "quoted" one (Recommended)' })).toBe(true)
    const { code, stdout } = await hook.done
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...TOOL_INPUT,
          answers: { "Which one's it?": 'A "quoted" one (Recommended)' },
        },
      },
    })
  })

  it('prints nothing for a question Holi is not taking', async () => {
    const { root } = await rig({ take: false })
    const { code, stdout } = await runHook(root, { CLAUDE_JOB_DIR: `/x/jobs/${JOB}` }).done
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('prints nothing outside a background session, or with Holi gone', async () => {
    const { root } = await rig()
    expect((await runHook(root, {}).done).stdout).toBe('')
    await writeFile(
      join(root, '.holi/state/bridge.local.env'),
      'HOLI_BRIDGE_PORT=1\nHOLI_BRIDGE_TOKEN=00\n',
    )
    const gone = await runHook(root, { CLAUDE_JOB_DIR: `/x/jobs/${JOB}` }).done
    // `curl`'s own failure: Claude Code reads any exit but 2 as "carry on".
    expect(gone.stdout).toBe('')
    expect(gone.code).not.toBe(2)
  })

  it('lets the desk go when the hook is killed', async () => {
    const { root, desk } = await rig()
    const hook = runHook(root, { CLAUDE_JOB_DIR: `/x/jobs/${JOB}` })
    await vi.waitFor(() => expect(desk.has(JOB)).toBe(true), { timeout: 5_000 })
    // The shell is the `curl` by now, so ending it ends the request.
    hook.kill()
    await hook.done
    await vi.waitFor(() => expect(desk.has(JOB)).toBe(false), { timeout: 5_000 })
  })
})

describe('the quick launch', () => {
  it('starts a background session with the quick flags, the prompt last after --', async () => {
    const calls: string[][] = []
    const cli = createClaudeCli({
      resolveBin: () => '/c',
      run: async (_bin, args) => {
        calls.push(args)
        return 'backgrounded · 1234abcd · x\n'
      },
      log: () => {},
    })
    const target = { root: '/v', configDir: '/cfg', binDir: null }
    expect(await cli.startQuick(target, { name: 'Tidy', prompt: '- tidy the list' })).toEqual({
      ok: true,
      id: '1234abcd',
    })
    expect(calls[0]).toEqual(['--bg', '--name', 'Tidy', ...QUICK_FLAGS, '--', '- tidy the list'])
  })

  it('hands Holi the last message as the turn ends, printing nothing', async () => {
    const { root, results } = await rig()
    const message = `It's "done": \`$HOME\` and $(id) stay text.\n\n- one\n- two`
    const run = await runResultHook(root, { CLAUDE_JOB_DIR: `/x/jobs/${JOB}` }, message)
    expect(run).toMatchObject({ code: 0, stdout: '', stderr: '' })
    expect(results).toEqual([{ remote: VAULT, job: JOB, message }])
  })

  it('posts nothing outside a background session, and is quiet with Holi gone', async () => {
    const { root, results } = await rig()
    expect(await runResultHook(root, {}, 'hi')).toMatchObject({ code: 0, stdout: '' })
    expect(results).toEqual([])
    await writeFile(
      join(root, '.holi/state/bridge.local.env'),
      'HOLI_BRIDGE_PORT=1\nHOLI_BRIDGE_TOKEN=00\n',
    )
    const gone = await runResultHook(root, { CLAUDE_JOB_DIR: `/x/jobs/${JOB}` }, 'hi')
    expect(gone).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  it('asks for auto mode, the steering, the question hook and the result hook', () => {
    expect(QUICK_FLAGS.slice(0, 2)).toEqual(['--permission-mode', 'auto'])
    expect(QUICK_SYSTEM_PROMPT).toMatch(/AskUserQuestion/)
    const settings = JSON.parse(QUICK_SETTINGS)
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse', 'Stop'])
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion')
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(RESULT_HOOK)
  })
})
