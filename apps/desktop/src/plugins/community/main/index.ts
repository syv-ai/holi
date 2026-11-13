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
  runChecks,
  seedRunningApps,
  unlinkWhenOff,
} from './capabilities'
import { createChecks } from './checks'
import { pluginsDir } from './store'
import { communityOwner } from './owner'

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
    const owner = communityOwner({ userData: ctx.userData })
    const { store, consent, supervisor: servers } = owner
    const checks = createChecks()
    const detach = owner.attach(ctx.root, ctx.remote, {
      emit: ctx.emit,
      frameOrigin: ctx.frameOrigin,
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
        mutate: owner.mutate,
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
      // Stopping stops its servers: the tabs on them are gone too. And any
      // check still running.
      checks.stop()
      await detach()
      await unlinkWhenOff(ctx.root, installedInfos())
    }
  },
}
