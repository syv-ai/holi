import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { installHoliCli } from '../src/main/bridge/cli'
import { createBridgeServer } from '../src/main/bridge/server'
import { resolveBundledWindowsNode } from '../src/main/windows-node-runtime'

const execute = promisify(execFile)
const argumentsToPreserve = [
  'café☃',
  "apostrophe's",
  'embedded "quotes"',
  '',
  'ordinary\\path',
  'trailing\\',
]

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi windows cli-')))
  const node = resolveBundledWindowsNode()
  if (!node) {
    await rm(root, { recursive: true })
    throw new Error('Bundled Windows Node runtime is unavailable')
  }
  const inputProgram = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{console.log(JSON.stringify({argv:process.argv.slice(1),env:process.env.HOLI_FIXTURE,cwd:process.cwd(),input}));console.error('fixture stderr');process.exitCode=7})`
  const token = 'a'.repeat(64)
  const server = createBridgeServer({
    log: () => {},
    cli: {
      dispatch: async ({ name, params }) =>
        name === 'fixture.handoff'
          ? {
              value: null,
              text: '',
              run: {
                argv: [node, '-e', inputProgram, '--', ...argumentsToPreserve],
                cwd: root,
                env: { HOLI_FIXTURE: 'environment café' },
              },
            }
          : { value: params, text: JSON.stringify(params) },
      commands: () => [
        { name: 'fixture.echo', cli: { args: [], many: ['item'], summary: 'echo values' } },
        {
          name: 'fixture.handoff',
          cli: { args: [], stdin: 'content', summary: 'read input and hand off' },
        },
      ],
      rootFor: async () => root,
      machine: {
        token: () => token,
        resolveTarget: async () => ({ remote: 'owner/repo', root, live: true }),
      },
    },
  })
  try {
    await server.start()
    const userData = join(root, 'user data')
    const cli = await installHoliCli(userData)
    await writeFile(
      join(userData, 'cli-endpoint.json'),
      JSON.stringify({ host: '127.0.0.1', port: server.port(), token }, null, 2) + '\n',
    )
    return {
      root,
      cli,
      options: {
        cwd: root,
        env: { ...process.env, PATH: join(process.env.SystemRoot!, 'System32') },
        timeout: 10_000,
        windowsHide: true,
        encoding: 'utf8' as const,
      },
      close: async () => {
        try {
          await server.stop()
        } finally {
          await rm(root, { recursive: true })
        }
      },
    }
  } catch (error) {
    try {
      await server.stop()
    } finally {
      await rm(root, { recursive: true })
    }
    throw error
  }
}

describe.skipIf(process.platform !== 'win32')('native Windows Holi CLI', () => {
  it('preserves Unicode, quotes, empty values and backslashes through authenticated dispatch', async () => {
    const f = await fixture()
    try {
      const result = await execute(
        f.cli,
        ['fixture', 'echo', ...argumentsToPreserve.flatMap((value) => ['--item', value])],
        f.options,
      )
      expect(JSON.parse(result.stdout)).toEqual({ item: argumentsToPreserve })
      expect(result.stderr).toBe('')
    } finally {
      await f.close()
    }
  })

  it('forwards consumed stdin to the program handoff and preserves output and exit status', async () => {
    const f = await fixture()
    try {
      const input = 'stdin café☃\nsecond line with "quotes"\\\n'
      const running = execute(f.cli, ['fixture', 'handoff'], f.options)
      running.child.stdin!.on('error', () => {})
      running.child.stdin!.end(input)
      const result = await running.then(
        () => {
          throw new Error('The fixture program must exit with status seven')
        },
        (error: { code: number | string; stdout: string; stderr: string }) => error,
      )
      expect(result.code).toBe(7)
      expect(JSON.parse(result.stdout)).toEqual({
        argv: argumentsToPreserve,
        env: 'environment café',
        cwd: f.root,
        input,
      })
      expect(result.stderr).toBe('fixture stderr\n')
    } finally {
      await f.close()
    }
  })
})
