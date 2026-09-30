/**
 * Where Home goes, once the `home` setting has met the vault as it really is.
 *
 * A named file or app may have been deleted since, possibly by a collaborator,
 * and a vault may keep no daily note, so the target is checked against the
 * snapshot. What cannot be reached is not an error and not a fallback: the
 * Home tab says what Home is and why it is not there.
 */
import { homeTargetOf, type HomeTarget, type ResolvedVaultSettings } from '@holi/shared'

/** What the vault actually holds, as the snapshot sees it. */
export interface VaultContents {
  /** Every file: notes and anything else. */
  filePaths: ReadonlySet<string>
  appPaths: ReadonlySet<string>
}

export type ResolvedHome =
  /** Open this: a view, a file, or today's daily. */
  | { reach: 'open'; target: HomeTarget }
  /** The Home tab, showing this app. */
  | { reach: 'tab'; target: HomeTarget & { kind: 'app' } }
  /** The Home tab, saying why this cannot be shown. */
  | { reach: 'missing'; target: HomeTarget }

export function resolveHome(
  settings: Pick<ResolvedVaultSettings, 'home' | 'dailyNotes'>,
  vault: VaultContents,
): ResolvedHome {
  const target = homeTargetOf(settings.home)
  switch (target.kind) {
    case 'app':
      return vault.appPaths.has(target.path)
        ? { reach: 'tab', target }
        : { reach: 'missing', target }
    case 'file':
      return vault.filePaths.has(target.path)
        ? { reach: 'open', target }
        : { reach: 'missing', target }
    case 'daily':
      return settings.dailyNotes ? { reach: 'open', target } : { reach: 'missing', target }
    default:
      return { reach: 'open', target }
  }
}
