/**
 * What a vault opens on, once its `landing` setting has met the vault as it
 * really is.
 *
 * The setting says where you want to land; this says where you *can*. A note can
 * be deleted, and an app can be removed by a collaborator in a shared vault
 * between one launch and the next — so a target that names one is a claim about
 * the past, and has to be checked against the snapshot before anything opens.
 *
 * Pure, and on plain values, for the reason the whole `lib/` split exists: this
 * is a decision, not a side effect, and `state/landing.ts` should have nothing
 * left to test but which opener it called.
 */
import type { LandingTarget, ResolvedVaultSettings } from '@holi/shared'

/** What the vault actually holds, as the snapshot sees it. Sets rather than
 *  arrays: this runs once per vault open, but a linear scan per lookup is a
 *  cost with no upside. */
export interface VaultContents {
  docPaths: ReadonlySet<string>
  appIds: ReadonlySet<string>
}

type LandingSettings = Pick<ResolvedVaultSettings, 'landing' | 'dailyNotes'>

/**
 * The target to actually open, with rot already collapsed — or `null` for
 * "land on nothing", which is one empty pane and a legitimate answer.
 *
 * **The fallback is re-resolution, not a hardcoded daily.** A target that has
 * rotted falls back to what the vault would have done with no `landing` at all,
 * which in a vault that keeps no daily notes is *nothing*. Returning
 * `{kind:'daily'}` here would hand a daily note to a vault that was asked and
 * said no — and it would do it only on the days something was missing, which is
 * the kind of bug nobody reproduces.
 *
 * Rot degrades to the ordinary thing and never to an error: the same trade D82
 * accepted for a moved file's icon.
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
      return vault.appIds.has(landing.appId)
        ? { kind: 'app', appId: landing.appId }
        : resolveLanding({ landing: { kind: 'daily' }, dailyNotes }, vault)

    // The unique surfaces point at nothing on disk, so there is nothing to rot
    // and `dailyNotes` has no bearing on them: a vault with daily notes off
    // still opens its board.
    default:
      return { kind: landing.kind }
  }
}
