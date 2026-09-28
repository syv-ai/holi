/**
 * Where a vault's agent finds the running Holi (D110).
 *
 * A background session's environment comes from Claude Code's supervisor, not
 * from Holi, and the supervisor outlives a Holi restart that moves every port.
 * So the port and tokens the agent's hooks and commands need live in a file in
 * the vault's own Claude Code config directory, the one variable Claude Code
 * does carry into every session. Holi rewrites it whole each time it opens the
 * vault and deletes it when it leaves.
 *
 * `KEY=value` lines, sourced by the `holi` and `holi-google` shell scripts and
 * split by `turn-signal.mjs`. Every value is digits or hex, checked here, so
 * sourcing it can never run anything.
 *
 * Mode 0600: the tokens open the vault's ops and its Google account.
 */
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ENDPOINT_FILE = 'holi.env'

export interface Endpoint {
  hookPort: number
  hookToken: string
  googlePort?: number | null
  googleToken?: string | null
}

const SAFE = /^[0-9a-f]+$/

function line(key: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (!SAFE.test(text)) throw new Error(`${key} is not digits or hex`)
  return `${key}=${text}`
}

export function endpointText(endpoint: Endpoint): string {
  return (
    [
      line('HOLI_HOOK_PORT', endpoint.hookPort),
      line('HOLI_HOOK_TOKEN', endpoint.hookToken),
      line('HOLI_GOOGLE_PORT', endpoint.googlePort),
      line('HOLI_GOOGLE_TOKEN', endpoint.googleToken),
    ]
      .filter((l): l is string => l !== null)
      .join('\n') + '\n'
  )
}

/** Write it whole, atomically, readable by this user only. */
export async function writeEndpointFile(configDir: string, endpoint: Endpoint): Promise<void> {
  const path = join(configDir, ENDPOINT_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, endpointText(endpoint), { mode: 0o600 })
  await rename(tmp, path)
}

/** Holi has left the vault: its sessions find nothing rather than a dead port. */
export async function removeEndpointFile(configDir: string): Promise<void> {
  await rm(join(configDir, ENDPOINT_FILE), { force: true })
}
