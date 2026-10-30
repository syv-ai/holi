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
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { jsonFileStore, readVaultSettings, type MainPlugin } from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { claudeProvider } from './claude'
import { resolveClaudeBin } from './claude/cli'
import { claudeSeed } from './claude/seed'
import { codexProvider, resolveCodexBin } from './codex'
import { harnessCapabilities } from './harness/capabilities'
import { isIntegration, parseHarnessFile } from './harness/record'
import { createHarnessRegistry, withPreset } from './harness/registry'
import { installSignalCommand, registerSignalRoute } from './harness/signal'
import { piProvider, resolvePiBin } from './pi'
import { agentCapabilities, AGENT_NAMESPACES } from './host/capabilities'
import { createPtySessions, parsePastFile, PTY_SESSION_ID } from './host/pty-sessions'
import { createFencedSessions } from './host/fenced'
import { createJobs } from './host/jobs'
import { createUnattendedStore } from './host/unattended'
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
    // This machine's agents: the built-in three, each reading its preset as
    // it runs, and the ones a person added in Settings
    // (docs/features/agent-sessions.md, Harnesses).
    const harnessFile = join(ctx.userData, 'agent-harnesses.json')
    const harnesses = await createHarnessRegistry({
      store: jsonFileStore(harnessFile, parseHarnessFile),
      // What Holi could not read in the file is kept beside it before a write.
      keepBad: () =>
        copyFile(harnessFile, `${harnessFile}.bad`).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        }),
      bins: {
        claude: () => resolveClaudeBin(),
        codex: () => resolveCodexBin(),
        pi: () => resolvePiBin(),
      },
      builtIns: {
        claude: (current, bin) =>
          withPreset(
            claudeProvider({
              userData: ctx.userData,
              holiBin: () => join(ctx.binDir(), 'holi'),
              systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
              resolveBin: bin,
            }),
            current,
          ),
        codex: (current, bin) =>
          withPreset(codexProvider({ resolveBin: bin, env: () => current().env ?? {} }), current),
        pi: (current, bin) =>
          withPreset(piProvider({ resolveBin: bin, env: () => current().env ?? {} }), current),
      },
    })
    const providers = (): ReturnType<typeof harnesses.providers> => harnesses.providers()
    const claude = providers().find(hasBackground)!
    // `holi-signal`, the hook command a harness a person added reports
    // its turns with.
    await installSignalCommand(ctx.binDir()).catch((err: unknown) =>
      console.error('[agent] holi-signal:', err),
    )
    const terminals = createAgentTerminals({ emit: ctx.emit })
    const sessionLog = createSessionLog(ctx.log)
    const liveRemote = (): string | null => ctx.active()?.remote ?? null

    // One list for the renderer and the plugins built on the agent: the
    // background sessions Claude Code's supervisor runs, then the ones Holi
    // runs itself, then its jobs.
    let background: SessionSummary[] = []
    let own: SessionSummary[] = []
    let jobRows: SessionSummary[] = []
    // History likewise: the background sessions stopped, then the closed
    // ones Holi ran.
    let backgroundPast: SessionSummary[] = []
    let ownPast: SessionSummary[] = []
    const pushPast = (): void => ctx.emit(ctx.remote, 'history', [...backgroundPast, ...ownPast])
    const pushSessions = (): void => {
      const all = [...background, ...own, ...jobRows]
      ctx.emit(ctx.remote, 'sessions', all)
      ctx.publish('sessions', all)
      sessionLog.sessions(all)
    }

    const started = createAgentSessions({
      emit: (remote, name, payload) => {
        if (name === 'history' && remote === ctx.remote) {
          backgroundPast = payload as SessionSummary[]
          return pushPast()
        }
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
    // The closed sessions Holi ran, kept on this machine for History.
    const pastFile = jsonFileStore(join(ctx.userData, 'agent-sessions.json'), parsePastFile)
    // Which vaults this machine lets Codex run unattended in.
    const unattended = createUnattendedStore(join(ctx.userData, 'agent-unattended.json'))
    const ptySessions = createPtySessions({
      vault: { remote: ctx.remote, root: ctx.root },
      past: {
        read: async () => (await pastFile.read())[ctx.remote] ?? [],
        write: async (list) => {
          await pastFile.update((all) => ({ ...all, [ctx.remote]: list }))
        },
      },
      providers: () => providers().filter((p) => !hasBackground(p)),
      terminals,
      // Its turns pause sync and are recorded like a background session's.
      bracket: (id, edge) => started.bracket(id, edge),
      binDir: ctx.binDir,
      onChange: (list) => {
        own = list
        pushSessions()
      },
      onPast: (list) => {
        ownPast = list
        pushPast()
      },
    })
    void ptySessions.past().then((list) => {
      ownPast = list
    })
    // Prompts run unwatched by a provider without a supervisor: in a scratch
    // folder of their own, or in the vault, whose turns pause sync and are
    // recorded like a session's.
    const jobs = createJobs({
      vault: { remote: ctx.remote, root: ctx.root },
      scratchRoot: join(ctx.userData, 'agent-jobs'),
      bracket: (id, edge) => started.bracket(id, edge),
      onChange: (list) => {
        jobRows = list
        pushSessions()
      },
    })
    // Sessions Holi runs fenced to a folder of its own, what they wrote
    // copied back as each turn ends.
    const fenced = createFencedSessions({
      vault: { remote: ctx.remote, root: ctx.root },
      scratchRoot: join(ctx.userData, 'agent-fenced'),
      own: ptySessions,
      copyBack: jobs.copyBack,
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
        jobs,
        fenced,
        providers,
        terminals,
        liveRemote,
        commitNow: () => ctx.commitNow(),
        defaultProvider: async () => (await readVaultSettings(ctx.root)).agentProvider,
        unattended,
      }),
      ...inboxCapabilities({ inbox, liveRemote }),
      ...harnessCapabilities({
        registry: harnesses,
        file: harnessFile,
        root: () => (liveRemote() === ctx.remote ? ctx.root : null),
        changed: () => ctx.emit(ctx.remote, 'providers', null),
      }),
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
    // runs, or a background job. The built-in ones are fixed, so their
    // routes are served once.
    for (const p of providers().filter((x) => x.custom !== true)) {
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
    // `holi-signal`, from a session of a harness a person added: whichever
    // of them wired it into their CLI's hooks. The built-in agents report
    // through their own hooks.
    const unsignal = registerSignalRoute(ctx, {
      onSignal: (remote, id, signal) => {
        if (remote !== ctx.remote) return
        const provider = ptySessions.providerOf(id)
        if (provider === null || isIntegration(provider)) return
        if (signal.kind === 'status') return ptySessions.noteStatus(id, signal)
        if (signal.conversationId !== undefined) {
          ptySessions.noteConversation(id, { conversationId: signal.conversationId })
        }
        ptySessions.noteTurn(id, false)
      },
    })
    // Quitting stops the vault's sessions, so it asks first when one of them
    // is working or waiting on you: that turn is cut short. Idle sessions
    // stop without a question; their conversations stay in the agents list.
    ctx.guardQuit(() => {
      const busy = [...started.sessions(), ...ptySessions.sessions(), ...jobs.sessions()].filter(
        (s) => s.state !== 'idle',
      )
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
      unsignal()
      await sweeping
      unreport()
      unmention()
      unwatchNeedsYou()
      // A fenced session still starting opens nothing now, or is one the
      // sessions' leave ends.
      await fenced.closing().catch((err) => console.error('[agent] fenced sessions:', err))
      await ptySessions.leave().catch((err) => console.error('[agent] pty sessions:', err))
      await fenced.leave().catch((err) => console.error('[agent] fenced sessions:', err))
      await jobs.leave().catch((err) => console.error('[agent] jobs:', err))
      await started.leave().catch((err) => console.error('[agent] leave failed:', err))
      await terminals.closeAll().catch((err) => console.error('[agent] terminals:', err))
    }
  },
}
