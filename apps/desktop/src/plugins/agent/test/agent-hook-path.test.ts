import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installNodeFallback } from '../../../main/bridge/node-fallback'
import { buildAgentEnv } from '../main/claude/cli'

/**
 * What the Dock gives an app: launchd's PATH, with no `node` on it (macOS
 * ships none). Every hook Holi seeds is `node "<script>"`, so the agent's hooks
 * run only if the env Holi hands `claude` can find one.
 */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-hookpath-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** A `node` that says which one it is. */
async function fakeNode(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'node'), `#!/bin/sh\necho ${name}\n`)
  await chmod(join(dir, 'node'), 0o755)
}

/** The env Holi gives the agent when it was launched from the Dock, over a
 *  userData and a home of their own. */
async function finderEnv(over: { path?: string } = {}) {
  const userData = await tempDir()
  const home = await tempDir()
  const binDir = join(userData, 'bin')
  await mkdir(binDir, { recursive: true })
  // The running app's own executable: here, Node itself.
  await installNodeFallback(userData, process.execPath)
  const env = buildAgentEnv(
    { PATH: over.path ?? FINDER_PATH, HOME: home },
    { binDir, configDir: join(userData, 'agent-config') },
  )
  return { env, binDir, home, userData }
}

const sh = (env: Record<string, string>, script: string, input = ''): string =>
  execFileSync('/bin/sh', ['-c', script], { env, input, encoding: 'utf8' }).trim()

describe('the agent finds node from a Dock-launched Holi', () => {
  it('has a node on its PATH when the Dock gave it none', async () => {
    const { env, binDir } = await finderEnv()
    expect(sh(env, 'command -v node')).toBeTruthy()
    // And it is Holi's own, last, not something that shadows a real one.
    const path = env.PATH!.split(':')
    expect(path[0]).toBe(binDir)
    expect(path.at(-1)).toBe(join(binDir, 'fallback'))
  })

  it('runs a script through it, as a hook does', async () => {
    const { env, home } = await finderEnv()
    const script = join(home, 'hook.mjs')
    await writeFile(script, "import { basename } from 'node:path'\nconsole.log(basename('/a/b'))\n")
    expect(sh(env, `node "${script}"`)).toBe('b')
  })

  it('prefers a node the machine has to Holi’s own', async () => {
    const real = await tempDir()
    await fakeNode(real, 'the-machines-node')
    const { env } = await finderEnv({ path: `${FINDER_PATH}:${real}` })
    expect(sh(env, 'node')).toBe('the-machines-node')
  })

  it('looks where tools usually are, which a Dock launch does not', async () => {
    const { env, home } = await finderEnv()
    // A name no machine has, so a real tool in an earlier directory (a
    // Homebrew `node`, say) cannot answer instead.
    const dir = join(home, '.local', 'bin')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'holi-probe-tool'), '#!/bin/sh\necho local-bin-tool\n')
    await chmod(join(dir, 'holi-probe-tool'), 0o755)
    // `~/.local/bin` is not on the Dock's PATH, and is where Claude Code and
    // many node installs put things.
    expect(sh(env, 'holi-probe-tool')).toBe('local-bin-tool')
  })

  describe('every hook Holi seeds', () => {
    const shipped = [
      join(__dirname, '../main/claude/vault/shipped'),
      join(__dirname, '../../google/main/vault/shipped'),
      join(__dirname, '../../apps/main/vault/shipped'),
    ]

    it('starts instead of exiting 127, command not found', async () => {
      const { env } = await finderEnv()
      const ran: string[] = []
      for (const project of shipped) {
        const hooks = await readdir(join(project, '.claude/hooks'))
        for (const file of hooks.filter((f) => f.endsWith('.mjs'))) {
          let status = 0
          try {
            execFileSync('/bin/sh', ['-c', `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`], {
              env: { ...env, CLAUDE_PROJECT_DIR: project },
              cwd: await tempDir(),
              input: '{}',
              stdio: ['pipe', 'ignore', 'ignore'],
            })
          } catch (err) {
            status = (err as { status?: number }).status ?? -1
          }
          // Whatever it decides about an empty input is its own business; that
          // it ran at all is this test's.
          expect([file, status === 127]).toEqual([file, false])
          ran.push(file)
        }
      }
      expect(ran.sort()).toEqual([
        'google-send-gate.mjs',
        'memory-index-guard.mjs',
        'memory-overview.mjs',
        'turn-signal.mjs',
        'user-prompt-submit.mjs',
        'vault-app-check.mjs',
      ])
    })
  })
})
