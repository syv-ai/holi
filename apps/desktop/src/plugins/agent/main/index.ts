/**
 * The agent's main side (docs/features/agent-sessions.md): any number of live
 * sessions, all in the open vault's clone. The host (`host/`) owns the PTYs,
 * the turn coordinator and turn review; Claude Code is the provider
 * (`claude/`).
 *
 * It starts in a vault with its capabilities, events and hook routes and
 * attaches to the vault; stopping (turned off, the vault left, Holi quitting)
 * stops its sessions and terminals, and the quick agent with them. Quitting
 * asks first while a session is busy.
 *
 * Electron loads inside `activate`, so the plugin stays importable under
 * plain Node in the tests.
 */
import { join } from 'node:path'
import { jsonFileStore, type MainPlugin } from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { claudeProvider } from './claude'
import { claudeSeed } from './claude/seed'
import { agentCapabilities, AGENT_NAMESPACES } from './host/capabilities'
import { createQuestionDesk } from './host/questions'
import { createAgentSessions } from './host/sessions'
import { createAgentTerminals } from './host/terminals'
import { openTurnLog } from './host/turn-log'
import { worktreeEnd } from './host/worktree-end'
import { inboxCapabilities } from './inbox/capabilities'
import { createInbox } from './inbox/inbox'
import { mentionNotice } from './inbox/mentions'
import { watchNeedsYou } from './inbox/needs-you'
import { INBOX_FILE, parseInbox } from './inbox/rules'
import { sweepAgentMemory, SWEEP_EVERY_MS } from './memory/sweep'
import { startQuickAgent, type QuickAgent } from './quick'
import { quickCapabilities } from './quick/capabilities'
import { scheduleCapabilities, SCHEDULE_NAMESPACES } from './schedules/capabilities'
import { createScheduler, parseSchedulesFile } from './schedules/scheduler'

export const agentMain: MainPlugin = {
  info: AGENT_INFO,
  seed: claudeSeed,
  async activate(ctx) {
    const { nativeTheme } = await import('electron')
    const provider = claudeProvider({
      userData: ctx.userData,
      holiBin: () => join(ctx.binDir(), 'holi'),
      systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
    })
    const terminals = createAgentTerminals({ emit: ctx.emit, command: provider.terminal })
    const liveRemote = (): string | null => ctx.active()?.remote ?? null
    let quick: QuickAgent | null = null
    // The questions quick agents wait on (docs/features/quick-agent.md). Each
    // change re-reads the list (a held question is needs-you), the panels,
    // and the cards over the main window's tabs.
    const desk = createQuestionDesk({
      onChange: (pending) => {
        started.touch()
        quick?.update()
        ctx.emit(ctx.remote, 'questions', pending)
      },
    })
    const started = createAgentSessions({
      emit: ctx.emit,
      provider,
      terminals,
      binDir: ctx.binDir,
      // What each turn changed, as a commit range, in the vault it ran in.
      turnLogFor: openTurnLog,
      pendingQuestion: (job) => desk.has(job),
      snapshot: worktreeEnd,
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
        terminals,
        liveRemote,
        commitNow: () => ctx.commitNow(),
      }),
      ...quickCapabilities({ desk, quick: () => quick, liveRemote }),
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
    // Which schedules this machine runs, and what they did: outside the
    // vault, where the agent cannot approve its own (`schedules/scheduler.ts`).
    const schedules = createScheduler({
      store: jsonFileStore(join(ctx.userData, 'schedules.json'), parseSchedulesFile),
      sessions: started,
      emit: ctx.emit,
      // What the schedules' triggers listen for, to the plugins that source it.
      tell: (event) => ctx.events.emit(event),
      // Where a run's last turn ended, so a file someone else changed while
      // it worked can start a follow-up.
      lastTurnAt: async (jobId) => {
        const turn = (await openTurnLog(ctx.root).list()).find((t) => t.sessionId === jobId)
        return turn === undefined ? null : Date.parse(turn.at)
      },
    })
    ctx.register(SCHEDULE_NAMESPACES, scheduleCapabilities({ scheduler: schedules }))
    // The events that start schedules' runs: what the vault's plugins tell,
    // and the files that change between scans.
    ctx.events.on((event) => schedules.hear(event))
    ctx.onSnapshot((snapshot) => schedules.snapshot(snapshot))
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
      onJobTurn: (remote, jobId, active, pending) =>
        started.noteTurn(remote, jobId, active, pending),
      // A session's status line: how much of its context is used.
      onStatus: (remote, jobId, status) => started.noteStatus(remote, jobId, status),
      // Where a session takes messages: its inbox socket, kept in memory.
      onChannel: (remote, jobId, channel) => started.noteChannel(remote, jobId, channel),
      // A quick agent's question, held until the person answers. Any other
      // session's (one from before a restart, say) is Claude Code's to ask.
      onAsk: (remote, jobId, input, signal) =>
        remote === liveRemote() && quick?.owns(jobId) === true
          ? desk.ask(jobId, input, signal)
          : Promise.resolve(null),
      // A quick agent's answer, for its panel.
      onQuickResult: (remote, jobId, message) => {
        if (remote === liveRemote()) quick?.result(jobId, message)
      },
    })
    // Every listing read moves the quick panels' lights. A question whose
    // session is no longer running has nobody left to answer it: the stop
    // ended its hook, and this lets go of one that outlived the stop.
    const unrows = started.onRows(() => {
      for (const { job } of desk.pending()) {
        const row = started.row(job)
        if (row !== undefined && !provider.isLive(row)) desk.release(job)
      }
      quick?.update()
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
    void started.ensure(ctx)
    // The open vault's schedules run while it is open.
    schedules.attach({ remote: ctx.remote, root: ctx.root })
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
    // The quick agent: the global hotkey and its panel, while this vault is
    // open. A failure costs that feature, never the agent.
    quick = await startQuickAgent({ ctx, sessions: started, terminals, desk }).catch(
      (err: unknown) => {
        console.error('[agent] quick agent did not start:', err)
        return null
      },
    )
    // Stopping stops the vault's sessions (the renderer asked first if one
    // was busy). They stay in the agents list and resume when opened.
    return async () => {
      unrows()
      quick?.dispose()
      quick = null
      schedules.dispose()
      clearInterval(sweepTimer)
      await sweeping
      unreport()
      // Stopping a session ends its hook too; this is the backstop for one
      // that outlives the stop.
      desk.releaseAll()
      unmention()
      unwatchNeedsYou()
      await started.leave().catch((err) => console.error('[agent] leave failed:', err))
      await terminals.closeAll().catch((err) => console.error('[agent] terminals:', err))
    }
  },
}
