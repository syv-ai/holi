import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startOwnedPty } from './pi-native-tui-process.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clean = (text) =>
  text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

// Performs the native initial-consent fixture only. Every input is evidence-gated;
// inability to observe a required state returns incomplete evidence, never a verdict.
export async function runNativeInitialFixture({
  root = join(tmpdir(), `holi764-native-${randomUUID()}`),
} = {}) {
  const evidence = {
    root,
    scenario: 'initialTUI',
    status: 'incomplete',
    consent: [],
    trustChanges: [],
    hooks: [],
    requests: [],
    argv: [],
    receipts: [],
    drainage: false,
  }
  const handles = []
  let server
  try {
    for (const dir of ['home', 'xdg', 'tmp', 'vault', 'runtime', 'npm-user', 'npm-global'])
      await mkdir(join(root, dir), { recursive: true, mode: 0o700 })
    const npmUser = join(root, 'npm-user/npmrc'),
      npmGlobal = join(root, 'npm-global/npmrc')
    await writeFile(npmUser, 'audit=false\nfund=false\n')
    await writeFile(npmGlobal, 'audit=false\nfund=false\n')
    const install = await startOwnedPty({
      command: 'npm',
      args: [
        'install',
        '--ignore-scripts',
        '--prefix',
        join(root, 'install'),
        '@openai/codex@0.169.0',
      ],
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        NPM_CONFIG_USERCONFIG: npmUser,
        NPM_CONFIG_GLOBALCONFIG: npmGlobal,
      },
      stateDirectory: join(root, 'runtime/install'),
      timeoutMs: 120000,
      maxOutputBytes: 262144,
    })
    handles.push(install)
    await install.waitForExit()
    evidence.installOutput = install.output.toString()
    if (install.nativeExit?.code !== 0) throw Error('Pinned Codex installation failed')
    const pkg = JSON.parse(
      await readFile(join(root, 'install/node_modules/@openai/codex/package.json'), 'utf8'),
    )
    if (pkg.name !== '@openai/codex' || pkg.version !== '0.169.0')
      throw Error('Pinned package identity mismatch')
    evidence.package = { name: pkg.name, version: pkg.version }
    evidence.status = 'setup-complete-incomplete-native-proof'
    // TUI consent and session-start execution are deliberately not inferred from installation.
  } catch (error) {
    evidence.error = String(error)
  } finally {
    for (const child of handles) {
      try {
        evidence.receipts.push(await child.close())
      } catch (error) {
        evidence.cleanupError = String(error)
      }
    }
    evidence.drainage = handles.every((child) => child.closed === true || child.nativeExit != null)
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
  return evidence
}
