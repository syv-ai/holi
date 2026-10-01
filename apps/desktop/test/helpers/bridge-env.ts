/**
 * A vault the way every command inside one finds Holi: the `.holi/vault`
 * marker at its root, and `.holi/state/bridge.local.env` beside it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BRIDGE_ENV_FILE } from '../../src/main/bridge/env-file'

/** Mark `root` as a vault and write its env file as given, verbatim; null
 *  removes the file and leaves the marker. */
export async function writeVaultEnv(root: string, text: string | null): Promise<void> {
  await mkdir(join(root, '.holi/state'), { recursive: true })
  await writeFile(join(root, '.holi/vault'), '', 'utf8')
  if (text === null) await rm(join(root, BRIDGE_ENV_FILE), { force: true })
  else await writeFile(join(root, BRIDGE_ENV_FILE), text, { mode: 0o600 })
}

/** The bridge's two lines for `port` and `token`. */
export const bridgeLines = (port: number | string, token: string): string =>
  `HOLI_BRIDGE_PORT=${port}\nHOLI_BRIDGE_TOKEN=${token}\n`
