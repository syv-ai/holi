/**
 * Community plugins' main side (docs/features/community-plugins.md): this
 * machine's installs and consents in `userData`, the `community.*`
 * capabilities the settings tab and the plugin tab call, and the servers they
 * start. No plugin's code loads here: each runs as its own process.
 */
/// <reference types="electron-vite/node" />
import { join } from 'node:path'
import { communityPluginsSignature } from '@holi/shared'
import { installedInfos, remoteUrl, type MainPlugin } from '../../../main/plugin-api'
import { COMMUNITY_INFO } from '../info'
import hintBridge from '../shared/hint-bridge.js?asset&asarUnpack'
import {
  COMMUNITY_NAMESPACES,
  communityCapabilities,
  linkRunningCommands,
  refreshInstalledPins,
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
    const { store, consent } = owner
    const checks = createChecks()
    const attachment = owner.attach(ctx.root, ctx.remote, {
      activationSignal: ctx.activationSignal,
      emit: ctx.emit,
      frameOrigin: ctx.frameOrigin,
      forgetCheck: (id) => checks.forget(ctx.root, id),
    })
    attachment.signal.addEventListener(
      'abort',
      () => {
        void checks.stop()
      },
      { once: true },
    )
    ctx.register(
      COMMUNITY_NAMESPACES,
      communityCapabilities({
        ...owner,
        context: { root: ctx.root, remote: ctx.remote },
        git: { url: remoteUrl, token: ctx.githubToken },
        token: ctx.githubToken,
        firstPartyIds: () => installedInfos().map((p) => p.id),
        bridgeScript: () => hintBridge,
        scratch: join(pluginsDir(ctx.userData), '.staging'),
        checks,
        signal: attachment.signal,
        live: attachment.isLive,
        run: (work) => attachment.run(() => work()),
        emit: (remote, name, payload) => {
          if (attachment.isLive()) ctx.emit(remote, name, payload)
        },
      }),
    )
    // What runs here follows the vault: at the start, and whenever a pin or
    // the plugins settings change on disk (the settings tab's write, a pull,
    // a hand edit). A running plugin's apps that this vault (or, for a
    // `.local.app`, this machine) does not have yet, and its commands; the
    // renderer reads the rows again once they are linked. And the readiness
    // check of each running plugin not asked yet: every one as the vault
    // opens, and one just turned on.
    const refresh = async (signal: AbortSignal) => {
      await owner.admit(async () => {
        if (signal.aborted) return
        await refreshInstalledPins(ctx.root, {
          store,
          consent,
          git: { url: remoteUrl, token: ctx.githubToken },
          signal,
        })
        if (signal.aborted) return
        await seedRunningApps(ctx.root, {
          store,
          consent,
          signal,
          live: attachment.isLive,
        })
        if (signal.aborted) return
        await linkRunningCommands(ctx.root, { store, consent })
        if (!signal.aborted) ctx.emit(ctx.remote, 'commands', null)
      })
      if (signal.aborted) return
      const asked = await runChecks(ctx.root, { ...owner, checks, signal }, { passive: true })
      if (asked && !signal.aborted) ctx.emit(ctx.remote, 'check', null)
    }
    const follow = () =>
      attachment.refresh(refresh).catch((err) => {
        if (!attachment.signal.aborted) console.error('[community] refresh:', err)
      })
    attachment.observeMutations(refresh)
    void follow()
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
      await attachment.close(async () => {
        const [proof] = await Promise.allSettled([checks.stop()])
        // Revoking command links does not depend on proof of physical drain.
        try {
          await unlinkWhenOff(ctx.root, installedInfos())
        } catch (error) {
          if (proof.status === 'fulfilled') throw error
          console.error('[community] commands:', error)
        }
        if (proof.status === 'rejected') throw proof.reason
      })
    }
  },
}
