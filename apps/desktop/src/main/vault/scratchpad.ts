import { SCRATCHPAD_PATH } from '@holi/shared'

/** True only for the vault's canonical root scratchpad path. */
export function isScratchpadPath(path: string): boolean {
  return path === SCRATCHPAD_PATH
}

/**
 * Paths holding scratchpad content after git's original-to-final renames.
 * A destination is protected only when its original file was the canonical
 * scratchpad; a different file that moves onward from that same path is not.
 */
export function scratchpadContentPaths(
  renamed: readonly { from: string; to: string }[],
): ReadonlySet<string> {
  return new Set([
    SCRATCHPAD_PATH,
    ...renamed.filter(({ from }) => isScratchpadPath(from)).map(({ to }) => to),
  ])
}
