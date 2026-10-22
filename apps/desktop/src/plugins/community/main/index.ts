/**
 * Community plugins' main side (docs/features/community-plugins.md): this
 * machine's installs and consents in `userData`, the `community.*`
 * capabilities the settings tab and the plugin tab call, and the servers they
 * start. No plugin's code loads here: each runs as its own process.
 */
import { join } from 'node:path'
import { communityPluginsSignature } from '@holi/shared'
import { installedInfos, remoteUrl, type MainPlugin } from '../../../main/plugin-api'
import { COMMUNITY_INFO } from '../info'
import {
  COMMUNITY_NAMESPACES,
  communityCapabilities,
  linkRunningCommands,
  parseServerKey,
  runChecks,
  seedRunningApps,
  unlinkWhenOff,
} from './capabilities'
import { createChecks } from './checks'
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
    // Per activation, so per vault: switching vaults drops every answer.
    const checks = createChecks()
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
        checks,
      }),
    )
    // What runs here follows the vault: at the start, and whenever a pin or
    // the plugins settings change on disk (the settings tab's write, a pull,
    // a hand edit). A running plugin's apps that this vault (or, for a
    // `.local.app`, this machine) does not have yet, and its commands; the
    // renderer reads the rows again once they are linked. And the readiness
    // check of each running plugin not asked yet: every one as the vault
    // opens, and one just turned on.
    const follow = () => {
      void seedRunningApps(ctx.root, { store, consent }).catch((err) =>
        console.error('[community] apps:', err),
      )
      void linkRunningCommands(ctx.root, { store, consent }).then(() =>
        ctx.emit(ctx.remote, 'commands', null),
      )
      void runChecks(ctx.root, { store, consent, checks }).then((asked) => {
        if (asked) ctx.emit(ctx.remote, 'check', null)
      })
    }
    follow()
    let signature: string | null = null
    ctx.onSnapshot((snapshot) => {
      const next = communityPluginsSignature(snapshot.files)
      if (next === signature) return
      const first = signature === null
      signature = next
      if (!first) follow()
    })
    return async () => {
      // Stopping stops its servers: the tabs on them are gone too.
      await servers.stopAll()
      await unlinkWhenOff(ctx.root, installedInfos())
    }
  },
}
