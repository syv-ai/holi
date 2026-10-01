/**
 * Where Home goes, once the `home` setting has met the vault as it really is.
 *
 * A named file or app may have been deleted since, possibly by a collaborator,
 * a vault may keep no daily note, and a view may belong to a plugin that is
 * off, so the target is checked against the snapshot and the registry. What
 * cannot be reached is not an error and not a fallback: the Home tab says
 * what Home is and why it is not there.
 */
import { homeTargetOf, type HomeTarget, type ResolvedVaultSettings } from '@holi/shared'

/** What the vault actually holds, as the snapshot sees it. */
export interface VaultContents {
  /** Every file: notes and anything else. */
  filePaths: ReadonlySet<string>
  appPaths: ReadonlySet<string>
  /** The registered surfaces that may be Home, by kind. */
  homeable: ReadonlySet<string>
}

export type ResolvedHome =
  /** Open this: a surface, a file, or today's daily. */
  | { reach: 'open'; target: Exclude<HomeTarget, { kind: 'recents' | 'app' }> }
  /** The Home tab, showing this: the recents, or an app. */
  | { reach: 'tab'; target: Extract<HomeTarget, { kind: 'recents' | 'app' }> }
  /** The Home tab, saying why this cannot be shown. */
  | { reach: 'missing'; target: HomeTarget }

export function resolveHome(
  settings: Pick<ResolvedVaultSettings, 'home' | 'dailyNotes'>,
  vault: VaultContents,
): ResolvedHome {
  const target = homeTargetOf(settings.home)
  switch (target.kind) {
    case 'recents':
      return { reach: 'tab', target }
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
    case 'surface':
      // Not registered (its plugin is off), or not one that can be Home.
      return vault.homeable.has(target.surface)
        ? { reach: 'open', target }
        : { reach: 'missing', target }
  }
}
