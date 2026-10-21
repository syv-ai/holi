/**
 * Community plugins' main side (docs/features/community-plugins.md): this
 * machine's installs and consents in `userData`, the `community.*`
 * capabilities the settings tab and the plugin tab call, and the servers they
 * start. No plugin's code loads here: each runs as its own process.
 */
import { join } from 'node:path'
import { resolvePlugins } from '@holi/shared'
import {
  installedInfos,
  readVaultSettings,
  remoteUrl,
  type MainPlugin,
} from '../../../main/plugin-api'
import { COMMUNITY_INFO } from '../info'
import {
  COMMUNITY_NAMESPACES,
  communityCapabilities,
  linkRunningCommands,
  parseServerKey,
  seedRunningApps,
} from './capabilities'
import { unlinkCommands } from './commands'
import { createConsentStore } from './consent'
import { createInstallStore, pluginsDir } from './store'
import { createSupervisor } from './supervisor'

export const communityMain: MainPlugin = {
  info: COMMUNITY_INFO,
  // `holi community path` only reads where a plugin is, so it does not ask.
  seed: {
    id: 'community',
    once: {},
    shipped: {},
    fragments: {
      '.claude/settings.json': [{ permissions: { allow: ['Bash(holi community path:*)'] } }],
    },
  },
  activate(ctx) {
    const store = createInstallStore(ctx.userData)
    const consent = createConsentStore(join(ctx.userData, 'plugin-consent.json'))
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
    ctx.register(
      COMMUNITY_NAMESPACES,
      communityCapabilities({
        store,
        consent,
        supervisor: servers,
        git: { url: remoteUrl, token: ctx.githubToken },
        token: ctx.githubToken,
        firstPartyIds: () => installedInfos().map((p) => p.id),
        emit: ctx.emit,
        bridgeScript: () => null,
        scratch: join(pluginsDir(ctx.userData), '.staging'),
      }),
    )
    // A running plugin's apps that this vault (or, for a `.local.app`, this
    // machine) does not have yet.
    void seedRunningApps(ctx.root, { store, consent }).catch((err) =>
      console.error('[community] apps:', err),
    )
    // Its running plugins' commands, as this machine has them now.
    void linkRunningCommands(ctx.root, { store, consent })
    return async () => {
      // Stopping stops its servers: the tabs on them are gone too.
      await servers.stopAll()
      // Turned off in the vault, its plugins' commands go too. Not when the
      // vault is left or Holi quits: the vault's background sessions still
      // run, and its next open links them again anyway.
      const settings = await readVaultSettings(ctx.root).catch(() => null)
      if (settings === null) return
      if (resolvePlugins(settings.plugins, installedInfos()).running.has(COMMUNITY_INFO.id)) return
      await unlinkCommands(ctx.root).catch((err) => console.error('[community] commands:', err))
    }
  },
}
