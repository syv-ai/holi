/**
 * The Holis plugin's main side (docs/features/holis.md): the vault's Holis,
 * their approvals and runs, and the commands their runs keep their memory
 * with. A send runs through the agent (`agent.launch`, `agent.job` on
 * Codex), which it requires.
 *
 * The plugin stays importable under plain Node.
 */
import { join } from 'node:path'
import { jsonFileStore, readVaultSettings, type MainPlugin } from '../../../main/plugin-api'
import { HOLIS_INFO } from '../info'
import { holisSeed } from './seed'
import { holiCapabilities, HOLI_NAMESPACES } from './capabilities'
import { createHolis, parseHolisFile, type NeedsYou } from './holis'

type Launched = { ok: true; sessionId: string } | { ok: false; message: string }

export const holisMain: MainPlugin = {
  info: HOLIS_INFO,
  seed: holisSeed,
  async activate(ctx) {
    let draining = false
    let beginDrain!: () => void
    const drainStarted = new Promise<void>((resolve) => {
      beginDrain = resolve
    })
    const notify = (n: NeedsYou, lease: () => boolean): void => {
      if (ctx.activationSignal.aborted || !lease()) return
      ctx.notify({
        title: `${n.name} needs you`,
        body: n.text,
        navigate: { name: 'holi-open', payload: { holi: n.id } },
      })
    }
    // Which Holis this machine approved, and their runs: outside the vault,
    // where the agent cannot approve its own (`holis.ts`).
    const holis = createHolis({
      store: jsonFileStore(join(ctx.userData, 'holis.json'), parseHolisFile),
      provider: async (root) => (await readVaultSettings(root)).agentProvider,
      launch: async ({ provider, allow, ...args }) =>
        (await (provider === 'codex'
          ? // Codex runs it as a job in the vault, its writable folders the
            // ones `allow` names (`agent.job`).
            ctx.call('agent.job', {
              ...args,
              provider,
              ...(allow === undefined ? {} : { allow }),
            })
          : ctx.call('agent.launch', {
              ...args,
              provider,
              ...(provider === 'claude' && allow !== undefined ? { allow } : {}),
            }))) as Launched,
      emit: ctx.emit,
      needsYou: notify,
      presentationLease: ctx.presentationLease,
      cleanupLaunch: async (_vault, sessionId) => {
        if (ctx.activationSignal.aborted && !draining) await drainStarted
        const result = (await ctx.call('agent.stop', { id: sessionId })) as
          { ok: true } | { ok: false; message: string }
        if (!result.ok) throw new Error(result.message)
      },
      activationSignal: ctx.activationSignal,
    })
    ctx.register(
      HOLI_NAMESPACES,
      holiCapabilities({ holis, changed: (remote) => ctx.emit(remote, 'holis', null) }),
    )
    return () => {
      draining = true
      beginDrain()
      return holis.stop()
    }
  },
}
