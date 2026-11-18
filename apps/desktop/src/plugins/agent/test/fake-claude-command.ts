import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaudeCli } from '../main/claude/cli'

/** A real, credential-free command through the production CLI runner. Its
 * child is owned only by this fixture; neither listing nor name proves that. */
export async function fakeClaudeCommand(output: string) {
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-command-'))
  const bin = join(root, 'claude.mjs')
  const pidFile = join(root, 'child.pid')
  const callsFile = join(root, 'calls')
  const heartbeatFile = join(root, 'heartbeat')
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
if (process.argv.includes('--fixture-worker')) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
  let beat = 0
  const heartbeat = () => writeFileSync(${JSON.stringify(heartbeatFile)}, String(++beat))
  heartbeat()
  process.send('ready')
  setInterval(heartbeat, 25)
} else {
  const args = process.argv.slice(2)
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n')
  if (args[0] === '--bg') {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-worker'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
    })
    child.once('message', () => {
      child.disconnect()
      child.unref()
      process.stdout.write(${JSON.stringify(output)})
    })
  } else if (args[0] === 'agents') process.stdout.write('[]')
  else { process.stderr.write('fixture refuses unowned stop'); process.exitCode = 1 }
}
`,
  )
  let commandBin = bin
  if (process.platform === 'win32') {
    // Exercise the same real npm command shim fixture as launch.test.ts.
    const shim = await readFile(
      new URL('../../../../test/fixtures/npm-node-shim.cmd', import.meta.url),
      'utf8',
    )
    commandBin = join(root, 'claude.cmd')
    await writeFile(commandBin, shim.replace('node_modules\\fixture\\cli.js', 'claude.mjs'))
  } else {
    await chmod(bin, 0o755)
  }
  const cli = createClaudeCli({ resolveBin: () => commandBin, log: () => {} })
  const target = { root, configDir: root, binDir: null }
  return {
    cli,
    target,
    childPid: async () => Number(await readFile(pidFile, 'utf8')),
    heartbeat: async () => Number(await readFile(heartbeatFile, 'utf8')),
    calls: async () =>
      (await readFile(callsFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
    async close() {
      // Fixture-owned pid, never a native session inferred from a name/listing.
      try {
        const pid = Number(await readFile(pidFile, 'utf8'))
        if (pid > 1) process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}
