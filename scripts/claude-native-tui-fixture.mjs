import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  }
}

/** Prepare an isolated, credential-free fixture. Native execution is deliberately not part of this checkpoint. */
export async function prepareClaudeNativeTuiFixture({ install, version, directory } = {}) {
  if (!install || !/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new TypeError('Claude install directory and exact version are required')
  const root = await mkdtemp(join(directory ?? tmpdir(), 'holi-claude-native-'))
  try {
    const home = join(root, 'home'), config = join(root, 'config'), vault = join(root, 'vault'), session = join(root, 'session')
    await Promise.all([home, config, vault, session].map((path) => mkdir(path, { mode: 0o700 })))
    const binary = await resolveNativeBinary(install, version)
    const environment = isolatedEnvironment({ root, home, config, vault })
    const receipt = { outcome: 'unverified', nativeLaunched: false, version, binary, isolation: 'prepared', cleanup: 'pending', gaps: ['native startup and session ownership not exercised', 'network denial requires verified platform containment'] }
    return { root, binary, environment, receipt, async close() { await rm(root, { recursive: true, force: true }); receipt.cleanup = 'complete' } }
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
