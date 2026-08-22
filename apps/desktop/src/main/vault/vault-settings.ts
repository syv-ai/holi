/**
 * The large-file gate's view of the vault's settings.
 *
 * One key, named here so the gate does not have to know that `.holi/settings.json`
 * holds anything else. The parsing, merging and defaulting all live in
 * `@holi/shared`'s `resolveVaultSettings` — this used to hand-roll its own
 * `JSON.parse`, which was the second of two independent readers of the same file
 * and no schema between them.
 *
 * Anything wrong — no file, bad JSON, a non-positive or non-numeric value —
 * still yields the default, because a corrupt config must never break the commit
 * path. That contract is now the resolver's, and is tested there.
 */
import { readVaultSettings } from './settings'

/** The per-vault cap on a committed file's size, or the 10 MB default. */
export async function readMaxCommittedFileBytes(root: string): Promise<number> {
  return (await readVaultSettings(root)).maxCommittedFileBytes
}
