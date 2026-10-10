/**
 * Community plugins' main side (docs/features/community-plugins.md): this
 * machine's installs and consents in `userData`, the `community.*`
 * capabilities the settings tab and the plugin tab call, and the servers they
 * start. No plugin's code loads here: each runs as its own process.
 */
import { join } from 'node:path'
import { installedInfos, remoteUrl, type MainPlugin } from '../../../main/plugin-api'
import { COMMUNITY_INFO } from '../info'
import { COMMUNITY_NAMESPACES, communityCapabilities, parseServerKey } from './capabilities'
import { createConsentStore } from './consent'
import { createInstallStore, pluginsDir } from './store'
import { createSupervisor, type Supervisor } from './supervisor'

let supervisor: Supervisor | null = null

export const communityMain: MainPlugin = {
  info: COMMUNITY_INFO,
  activateApp(ctx) {
    const store = createInstallStore(ctx.userData)
    const servers = createSupervisor({
      frameOrigin: ctx.frameOrigin,
      // Servers run only for the open vault; one stopping as it is left has
      // nobody to tell.
      onState: (key, state) => {
        const { root, id, path } = parseServerKey(key)
        const active = ctx.active()
        if (active !== null && active.root === root)
          ctx.emit(active.remote, 'server', { id, path, state })
      },
    })
    supervisor = servers
    ctx.register(
      COMMUNITY_NAMESPACES,
      communityCapabilities({
        store,
        consent: createConsentStore(join(ctx.userData, 'plugin-consent.json')),
        supervisor: servers,
        git: { url: remoteUrl, token: ctx.githubToken },
        token: ctx.githubToken,
        firstPartyIds: () => installedInfos().map((p) => p.id),
        emit: ctx.emit,
        bridgeScript: () => null,
        scratch: join(pluginsDir(ctx.userData), '.staging'),
      }),
    )
    return async () => {
      await servers.stopAll()
      supervisor = null
    }
  },
  activateVault() {
    // Leaving the vault stops its servers: the tabs on them are gone too.
    return async () => {
      await supervisor?.stopAll()
    }
  },
}
