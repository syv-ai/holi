import { SCRATCHPAD_PATH } from '@holi/shared'

/** True only for the vault's canonical root scratchpad path. */
export function isScratchpadPath(path: string): boolean {
  return path === SCRATCHPAD_PATH
}
