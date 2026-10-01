/**
 * Vault apps' main side (docs/features/vault-apps.md): the `holi-app:` scheme
 * that serves each app from its own bundle, the app door with this machine's
 * approvals of apps' Google reads, and the `apps.*` and `store.*`
 * capabilities. It seeds the vault-apps skill and the check hook.
 *
 * What a synced vault holds of an app stays core whatever this machine runs:
 * the record merge driver, the `.local.app` never-commit rule and the `data/`
 * fences.
 */
import { join } from 'node:path'
import type { AppDoor, MainPlugin } from '../../../main/plugin-api'
import { APPS_INFO } from '../info'
import { appsCapabilities, storeCapabilities } from './capabilities'
import { admitApps, createAppGrants } from './grants'
import { appScheme } from './protocol'
import { appsSeed } from './seed'

export const appsMain: MainPlugin = {
  info: APPS_INFO,
  seed: appsSeed,
  schemes: [appScheme],
  activateApp(ctx) {
    // Kept in main, never the renderer, which is the process running the
    // apps' code.
    const grants = createAppGrants(join(ctx.userData, 'app-grants.json'))
    // The app door's one opener: the approvals an entry's `appGrant` asks for.
    const door: AppDoor = ctx.openAppDoor({ admit: admitApps(grants) })
    ctx.register(['apps'], appsCapabilities({ events: ctx, appDoor: () => door, grants }))
    ctx.register(['store'], storeCapabilities())
    return () => {}
  },
}
