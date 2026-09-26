/**
 * What a vault opens on, once its `landing` setting has met the vault as it
 * really is.
 *
 * A named note or app may have been deleted since, possibly by a collaborator,
 * so the target is checked against the snapshot before anything opens.
 */
import type { LandingTarget, ResolvedVaultSettings } from '@holi/shared'

/** What the vault actually holds, as the snapshot sees it. */
export interface VaultContents {
  docPaths: ReadonlySet<string>
  appPaths: ReadonlySet<string>
}

type LandingSettings = Pick<ResolvedVaultSettings, 'landing' | 'dailyNotes'>

/**
 * The target to open, or `null` for one empty pane.
 *
 * A rotted target falls back by re-resolving as if `landing` were daily, not
 * to a hardcoded daily: a vault with daily notes off lands on nothing. Rot
 * degrades to the ordinary thing, never an error (as D82 does for icons).
 */
export function resolveLanding(
  settings: LandingSettings,
  vault: VaultContents,
): LandingTarget | null {
  const { landing, dailyNotes } = settings

  switch (landing.kind) {
    case 'daily':
      return dailyNotes ? { kind: 'daily' } : null

    case 'note':
      return vault.docPaths.has(landing.path)
        ? { kind: 'note', path: landing.path }
        : resolveLanding({ landing: { kind: 'daily' }, dailyNotes }, vault)

    case 'app':
      return vault.appPaths.has(landing.path)
        ? { kind: 'app', path: landing.path }
        : resolveLanding({ landing: { kind: 'daily' }, dailyNotes }, vault)

    // The singleton surfaces cannot rot, and `dailyNotes` does not affect them.
    default:
      return { kind: landing.kind }
  }
}
