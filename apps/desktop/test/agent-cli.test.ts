/**
 * `holi`, for real: the generated script run against a live ops server.
 *
 * Generated shell is the one thing in this codebase no other test would cover —
 * a quoting bug in it does not fail loudly, it sends a different argument.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOLI_CLI_SCRIPT, installHoliCli } from '../src/main/agent/cli'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import { createAgentOps, type AgentOpsDeps } from '../src/main/agent/ops'

const execFileAsync = promisify(execFile)

async function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** What the script reads on stdin. Always passed, even empty: a pipe nobody
   *  closes is a script that never returns. */
  input = '',
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync(bin, args, { env })
    child.child.stdin?.end(input)
    const { stdout, stderr } = await child
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

let dir: string
let bin: string
let server: HookServer
let env: NodeJS.ProcessEnv
let deps: AgentOpsDeps

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-'))
  bin = await installHoliCli(dir)
  deps = {
    openApp: vi.fn((id: string) => Promise.resolve({ ok: true as const, id } as { ok: true })),
    initApp: vi.fn((id: string) => Promise.resolve({ ok: true as const, created: [id] })),
    pdfComments: vi.fn((path: string) =>
      Promise.resolve(
        path === 'gone.pdf'
          ? { ok: false as const, error: 'gone.pdf not found' }
          : {
              ok: true as const,
              path,
              threads:
                path === 'empty.pdf'
                  ? []
                  : [
                      {
                        id: 'n1',
                        page: 1,
                        kind: 'note' as const,
                        markedText: null,
                        author: 'Bo Lind',
                        created: null,
                        modified: null,
                        text: 'Is this standard?',
                        replies: [],
                      },
                    ],
            },
      ),
    ),
    updateSkills: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        report: {} as never,
        summary: 'Skills: 1 updated.',
      }),
    ),
  }
  server = createHookServer({
    onJobTurn: () => {},
    log: () => {},
    // One vault in these; the server routes by the caller's token (D87).
    opsFor: () => createAgentOps(deps),
  })
  await server.start()
  env = {
    PATH: process.env.PATH ?? '',
    HOLI_HOOK_PORT: String(server.port()),
    HOLI_HOOK_TOKEN: server.tokenForVault('owner/repo'),
  }
})

afterEach(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe('the installed script', () => {
  it('is executable', async () => {
    expect((await stat(bin)).mode & 0o777).toBe(0o755)
  })

  it('re-reads the port and token from the environment at every invocation', () => {
    // The port is ephemeral and moves across restarts, so baking either in
    // would make the CLI work exactly until the app was restarted once.
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_PORT')
    expect(HOLI_CLI_SCRIPT).toContain('$HOLI_HOOK_TOKEN')
  })
})

describe('when Holi is not running', () => {
  it('exits non-zero with a sentence a human can read', async () => {
    const res = await run(bin, ['app', 'open', 'retro'], { PATH: env.PATH })
    expect(res.code).not.toBe(0)
    expect(res.stderr).toMatch(/holi: Holi is not running/)
  })
})

describe('usage', () => {
  it('names every subcommand when called with none', async () => {
    const res = await run(bin, [], env)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('app open')
    expect(res.stderr).toContain('app init')
    expect(res.stderr).toContain('skills update')
    expect(res.stderr).toContain('pdf comments')
  })

  it('refuses an unknown subcommand rather than doing something adjacent', async () => {
    const res = await run(bin, ['app', 'delete', 'retro'], env)
    expect(res.code).not.toBe(0)
    expect(await (deps.openApp as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })
})

describe('app open', () => {
  it('reaches the ops route and prints the answer', async () => {
    const res = await run(bin, ['app', 'open', 'Finance/Budget.app'], env)
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true })
    expect(deps.openApp).toHaveBeenCalledWith('Finance/Budget.app')
  })

  it('passes a path through verbatim, spaces and all', async () => {
    // The CLI must not be the thing that mangles it, or the refusal names an
    // argument the user never typed.
    await run(bin, ['app', 'open', 'My Apps/my app'], env)
    expect(deps.openApp).toHaveBeenCalledWith('My Apps/my app')
  })

  it('needs a path', async () => {
    const res = await run(bin, ['app', 'open'], env)
    expect(res.code).not.toBe(0)
  })
})

describe('pdf comments', () => {
  it('prints the comments and exits 0', async () => {
    const res = await run(bin, ['pdf', 'comments', 'docs/msa.pdf'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe(
      '[From docs/msa.pdf, 1 comment]\n\nPage 1, note\n  Bo Lind\n  > Is this standard?\n',
    )
    expect(res.stderr).toBe('')
  })

  it('prints JSON with --json, before or after the path', async () => {
    for (const args of [
      ['--json', 'a.pdf'],
      ['a.pdf', '--json'],
    ]) {
      const res = await run(bin, ['pdf', 'comments', ...args], env)
      expect(res.code).toBe(0)
      expect(JSON.parse(res.stdout)).toMatchObject({ path: 'a.pdf', threads: [{ id: 'n1' }] })
    }
  })

  it('passes a path with a space through intact', async () => {
    await run(bin, ['pdf', 'comments', 'client docs/a b.pdf'], env)
    expect(deps.pdfComments).toHaveBeenCalledWith('client docs/a b.pdf')
  })

  it('says there are none and still exits 0', async () => {
    const res = await run(bin, ['pdf', 'comments', 'empty.pdf'], env)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('No comments in empty.pdf.\n')
  })

  it('puts a refusal on stderr and exits non-zero', async () => {
    const res = await run(bin, ['pdf', 'comments', 'gone.pdf'], env)
    expect(res.code).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('holi pdf comments: gone.pdf not found\n')
  })

  it('needs a path, and refuses an unknown option', async () => {
    expect((await run(bin, ['pdf', 'comments'], env)).code).toBe(2)
    expect((await run(bin, ['pdf', 'comments', '--all', 'a.pdf'], env)).code).toBe(2)
    expect(deps.pdfComments).not.toHaveBeenCalled()
  })
})

describe('app init', () => {
  it('reaches the ops route', async () => {
    const res = await run(bin, ['app', 'init', 'retro-board'], env)
    expect(res.code).toBe(0)
    expect(deps.initApp).toHaveBeenCalledWith('retro-board')
  })
})

describe('skills update', () => {
  it('prints the summary Holi answers', async () => {
    const res = await run(bin, ['skills', 'update'], env)
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('Skills: 1 updated.')
    expect(deps.updateSkills).toHaveBeenCalled()
  })

  it('fails with the reason when Holi refuses', async () => {
    ;(deps.updateSkills as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      message: 'No vault is open.',
    })
    const res = await run(bin, ['skills', 'update'], env)
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('No vault is open.')
  })
})
