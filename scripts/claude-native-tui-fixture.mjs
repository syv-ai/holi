import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function isolatedEnvironment({ root, home, config }) {
  return {
    PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'),
    TMPDIR: root, TMP: root, TEMP: root, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8', NO_COLOR: '1', CI: '1', CLAUDECODE: '',
  }
}

/** A fail-closed interface until network-denial containment can be positively proven. */
export async function runClaudeNativeTuiFixture({ install, version, artifactDirectory, timeout = 15000 } = {}) {
  if (!install || version !== '2.1.319' || !artifactDirectory)
    throw new TypeError('Only verified Claude 2.1.319 installs and an artifact directory are supported')
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 15000)
    throw new TypeError('timeout must be between 1 and 15000 milliseconds')
  // A general macOS Seatbelt deny rule alone is not proof that the required
  // loopback exception works while public networking and credential access fail.
  // Do not launch Claude until that probe is implemented and verified.
  const receipt = {
    outcome: 'unverified', version, nativeLaunched: false, requests: 0,
    nativeInputBytes: [],
    remaining: 'Network-denial containment has not been verified; post-trust behavior, session ownership, and hint targets remain unverified. No trust bypass or cloud fallback.',
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(join(artifactDirectory, 'claude-native-tui-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [install, version, artifactDirectory] = process.argv.slice(2)
  try {
    const receipt = await runClaudeNativeTuiFixture({ install, version, artifactDirectory })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'setup-failed', detail: error.message.slice(0, 500) })}\n`)
    process.exitCode = 1
  }
}
