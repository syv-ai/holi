/**
 * Vault apps' renderer side (docs/features/vault-apps.md): the `app` surface
 * with a tab per bundle, the claim that makes a bundle one document in the
 * tree, the nav's Apps group, and the agent's `holi apps open`.
 */
import { activeRemoteAtom, openSurfaceAtom, type RendererPlugin } from '@/plugin-api'
import { APPS_INFO } from '../info'
import { appOpensAtom } from './apps'
import { APP_CLAIM, APP_RAIL, APP_SURFACE } from './surface'

export const appsRenderer: RendererPlugin = {
  info: APPS_INFO,
  surfaces: [APP_SURFACE],
  claims: [APP_CLAIM],
  rail: [APP_RAIL],
  events: {
    /**
     * The agent's `holi apps open`: open the app, or reload it when it is
     * open. Local authorship only: apps sync, so opening a tab whenever one
     * appears would let a teammate's finished app decide what is on your
     * screen. An event about another vault is dropped.
     */
    open: ({ remote, payload }, store) => {
      if (remote !== store.get(activeRemoteAtom)) return
      const { bundle } = payload as { bundle: string }
      store.set(openSurfaceAtom, 'app', bundle)
      store.set(appOpensAtom, (n) => ({ ...n, [bundle]: (n[bundle] ?? 0) + 1 }))
    },
  },
}
