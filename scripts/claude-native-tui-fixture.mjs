import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { startOwnedPty } from './pi-native-tui-process.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveNativeBinary } from './claude-compatibility.mjs'

export function isolatedEnvironment({ root, home, config, vault }) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home,
    CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'), TMPDIR: root, TMP: root, TEMP: root,
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    NO_COLOR: '1', CI: '1',
    CLAUDECODE: '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  }
}

/** Prepare an isolated fixture; a receipt passes only after bounded native launch and verified drainage. */
export async function prepareClaudeNativeTuiFixture({ install, version, directory } = {}) {
  if (!install || !/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new TypeError('Claude install directory and exact version are required')
  const root = await mkdtemp(join(directory ?? tmpdir(), 'holi-claude-native-'))
  try {
    const home = join(root, 'home'), config = join(root, 'config'), vault = join(root, 'vault'), session = join(root, 'session')
    await Promise.all([home, config, vault, session].map((path) => mkdir(path, { mode: 0o700 })))
    const binary = await resolveNativeBinary(install, version)
    const nativeRoot = join(install, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`)
    const manifest = JSON.parse(await readFile(join(nativeRoot, 'package.json'), 'utf8'))
    const executableHash = createHash('sha256').update(await readFile(binary)).digest('hex')
    const packageHash = createHash('sha256').update(await readFile(join(nativeRoot, 'package.json'))).digest('hex')
    const environment = isolatedEnvironment({ root, home, config, vault })
    const receipt = { outcome: 'unverified', nativeLaunched: false, version, binary, provenance: { package: manifest.name, packageVersion: manifest.version, packageManifestSha256: packageHash, binarySha256: executableHash }, isolation: 'prepared', cleanup: 'pending', unsupported: ['network-denial containment not verified on this platform', 'native identity and controls not established'] }
    let processHandle
    return { root, binary, environment, receipt, async launch({ args = ['--version'], timeoutMs = 15000 } = {}) {
      if (process.platform !== 'darwin' || !await import('node:fs/promises').then(({ access }) => access('/usr/bin/sandbox-exec').then(() => true, () => false))) throw new Error('fail closed: native execution requires macOS Seatbelt')
      const handle = await startOwnedPty({ command: '/usr/bin/sandbox-exec', args: ['-p', '(version 1) (deny default) (allow process*) (allow file-read*) (allow file-write* (subpath "' + root + '")) (allow network-outbound (remote tcp "localhost:1"))', '--', binary, ...args], cwd: vault, env: environment, stateDirectory: join(root, 'owned'), timeoutMs: Math.min(timeoutMs, 90000), maxOutputBytes: 65536 })
      processHandle = handle
      receipt.nativeLaunched = true
      return handle
    }, async close() { if (processHandle) receipt.process = await processHandle.close(); await rm(root, { recursive: true, force: true }); receipt.cleanup = 'complete'; receipt.outcome = 'unverified'
      receipt.unsupported.push('startup-only execution does not establish TUI ownership, links, or native controls') } }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [install, version] = process.argv.slice(2)
  try {
    const fixture = await prepareClaudeNativeTuiFixture({ install, version })
    process.stdout.write(`${JSON.stringify(fixture.receipt)}\n`)
    await fixture.close()
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'setup-failed', detail: error.message })}\n`)
    process.exitCode = 1
  }
}
