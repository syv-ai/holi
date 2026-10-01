/**
 * The agent's main side (docs/features/agent-sessions.md): any number of live
 * sessions, all in the open vault's clone. The host (`host/`) owns the PTYs,
 * the turn coordinator and turn review; Claude Code is the provider
 * (`claude/`).
 *
 * It starts once per process with its capabilities, events and hook routes,
 * attaches to each vault once it is open and lets go when Holi leaves it, and
 * quitting asks first while a session is busy.
 *
 * Electron loads inside `activateApp`, so the plugin stays importable under
 * plain Node in the tests.
 */
import { join } from 'node:path'
import { CapabilityError, type MainPlugin, type VaultCtx } from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { claudeProvider } from './claude'
import { claudeSeed } from './claude/seed'
import { agentCapabilities, AGENT_NAMESPACES } from './host/capabilities'
import { createAgentSessions, type AgentSessions } from './host/sessions'
import { createAgentTerminals } from './host/terminals'
import { openTurnLog } from './host/turn-log'

let sessions: AgentSessions | null = null
/** The vault the agent is active in, for the capabilities that commit. */
let vault: VaultCtx | null = null

export const agentMain: MainPlugin = {
  info: AGENT_INFO,
  seed: claudeSeed,
  async activateApp(ctx) {
    const { nativeTheme } = await import('electron')
    const provider = claudeProvider({
      userData: ctx.userData,
      holiBin: () => join(ctx.binDir(), 'holi'),
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
    })
    const terminals = createAgentTerminals({ emit: ctx.emit, command: provider.terminal })
    const started = createAgentSessions({
      emit: ctx.emit,
      provider,
      terminals,
      binDir: ctx.binDir,
      // What each turn changed, as a commit range, in the vault it ran in.
      turnLogFor: openTurnLog,
    })
    sessions = started
    ctx.register(
      AGENT_NAMESPACES,
      agentCapabilities({
        sessions: started,
        terminals,
        liveRemote: () => ctx.active()?.remote ?? null,
        commitNow: async () => {
          if (vault === null) throw new CapabilityError('UNAVAILABLE', 'No vault is open.')
          return vault.commitNow()
        },
      }),
    )
    // Keystrokes and resizes, in the order they were typed. The host drops
    // any about a vault that is not the open one.
    ctx.on('pty-write', (_remote, payload) => {
      const p = payload as { id?: unknown; data?: unknown }
      if (typeof p?.id === 'string' && typeof p.data === 'string') terminals.write(p.id, p.data)
    })
    ctx.on('pty-resize', (_remote, payload) => {
      const p = payload as { id?: unknown; cols?: unknown; rows?: unknown }
      if (typeof p?.id === 'string' && typeof p.cols === 'number' && typeof p.rows === 'number') {
        terminals.resize(p.id, p.cols, p.rows)
      }
    })
    provider.routes(ctx, {
      // A turn edge in one of a vault's background sessions, by job id.
      onJobTurn: (remote, jobId, active) => started.noteTurn(remote, jobId, active),
      // A session's status line: how much of its context is used.
      onStatus: (remote, jobId, status) => started.noteStatus(remote, jobId, status),
    })
    // Quitting stops the vault's sessions, so it asks first when one of them
    // is working or waiting on you: that turn is cut short. Idle sessions
    // stop without a question; their conversations stay in the agents list.
    ctx.guardQuit(() => {
      const busy = started.sessions().filter((s) => s.state !== 'idle')
      if (busy.length === 0) return null
      const one = busy.length === 1
      return {
        message: one ? `Quit and stop ${busy[0]!.name}?` : `Quit and stop ${busy.length} sessions?`,
        detail: `${one ? 'Its' : 'Their'} current turn is cut short. The conversation${one ? '' : 's'} stay in the agents list.`,
      }
    })
    return () => {
      sessions = null
    }
  },
  activateVault(ctx) {
    const running = sessions
    if (running === null) return () => {}
    vault = ctx
    void running.ensure(ctx)
    // The per-turn hook reads the focused note from a file in this clone.
    const unreport = ctx.onReport((report) =>
      running.setFocus({ focusedPath: report.focusedPath, openPaths: report.openPaths }),
    )
    // A switch stops the vault's sessions (the renderer asked first if one
    // was busy). They stay in the agents list and resume when opened.
    return async () => {
      unreport()
      await running.leave().catch((err) => console.error('[agent] leave failed:', err))
      if (vault === ctx) vault = null
    }
  },
}
