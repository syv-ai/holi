import { stat } from 'node:fs/promises'
import { exactPath } from '@holi/shared/path-safety-node'
import { parseHoliLink, type VaultEntry } from '@holi/shared'

type HoliLinkCheckResult =
  | { ok: true; remote: string; path: string; heading?: string }
  | { ok: false; message: string; detail: string }

/** Check an untrusted Holi link against the local registry and canonical disk paths. */
async function checkHoliLink(
  url: string,
  vaults: () => Promise<readonly VaultEntry[]>,
): Promise<HoliLinkCheckResult> {
  const parsed = parseHoliLink(url)
  if (!parsed.ok)
    return { ok: false, message: 'This link cannot be opened.', detail: parsed.reason }
  const { remote, path, heading } = parsed.link
  const entry = (await vaults()).find(
    (vault) => vault.remote.toLowerCase() === remote.toLowerCase(),
  )
  if (entry === undefined) {
    return {
      ok: false,
      message: `${remote} is not on this computer.`,
      detail: 'Add the vault with Add vault… in the vault menu, then open the link again.',
    }
  }
  const abs = await exactPath(entry.path, path)
  const isFile =
    abs !== null &&
    (await stat(abs).then(
      (result) => result.isFile(),
      () => false,
    ))
  if (!isFile) {
    return {
      ok: false,
      message: `${path} is not in ${remote}.`,
      detail: 'It may have been moved or deleted, or it has not synced to this computer yet.',
    }
  }
  return { ok: true, remote: entry.remote, path, ...(heading === undefined ? {} : { heading }) }
}

/** Open a checked location through the window's shared vault:open route. */
export async function openHoliLink(
  url: string,
  deps: {
    vaults: () => Promise<readonly VaultEntry[]>
    showPath: (remote: string, path: string, options: { heading?: string }) => void
  },
): Promise<{ ok: true } | { ok: false; message: string; detail: string }> {
  const result = await checkHoliLink(url, deps.vaults)
  if (!result.ok) return result
  const { remote, path, heading } = result
  deps.showPath(remote, path, { heading })
  return { ok: true }
}
