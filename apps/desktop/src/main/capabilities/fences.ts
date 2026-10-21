/**
 * What a capability may read: the refusals every door shares.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import {
  isAgentSurfacePath,
  isAppFencedPath,
  isAppWritablePath,
  isMachineStatePath,
  isSecretPath,
  vaultRelPath,
  type VaultRelPath,
} from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError } from './error'
import type { CapabilityContext } from './registry'

/**
 * The vault path a person may be shown, or a refusal: a real vault path, not
 * this machine's state under `.holi/state/` (it holds the bridge's tokens) and
 * not a secret file. Every read starts here; `docs.open` stops here, since the
 * agent may show the person its own surface.
 */
export function shownPath(path: string): VaultRelPath {
  let rel
  try {
    rel = vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
  if (isMachineStatePath(rel) || isSecretPath(rel)) throw new CapabilityError('FORBIDDEN', path)
  return rel
}

/**
 * The note a read may reach, or a refusal: `shownPath`, and not the agent
 * surface, and not any app's records, its own included (the store is the only
 * way in, so one app cannot read another's data, a personal app's least of
 * all). A secret file is refused because an app gets only the keys it
 * declares, through `holi.env`. `docs.read`, `docs.render` and
 * `tasks.complete` share it.
 */
export function readablePath(path: string): VaultRelPath {
  if (isAgentSurfacePath(path)) throw new CapabilityError('FORBIDDEN', path)
  const rel = shownPath(path)
  // Checked again on the normalised path: `./.holi/memory/x.md` is `.holi/memory/x.md`.
  if (isAppFencedPath(rel)) throw new CapabilityError('FORBIDDEN', path)
  return rel
}

/** `path` if a read may reach it, else null. */
export function readableOrNull(path: string): VaultRelPath | null {
  try {
    return readablePath(path)
  } catch {
    return null
  }
}

/**
 * `readablePath`, and a path the vault's snapshot holds, exactly. The snapshot
 * is built from `readdir`, so its paths have the case they have on disk: on a
 * case-insensitive filesystem (macOS) `.holi/Memory/x.md` opens `.holi/memory/x.md`, and a
 * check of the name as typed would wave it through. Matching the snapshot makes
 * the refusals see the real name.
 */
export async function knownPath(ctx: CapabilityContext, path: string): Promise<VaultRelPath> {
  return inSnapshot(ctx, readablePath(path), path)
}

/** `rel` if the vault's snapshot holds it exactly (see `knownPath`), else a
 *  NOT_FOUND naming `path` as the caller gave it. */
export async function inSnapshot(
  ctx: CapabilityContext,
  rel: VaultRelPath,
  path: string,
): Promise<VaultRelPath> {
  const snapshot = await ctx.snapshot()
  const known =
    snapshot.docs.some((d) => d.path === rel) ||
    snapshot.files.some((f) => f.path === rel) ||
    Object.values(snapshot.claimed).some(
      (set) => set.items.some((i) => i.path === rel) || set.broken.some((b) => b.path === rel),
    )
  if (!known) throw new CapabilityError('NOT_FOUND', path)
  return rel
}

export async function readNote(ctx: CapabilityContext, path: string): Promise<string> {
  const rel = await knownPath(ctx, path)
  // The snapshot never lists a symlink, but it can be a scan behind the disk.
  const abs = await exactPath(ctx.root, rel)
  if (abs === null) throw new CapabilityError('FORBIDDEN', path)
  const text = await readFile(abs, 'utf8').catch(() => null)
  if (text === null) throw new CapabilityError('NOT_FOUND', path)
  return text
}

/**
 * What an app may write, or a refusal: whatever a read refuses, and then the
 * one app write rule (`isAppWritablePath`).
 */
export function writablePath(path: string): VaultRelPath {
  const rel = readablePath(path)
  if (!isAppWritablePath(rel)) throw new CapabilityError('FORBIDDEN', path)
  return rel
}

/**
 * The file a write opens, only when it is `rel` as named: no symlink on the
 * way and the case it has on disk (`exactPath`), so the name the fences
 * checked is the file that changes. The file need not exist.
 */
export async function writableFile(ctx: CapabilityContext, rel: VaultRelPath): Promise<string> {
  const abs = await exactPath(ctx.root, rel)
  if (abs === null) throw new CapabilityError('FORBIDDEN', rel)
  return abs
}
