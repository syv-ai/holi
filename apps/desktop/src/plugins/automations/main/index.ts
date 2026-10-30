/**
 * The automations plugin's main side (docs/features/scheduled-agents.md):
 * the open vault's automations, checked every half minute, each run a
 * background session through the agent, which it requires. An automation a
 * Holi carries out gets that Holi from the Holis plugin (`holis.context`).
 *
 * It hears the agent's session list and turn ends (`ctx.hear`), which is how
 * a run is closed once it is done, and the vault's events and scans
 * (`ctx.events`, `ctx.onSnapshot`), which start the runs of automations with
 * an `on:`.
 */
import { join } from 'node:path'
import { jsonFileStore, readVaultSettings, type MainPlugin } from '../../../main/plugin-api'
import { AUTOMATIONS_INFO } from '../info'
import { automationsSeed } from './seed'
import { scheduleCapabilities, SCHEDULE_NAMESPACES } from './capabilities'
import {
  createScheduler,
  parseSchedulesFile,
  type HoliContext,
  type SessionSummary,
} from './scheduler'

type Result = { ok: true } | { ok: false; message: string }

export const automationsMain: MainPlugin = {
  info: AUTOMATIONS_INFO,
  seed: automationsSeed,
  async activate(ctx) {
    let live: SessionSummary[] = []
    ctx.hear('agent', 'sessions', (list) => {
      if (Array.isArray(list)) live = list as SessionSummary[]
    })
    // Which automations this machine runs, and what they did: outside the
    // vault, where the agent cannot approve its own (`scheduler.ts`).
    const scheduler = createScheduler({
      store: jsonFileStore(join(ctx.userData, 'schedules.json'), parseSchedulesFile),
      provider: async (root) => (await readVaultSettings(root)).agentProvider,
      sessions: {
        launch: async ({ provider, allow, ...args }) =>
          (await ctx.call('agent.launch', {
            ...args,
            provider,
            ...(provider === 'claude' && allow !== undefined ? { allow } : {}),
          })) as { ok: true; sessionId: string } | { ok: false; message: string },
        sessions: () => live,
        stop: async (id) => (await ctx.call('agent.stop', { id })) as Result,
        watched: async (id) => (await ctx.call('agent.watched', { id })) === true,
        onTurnEnd: (listener) =>
          ctx.hear('agent', 'turn-end', (p) => {
            const end = p as { id?: unknown; pending?: unknown }
            if (typeof end?.id !== 'string') return
            listener(end.id, typeof end.pending === 'number' ? end.pending : null)
          }),
      },
      emit: ctx.emit,
      holi: async (_vault, id) => (await ctx.call('holis.context', { holi: id })) as HoliContext,
      // What the automations' triggers listen for, to the plugins that source it.
      tell: (event) => ctx.events.emit(event),
      // Where a run's last turn ended, so a file someone else changed while
      // it worked can start a follow-up.
      lastTurnAt: async (jobId) => {
        const turns = (await ctx.call('agent.turns', {})) as { at: string; sessionId?: string }[]
        const turn = Array.isArray(turns) ? turns.find((t) => t.sessionId === jobId) : undefined
        return turn === undefined ? null : Date.parse(turn.at)
      },
    })
    ctx.register(SCHEDULE_NAMESPACES, scheduleCapabilities({ scheduler }))
    // The events that start runs: what the vault's plugins tell, and the
    // files that change between scans.
    const unevents = ctx.events.on((event) => scheduler.hear(event))
    const unscan = ctx.onSnapshot((snapshot) => scheduler.snapshot(snapshot))
    // The list as it is when this starts; the agent's news keeps it after.
    void ctx
      .call('agent.sessions', {})
      .then((list) => {
        if (Array.isArray(list)) live = list as SessionSummary[]
      })
      .catch(() => {})
    scheduler.attach({ remote: ctx.remote, root: ctx.root })
    return () => {
      unevents()
      unscan()
      scheduler.dispose()
    }
  },
}
