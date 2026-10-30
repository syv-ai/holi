/**
 * The agent's main side (docs/features/agent-sessions.md): any number of live
 * sessions, all in the open vault's clone. The host (`host/`) owns the PTYs,
 * the turn coordinator and turn review; Claude Code is the provider
 * (`claude/`).
 *
 * It starts in a vault with its capabilities, events and hook routes and
 * attaches to the vault; stopping (turned off, the vault left, Holi quitting)
 * stops its sessions and terminals. Quitting asks first while a session is
 * busy.
 *
 * Electron loads inside `activate`, so the plugin stays importable under
 * plain Node in the tests.
 */
import { join } from 'node:path'
import { jsonFileStore, resolveBin, type MainPlugin } from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { claudeProvider } from './claude'
import { claudeSeed } from './claude/seed'
import { codexProvider } from './codex'
import { piProvider } from './pi'
import { createPiBackground } from './pi/background'
import { agentCapabilities, AGENT_NAMESPACES } from './host/capabilities'
import { createPtySessions, PTY_SESSION_ID } from './host/pty-sessions'
import { createAgentSessions } from './host/sessions'
import { createAgentTerminals } from './host/terminals'
import { openTurnLog } from './host/turn-log'
import { createSessionLog } from './host/session-log'
import { worktreeEnd } from './host/worktree-end'
import { inboxCapabilities } from './inbox/capabilities'
import { createInbox } from './inbox/inbox'
import { mentionNotice } from './inbox/mentions'
import { watchNeedsYou } from './inbox/needs-you'
import { INBOX_FILE, parseInbox } from './inbox/rules'
import { sweepAgentMemory, SWEEP_EVERY_MS } from './memory/sweep'
import type { SessionSummary } from './claude/listing'
import { hasBackground } from './provider'

export const agentMain: MainPlugin = {
  info: AGENT_INFO,
  seed: claudeSeed,
  async activate(ctx) {
    const { nativeTheme } = await import('electron')
    const claude = claudeProvider({
      userData: ctx.userData,
      holiBin: () => join(ctx.binDir(), 'holi'),
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
    })
    const providers = [claude, codexProvider(), piProvider()]
    const terminals = createAgentTerminals({ emit: ctx.emit })
    const sessionLog = createSessionLog(ctx.log)
    const liveRemote = (): string | null => ctx.active()?.remote ?? null

    // One list for the renderer and the plugins built on the agent: the
    // background sessions Claude Code's supervisor runs, then the ones Holi
    // runs itself.
    let background: SessionSummary[] = []
    let piSessions: SessionSummary[] = []
    let own: SessionSummary[] = []
    const pushSessions = (): void => {
      const all = [...background, ...piSessions, ...own]
      ctx.emit(ctx.remote, 'sessions', all)
      ctx.publish('sessions', all)
      sessionLog.sessions(all)
    }

    const started = createAgentSessions({
      emit: (remote, name, payload) => {
        if (name !== 'sessions') return ctx.emit(remote, name, payload)
        background = payload as SessionSummary[]
        pushSessions()
      },
      // Each turn's end, for the plugins built on the agent (automations
      // close a run once it is done), and for the activity log.
      publish: (name, payload) => {
        if (name !== 'turn-end') return
        ctx.publish(name, payload)
        sessionLog.turnEnd((payload as { id: string }).id)
      },
      provider: claude,
      terminals,
      binDir: ctx.binDir,
      // What each turn changed, as a commit range, in the vault it ran in.
      turnLogFor: openTurnLog,
      snapshot: worktreeEnd,
    })
    const piBackground = createPiBackground({
      bin: () => resolveBin('pi'),
      bracket: (id, edge) => started.bracket(id, edge),
      changed: () => {
        piSessions = piBackground.sessions()
        pushSessions()
      },
    })
    piBackground.setVault(ctx.remote, ctx.root)
    const ptySessions = createPtySessions({
      vault: { remote: ctx.remote, root: ctx.root },
      providers: providers.filter((p) => !hasBackground(p)),
      terminals,
      // Its turns pause sync and are recorded like a background session's.
      bracket: (id, edge) => started.bracket(id, edge),
      binDir: ctx.binDir,
      onChange: (list) => {
        own = list
        pushSessions()
      },
    })
    // What the agent and Holi want the person to see: an entry in the
    // vault's inbox, and a banner while Holi is out of sight.
    const inbox = createInbox({
      store: jsonFileStore(join(ctx.root, INBOX_FILE), parseInbox),
      notify: (notice) => ctx.notify(notice),
      changed: (view) => ctx.emit(ctx.remote, 'inbox', view),
      open: (entry) => ctx.emit(ctx.remote, 'inbox-open', entry),
    })
    ctx.register(AGENT_NAMESPACES, {
      ...agentCapabilities({
        sessions: started,
        own: ptySessions,
        providers,
        terminals,
        liveRemote,
        commitNow: () => ctx.commitNow(),
        pi: piBackground,
      }),
      ...inboxCapabilities({ inbox, liveRemote }),
    })
    const unwatchNeedsYou = watchNeedsYou({
      sessions: started,
      focused: () => ctx.focused(),
      told: async () => (await inbox.view()).entries.flatMap((e) => e.session ?? []),
      raise: (notice) => inbox.raise(notice),
      log: (msg) => console.error(`[agent] ${msg}`),
    })
    // A teammate's comment that mentions the person, found after a pull.
    const unmention = ctx.onMention((mention) => {
      void inbox
        .raise(mentionNotice(mention))
        .catch((err: unknown) => console.error('[agent] mention:', err))
    })
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
    // Each provider's hooks, by the session id they carry: a session Holi
    // runs, or a background job.
    for (const p of providers) {
      p.capabilities.turns?.routes(ctx, {
        onTurn: (remote, id, active, pending) => {
          if (!PTY_SESSION_ID.test(id)) return started.noteTurn(remote, id, active, pending)
          if (remote === ctx.remote) ptySessions.noteTurn(id, active)
        },
        // A session's status line: how much of its context is used.
        onStatus: (remote, id, status) => started.noteStatus(remote, id, status),
        onConversation: (remote, id, about) => {
          if (remote === ctx.remote) ptySessions.noteConversation(id, about)
        },
        // Where a background session takes messages: its inbox socket, kept
        // in memory.
        onChannel: (remote, id, channel) => started.noteChannel(remote, id, channel),
      })
    }
    // Quitting stops the vault's sessions, so it asks first when one of them
    // is working or waiting on you: that turn is cut short. Idle sessions
    // stop without a question; their conversations stay in the agents list.
    ctx.guardQuit(() => {
      const busy = [
        ...started.sessions(),
        ...piBackground.sessions(),
        ...ptySessions.sessions(),
      ].filter((s) => s.state !== 'idle')
      if (busy.length === 0) return null
      const one = busy.length === 1
      return {
        message: one ? `Quit and stop ${busy[0]!.name}?` : `Quit and stop ${busy.length} sessions?`,
        detail: `${one ? 'Its' : 'Their'} current turn is cut short.`,
      }
    })
    void started.ensure(ctx)
    // Expired personal memories and old work-log days go, now and hourly. The
    // running sweep is kept so leaving the vault waits for it to finish.
    let sweeping: Promise<unknown> = Promise.resolve()
    const sweep = (): void => {
      sweeping = sweeping.then(() =>
        sweepAgentMemory(ctx.root, new Date()).catch((err: unknown) =>
          console.error('[agent] memory sweep:', err),
        ),
      )
    }
    sweep()
    const sweepTimer = setInterval(sweep, SWEEP_EVERY_MS)
    sweepTimer.unref?.()
    // The per-turn hook reads the focused note, and its selected lines, from a
    // file in this clone.
    const unreport = ctx.onReport((report) =>
      started.setFocus({
        focusedPath: report.focusedPath,
        selection: report.selection,
        openPaths: report.openPaths,
      }),
    )
    // Stopping stops the vault's sessions (the renderer asked first if one
    // was busy). Background ones stay in the agents list and resume when
    // opened; the ones Holi runs end with it.
    return async () => {
      clearInterval(sweepTimer)
      await sweeping
      unreport()
      unmention()
      unwatchNeedsYou()
      await ptySessions.leave().catch((err) => console.error('[agent] pty sessions:', err))
      await piBackground.leave().catch((err) => console.error('[agent] Pi sessions:', err))
      await started.leave().catch((err) => console.error('[agent] leave failed:', err))
      await terminals.closeAll().catch((err) => console.error('[agent] terminals:', err))
    }
  },
}
