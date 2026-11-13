/** Publishes the private connection details for this running Holi CLI endpoint.
 * The caller supplies an absolute, trusted path after the server is listening.
 * The file is data, never shell input, and disposal only removes this instance's
 * unchanged descriptor.
 */
import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'

export interface CliEndpoint {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly token: string
  dispose(): Promise<void>
}

const PRIVATE_MODE = 0o600

function assertPrivateOwnedFile(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe CLI endpoint file: ${path}`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`CLI endpoint file is not owned by this user: ${path}`)
  }
  if (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0) {
    throw new Error(`CLI endpoint file is not private: ${path}`)
  }
}

/** Atomically publish a fresh credential at `path`; throws without leaving a
 * temporary file if the path is unsafe or publication fails. */
export async function publishCliEndpoint(path: string, port: number): Promise<CliEndpoint> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CLI endpoint port must be an integer from 1 to 65535')
  }
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error('CLI endpoint path must be an absolute normalized path')
  }

  const token = randomBytes(32).toString('hex')
  const descriptor = { host: '127.0.0.1' as const, port, token }
  const contents = `${JSON.stringify(descriptor, null, 2)}\n`
  const temporary = join(
    dirname(path),
    `.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined

  try {
    try {
      const existing = await lstat(path)
      assertPrivateOwnedFile(existing, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    handle = await open(temporary, 'wx', PRIVATE_MODE)
    await handle.writeFile(contents, 'utf8')
    await handle.close()
    handle = undefined

    // Recheck before rename: never replace an entry that became unsafe during
    // the write. The trusted parent directory is supplied by the caller.
    try {
      const existing = await lstat(path)
      assertPrivateOwnedFile(existing, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporary, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }

  return {
    ...descriptor,
    async dispose() {
      try {
        const stat = await lstat(path)
        assertPrivateOwnedFile(stat, path)
        if ((await readFile(path, 'utf8')) === contents) await rm(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}
