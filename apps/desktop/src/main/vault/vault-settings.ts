/**
 * The large-file gate's view of the vault's settings: one key, so the gate does
 * not have to know the file holds anything else. Parsing and defaulting live in
 * `resolveVaultSettings`, which yields the default for anything wrong, because
 * a corrupt config must never break the commit path.
 */
import { readVaultSettings } from './settings'

/** The per-vault cap on a committed file's size, or the 10 MB default. */
export async function readMaxCommittedFileBytes(root: string): Promise<number> {
  return (await readVaultSettings(root)).maxCommittedFileBytes
}
