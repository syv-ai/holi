/** Core owns vault CLI credentials and installation layout; plugins receive only a bin directory. */
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isRemote } from '@holi/shared'
import { installHoliCli } from './cli'
import { publishCliEndpoint, type CliEndpoint } from './cli-endpoint'
import { installNodeFallback } from './node-fallback'
import type { BridgeServer } from './server'

/** One installation per normalized remote for this running bridge. Disposal must
 * follow plugin/process drain and precede bridge shutdown. */
export function createVaultCliInstallations(
  userDataDir: string,
  bridge: Pick<BridgeServer, 'port' | 'tokenForVault'>,
  execPath: string,
) {
  if (!isAbsolute(userDataDir)) throw new Error('vault CLI user data path must be absolute')
  const pending = new Map<string, Promise<string>>()
  const endpoints = new Set<CliEndpoint>()
  let closed = false
  let disposal: Promise<void> | undefined

  async function privateDirectory(path: string) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await lstat(path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('unsafe vault CLI installation directory')
    }
  }

  async function prepare(remote: string) {
    const port = bridge.port()
    if (port === null) throw new Error('vault CLI bridge is not listening')
    // Reversible remote segments, not generated vault IDs. Hex has no Windows
    // device names or trailing dots/spaces, and cannot collapse distinct names.
    const segments = remote
      .toLowerCase()
      .split('/')
      .map((segment) => Buffer.from(segment, 'utf8').toString('hex'))
    let dir = userDataDir
    for (const segment of ['vault-cli', ...segments]) {
      dir = join(dir, segment)
      await privateDirectory(dir)
    }
    const descriptorPath = join(dir, 'cli-endpoint.json')
    let endpoint: CliEndpoint | undefined
    try {
      const binDir = join(dir, 'bin')
      await privateDirectory(binDir)
      await installHoliCli(dir, process.platform, { descriptorPath, binDir })
      await installNodeFallback(dir, execPath)
      if (closed) throw new Error('vault CLI installations are disposed')
      endpoint = await publishCliEndpoint(descriptorPath, port, bridge.tokenForVault(remote))
      if (closed) throw new Error('vault CLI installations are disposed')
      endpoints.add(endpoint)
      return binDir
    } catch (error) {
      await endpoint?.dispose()
      throw error
    }
  }

  return {
    forRemote(remote: string): Promise<string> {
      if (closed) return Promise.reject(new Error('vault CLI installations are disposed'))
      if (!isRemote(remote)) return Promise.reject(new Error('invalid vault remote'))
      const normalized = remote.toLowerCase()
      let installation = pending.get(normalized)
      if (!installation) {
        installation = prepare(remote).catch((error) => {
          pending.delete(normalized)
          throw error
        })
        pending.set(normalized, installation)
      }
      return installation
    },
    dispose(): Promise<void> {
      closed = true
      disposal ??= (async () => {
        await Promise.allSettled(pending.values())
        await Promise.all([...endpoints].map((endpoint) => endpoint.dispose()))
        endpoints.clear()
      })()
      return disposal
    },
  }
}
