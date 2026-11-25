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
import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  jsonFileStore,
  readVaultSettings,
  resolveBin,
  runGit,
  type MainPlugin,
} from '../../../main/plugin-api'
import { AGENT_INFO } from '../info'
import { claudeProvider } from './claude'
import { resolveClaudeBin } from './claude/cli'
import { claudeSeed } from './claude/seed'
import { codexProvider, resolveCodexBin } from './codex'
import { piCommand, piProvider } from './pi'
import { createPiBackground } from './pi/background'
import { harnessCapabilities } from './harness/capabilities'
import { isIntegration, parseHarnessFile } from './harness/record'
import { acquireHarnessRegistry, withPreset } from './harness/registry'
import { installSignalCommand, registerSignalRoute } from './harness/signal'
import { agentCapabilities, AGENT_NAMESPACES } from './host/capabilities'
import { bounded } from './host/bounded'
import { createPtySessions, parsePastFile, PTY_SESSION_ID } from './host/pty-sessions'
import { createFencedSessions, recoverFencedScratch } from './host/fenced'
import { activationOwnership } from './host/ownership'
import { withPtyOwnership } from './host/pty'
import { agentScratchRoots } from './host/scratch-roots'
import { createJobs } from './host/jobs'
import { createAgentSessions } from './host/sessions'
import { createAgentTerminals } from './host/terminals'
import { createManagedTurnBrackets } from './host/turn-coordinator'
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
import { createAgentProbeOwner } from './probe-owner'
import { hasBackground } from './provider'
import { versionCapabilities } from './version'

export const agentMain: MainPlugin = {
  info: AGENT_INFO,
  seed: claudeSeed,
  async activate(ctx) {
    const { app, nativeTheme } = await import('electron')
    if (ctx.activationSignal.aborted)
      throw new Error(`agent activation for ${ctx.remote} was cancelled`)
    const vault = { remote: ctx.remote, root: ctx.root }
    const scratchRoots = await agentScratchRoots(ctx.userData, vault)
    // Single Main excludes another controller; PluginHost serializes replacement
    // of this Vault's generation and never replaces one with failed live drain.
    // Check before exposing capabilities or instantiating hosts that sweep.
    const ownership = activationOwnership(ctx.userData, vault, ctx.activationSignal)
    if (ownership) {
      ownership.recover('pty')
      ownership.recover('pi')
      recoverFencedScratch(ownership, scratchRoots.fenced)
    }
    // This machine's agents: the built-in three, each reading its preset as
    // it runs, and the ones a person added in Settings
    // (docs/features/agent-sessions.md, Harnesses).
    const harnessFile = join(ctx.userData, 'agent-harnesses.json')
    const harnesses = await acquireHarnessRegistry(resolve(harnessFile), {
      store: jsonFileStore(harnessFile, parseHarnessFile),
      // What Holi could not read in the file is kept beside it before a write.
      keepBad: () =>
        copyFile(harnessFile, `${harnessFile}.bad`).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        }),
      bins: {
        claude: () => resolveClaudeBin(),
        codex: () => resolveCodexBin(),
        pi: () => resolveBin('pi'),
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
    let started: ReturnType<typeof createAgentSessions> | undefined
    const ownedWork = new Set<Promise<unknown>>()
    const ownedFailures: unknown[] = []
    const trackOwned = <T>(work: Promise<T>): Promise<T> => {
      ownedWork.add(work)
      void work.then(
        () => ownedWork.delete(work),
        (error: unknown) => {
          ownedFailures.push(error)
          ownedWork.delete(work)
        },
      )
      return work
    }
    const drainOwned = async (): Promise<void> => {
      while (ownedWork.size > 0) await Promise.allSettled([...ownedWork])
      if (ownedFailures.length > 0)
        throw new AggregateError(ownedFailures.splice(0), 'agent callbacks failed to drain')
    }
    const trackMutation = <T>(work: () => Promise<T>): Promise<T> => {
      if (ctx.activationSignal.aborted)
        return Promise.reject(new Error(`agent activation for ${ctx.remote} was cancelled`))
      return trackOwned(work())
    }
    const probes = createAgentProbeOwner(ctx.activationSignal)
    const activationOwners: Array<() => unknown | Promise<unknown>> = [
      probes.stop,
      () => harnesses.dispose(),
      () => drainOwned(),
    ]
    const assertActive = (): void => {
      if (ctx.activationSignal.aborted)
        throw new Error(`agent activation for ${ctx.remote} was cancelled`)
    }
    try {
      assertActive()
      const providers = (): ReturnType<typeof harnesses.providers> => harnesses.providers()
      const claude = providers().find(hasBackground)!
      // `holi-signal`, the hook command a harness a person added reports
      // its turns with.
      await installSignalCommand(ctx.binDir()).catch((err: unknown) =>
        console.error('[agent] holi-signal:', err),
      )
      assertActive()
      const terminals = createAgentTerminals({
        activationSignal: ctx.activationSignal,
        emit(remote, name, payload, deliveryGuard) {
          if (!ctx.activationSignal.aborted) ctx.emit(remote, name, payload, deliveryGuard)
        },
      })
      const displayedLease = (): (() => boolean) => ctx.presentationLease()
      if (ownership) {
        const open = terminals.open
        terminals.open = (args) =>
          withPtyOwnership(
            {
              cwd: args.cwd,
              allocate: (proof) => ownership.allocate('pty', args.attach ?? randomUUID(), proof),
            },
            () => open(args),
          )
      }
      activationOwners.push(() => terminals.closeAll())
      const sessionLog = createSessionLog(ctx.log)
      // Capabilities and provider hooks belong to this activation's vault, not
      // whichever vault the renderer currently displays.
      const liveRemote = (): string | null => ctx.remote

      // One list for the renderer and the plugins built on the agent: the
      // background sessions Claude Code's supervisor runs, then the ones Holi
      // runs itself, then its jobs.
      let background: SessionSummary[] = []
      let backgroundPast: SessionSummary[] = []
      let piSessions: SessionSummary[] = []
      let own: SessionSummary[] = []
      let ownPast: SessionSummary[] = []
      let jobRows: SessionSummary[] = []
      const pushHistory = (): void => {
        if (ctx.activationSignal.aborted) return
        ctx.emit(ctx.remote, 'history', [...backgroundPast, ...ownPast])
      }
      const pushSessions = (): void => {
        if (ctx.activationSignal.aborted) return
        const all = [...background, ...piSessions, ...own, ...jobRows]
        ctx.emit(ctx.remote, 'sessions', all)
        ctx.publish('sessions', all)
        sessionLog.sessions(all)
      }

      const managedTurns = createManagedTurnBrackets()
      const sessions = createAgentSessions({
        activationSignal: ctx.activationSignal,
        emit: (remote, name, payload) => {
          if (name === 'history' && remote === ctx.remote) {
            backgroundPast = payload as SessionSummary[]
            pushHistory()
            return
          }
          if (name !== 'sessions') return ctx.emit(remote, name, payload)
          background = payload as SessionSummary[]
          pushSessions()
        },
        // Each turn's end, for the plugins built on the agent (automations
        // close a run once it is done), and for the activity log.
        publish: (name, payload) => {
          if (ctx.activationSignal.aborted || name !== 'turn-end') return
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
      started = sessions
      activationOwners.push(() => sessions.leave({ stopSessions: false }))
      // Fix the session host to this activation's vault before exposing any
      // provider hook routes; early hook reports queue against this owner.
      await sessions.ensure({ ...ctx, claimManagedTurn: managedTurns.claimManagedTurn })
      assertActive()
      // Pi's RPC runs find `pi` and its environment as its terminals do: the
      // preset's program and variables, its arguments being a terminal's alone.
      const piRuns = piCommand({
        resolveBin: () => harnesses.resolve('pi'),
        env: () => harnesses.get('pi')?.env ?? {},
      })
      const pi = createPiBackground({
        bin: piRuns.bin,
        env: piRuns.env,
        binDir: ctx.binDir,
        activationSignal: ctx.activationSignal,
        ...(ownership && { allocateOwnership: (id, proof) => ownership.allocate('pi', id, proof) }),
        bracket: (id, edge) => sessions.bracket(id, edge),
        ...(process.platform !== 'win32' && {
          beginManagedTurn: (id: string) => managedTurns.begin(id, sessions.bracket),
        }),
        changed: () => {
          piSessions = pi.sessions()
          pushSessions()
        },
      })
      pi.setVault(ctx.remote, ctx.root)
      activationOwners.push(() => pi.leave())
      const ptyHistory = jsonFileStore(join(ctx.userData, 'agent-pty-history.json'), parsePastFile)
      const ptySessions = createPtySessions({
        vault: { remote: ctx.remote, root: ctx.root },
        activationSignal: ctx.activationSignal,
        past: {
          read: async () => (await ptyHistory.read())[ctx.remote] ?? [],
          write: async (list) => {
            await ptyHistory.update((all) => ({ ...all, [ctx.remote]: list }))
          },
        },
        // A background provider runs here only for its sign-in.
        providers,
        terminals,
        // Its turns pause sync and are recorded like a background session's.
        bracket: (id, edge) => sessions.bracket(id, edge),
        protectPtyTurn: sessions.protectPtyTurn,
        binDir: ctx.binDir,
        onChange: (list) => {
          own = list
          pushSessions()
        },
        onPast: (list) => {
          ownPast = list
          void pushHistory()
        },
      })
      activationOwners.push(() => ptySessions.leave())
      ownPast = await ptySessions.past()
      assertActive()
      pushHistory()
      // Prompts run unwatched by a provider without a supervisor: in a scratch
      // folder of their own, or in the vault, whose turns pause sync and are
      // recorded like a session's. Scratch is private to this canonical vault
      // context, so startup recovery and leave cannot reach another vault.
      assertActive()
      // The job host must recover('jobs', ...) before any POSIX startup sweep
      // when it takes up this registry, then link each individual launch.
      const jobs = createJobs({
        vault,
        scratchRoot: scratchRoots.jobs,
        ...(ownership && { ownership }),
        activationSignal: ctx.activationSignal,
        // Windows retains the legacy edge-only, best-effort history bracket.
        bracket: sessions.bracket,
        ...(process.platform !== 'win32' && {
          beginManagedTurn: (id: string) => managedTurns.begin(id, sessions.bracket),
        }),
        onChange: (list) => {
          jobRows = list
          pushSessions()
        },
      })
      activationOwners.push(() => jobs.leave())
      // Sessions Holi runs fenced to a folder of its own, what they wrote
      // copied back as each turn ends.
      const fenced = createFencedSessions({
        vault,
        scratchRoot: scratchRoots.fenced,
        ...(ownership && { ownership }),
        own: ptySessions,
        activationSignal: ctx.activationSignal,
        copyBack: jobs.copyBack,
      })
      activationOwners.unshift(
        () => terminals.joinFailedStarts(),
        () => fenced.closing(),
      )
      activationOwners.push(() => fenced.leave())
      // What the agent and Holi want the person to see: an entry in the
      // vault's inbox, and a banner while Holi is out of sight.
      const inbox = createInbox({
        store: jsonFileStore(join(ctx.root, INBOX_FILE), parseInbox),
        notify: (notice) => {
          if (!ctx.activationSignal.aborted) return ctx.notify(notice)
          return false
        },
        changed: (view) => {
          if (!ctx.activationSignal.aborted) ctx.emit(ctx.remote, 'inbox', view)
        },
      })
      const unproviders = harnesses.subscribe(() => ctx.emit(ctx.remote, 'providers', null))
      activationOwners.push(() => unproviders())
      assertActive()
      ctx.register(AGENT_NAMESPACES, {
        ...agentCapabilities({
          sessions: started,
          own: ptySessions,
          jobs,
          fenced,
          providers,
          terminals,
          presentationLease: displayedLease,
          liveRemote,
          commitNow: () => ctx.commitNow(),
          trackMutation,
          captureFinalization: () => ctx.captureFinalization(),
          pi,
          defaultProvider: async () => (await readVaultSettings(ctx.root)).agentProvider,
        }),
        ...inboxCapabilities({ inbox, liveRemote, trackMutation }),
        ...harnessCapabilities({
          registry: harnesses,
          probes,
          file: harnessFile,
          root: () => ctx.root,
          changed: () => ctx.emit(ctx.remote, 'providers', null),
        }),
        ...versionCapabilities({ holi: app.getVersion(), probes }),
      })
      const unwatchNeedsYou = watchNeedsYou({
        sessions: started,
        focused: () => ctx.focused(),
        told: async () => (await inbox.view()).entries.flatMap((e) => e.session ?? []),
        raise: (notice) => inbox.raise(notice),
        log: (msg) => console.error(`[agent] ${msg}`),
      })
      let needsYouStop: Promise<void> | undefined
      const stopNeedsYou = (): Promise<void> => (needsYouStop ??= unwatchNeedsYou())
      const needsYouFailures: unknown[] = []
      const revokeNeedsYou = (): void => {
        void stopNeedsYou().catch((error: unknown) => needsYouFailures.push(error))
      }
      ctx.activationSignal.addEventListener('abort', revokeNeedsYou, { once: true })
      activationOwners.push(async () => {
        ctx.activationSignal.removeEventListener('abort', revokeNeedsYou)
        await stopNeedsYou()
        if (needsYouFailures.length > 0)
          throw new AggregateError(needsYouFailures.splice(0), 'needs-you watcher failed to stop')
      })
      // A teammate's comment that mentions the person, found after a pull.
      const unmention = ctx.onMention((mention) => {
        if (ctx.activationSignal.aborted) return
        void trackOwned(inbox.raise(mentionNotice(mention))).catch((err: unknown) =>
          console.error('[agent] mention:', err),
        )
      })
      activationOwners.push(() => unmention())
      // Keystrokes and resizes, in the order they were typed. The host drops
      // any about a vault that is not the open one.
      ctx.on(
        'pty-write',
        (_remote, payload) => {
          const lease = displayedLease()
          if (ctx.activationSignal.aborted || !lease()) return
          const p = payload as { id?: unknown; data?: unknown }
          if (typeof p?.id === 'string' && typeof p.data === 'string')
            terminals.write(p.id, p.data, lease)
        },
        () => ctx.presentationLease(),
      )
      ctx.on(
        'pty-resize',
        (_remote, payload) => {
          const lease = displayedLease()
          if (ctx.activationSignal.aborted || !lease()) return
          const p = payload as { id?: unknown; cols?: unknown; rows?: unknown }
          if (
            typeof p?.id === 'string' &&
            typeof p.cols === 'number' &&
            typeof p.rows === 'number'
          ) {
            terminals.resize(p.id, p.cols, p.rows, lease)
          }
        },
        () => ctx.presentationLease(),
      )
      ctx.on(
        'pty-appearance',
        (_remote, payload) => {
          const lease = displayedLease()
          if (ctx.activationSignal.aborted || !lease()) return
          const p = payload as { id?: unknown; appearance?: unknown }
          if (typeof p?.id === 'string') terminals.setAppearance(p.id, p.appearance, lease)
        },
        () => ctx.presentationLease(),
      )
      // Each provider's hooks, by the session id they carry: a session Holi
      // runs, or a background job. The built-in ones are fixed, so their
      // routes are served once.
      for (const p of providers().filter((x) => x.custom !== true)) {
        p.capabilities.turns?.routes(ctx, {
          onTurn: (remote, id, active, pending, pid) =>
            trackOwned(
              (async () => {
                if (ctx.activationSignal.aborted || remote !== ctx.remote) return null
                if (PTY_SESSION_ID.test(id)) {
                  ptySessions.noteTurn(id, active)
                  return null
                }
                // The settle commit's tree, for the Stop hook to save as where the
                // turn left the vault.
                const commit = await sessions.noteTurn(remote, id, active, pending, pid)
                if (commit === null) return null
                const tree = await runGit(ctx.root, [
                  'rev-parse',
                  '--verify',
                  `${commit}^{tree}`,
                ]).catch(() => null)
                return ctx.activationSignal.aborted ? null : tree
              })(),
            ),
          // A session's status line: how much of its context is used.
          onStatus: (remote, id, status) => {
            if (!ctx.activationSignal.aborted) sessions.noteStatus(remote, id, status)
          },
          onConversation: (remote, id, about) => {
            if (!ctx.activationSignal.aborted && remote === ctx.remote)
              ptySessions.noteConversation(id, about)
          },
          // Where a background session takes messages: its inbox socket, kept
          // in memory.
          onChannel: (remote, id, channel) => {
            if (!ctx.activationSignal.aborted) sessions.noteChannel(remote, id, channel)
          },
        })
      }
      // `holi-signal`, from a session of a harness a person added: whichever
      // of them wired it into their CLI's hooks. The built-in agents report
      // through their own hooks.
      const unsignal = registerSignalRoute(ctx, {
        onSignal: (remote, id, signal) => {
          if (ctx.activationSignal.aborted || remote !== ctx.remote) return
          const provider = ptySessions.providerOf(id)
          if (provider === null || isIntegration(provider)) return
          if (signal.kind === 'status') return ptySessions.noteStatus(id, signal)
          if (signal.conversationId !== undefined) {
            ptySessions.noteConversation(id, { conversationId: signal.conversationId })
          }
          ptySessions.noteTurn(id, false)
        },
      })
      activationOwners.push(() => unsignal())
      // Quitting stops the vault's sessions, so it asks first when one of them
      // is working or waiting on you: that turn is cut short. Idle sessions
      // stop without a question; their conversations stay in the agents list.
      ctx.guardQuit(() => {
        const busy = [
          ...sessions.sessions(),
          ...pi.sessions(),
          ...ptySessions.sessions(),
          ...jobs.sessions(),
        ].filter((s) => s.state !== 'idle')
        if (busy.length === 0) return null
        const one = busy.length === 1
        return {
          message: one
            ? `Quit and stop ${busy[0]!.name}?`
            : `Quit and stop ${busy.length} sessions?`,
          detail: `${one ? 'Its' : 'Their'} current turn is cut short.`,
        }
      })
      // Expired personal memories and old work-log days go, now and hourly. The
      // running sweep is kept so leaving the vault waits for it to finish.
      let sweeping: Promise<unknown> = Promise.resolve()
      const sweep = (): void => {
        sweeping = sweeping.then(() =>
          readVaultSettings(ctx.root).then((settings) =>
            settings.agentMemory ? sweepAgentMemory(ctx.root, new Date()) : undefined,
          ).catch((err: unknown) =>
            console.error('[agent] memory sweep:', err),
          ),
        )
      }
      sweep()
      const sweepTimer = setInterval(sweep, SWEEP_EVERY_MS)
      sweepTimer.unref?.()
      activationOwners.push(
        () => clearInterval(sweepTimer),
        () => sweeping,
      )
      // The per-turn hook reads the focused note, and its selected lines, from a
      // file in this clone.
      const unreport = ctx.onReport((report) => {
        if (ctx.activationSignal.aborted) return
        sessions.setFocus({
          focusedPath: report.focusedPath,
          selection: report.selection,
          openPaths: report.openPaths,
        })
      })
      activationOwners.push(() => unreport())
      // Stopping stops the vault's sessions (the renderer asked first if one
      // was busy). Background ones stay in the agents list and resume when
      // opened; the ones Holi runs end with it.
      return async () => {
        clearInterval(sweepTimer)
        unsignal()
        unreport()
        unmention()
        unproviders()
        // A fenced session still starting opens nothing now, or is one the
        // sessions' leave ends.
        const failures: unknown[] = []
        for (const cleanup of [
          probes.stop,
          stopNeedsYou,
          () => sweeping,
          // Invalidation already revoked native PTY admission and started drain.
          // Join uncertain starts before waiting for fenced staging to finish.
          () => terminals.joinFailedStarts(),
          () => fenced.closing(),
          () => ptySessions.leave(),
          () => pi.leave(),
          () => fenced.leave(),
          () => jobs.leave(),
          () => sessions.leave(),
          () => terminals.closeAll(),
          () => harnesses.dispose(),
          () => bounded(drainOwned(), 'Agent callbacks'),
        ]) {
          try {
            await cleanup()
          } catch (err) {
            failures.push(err)
          }
        }
        if (failures.length > 0) throw new AggregateError(failures, 'agent teardown failed')
      }
    } catch (err) {
      // Revoke capability admission before asynchronous failure cleanup starts.
      ctx.invalidateActivation()
      // `ensure` may have attached the vault's config watcher before a later
      // activation step fails. Join any pending attach and release it before
      // allowing a retry to create another session host.
      const failures: unknown[] = [err]
      for (const cleanup of activationOwners) {
        try {
          await cleanup()
        } catch (cleanupError) {
          failures.push(cleanupError)
        }
      }
      if (failures.length === 1) throw err
      const failure = new AggregateError(failures, 'agent activation failed')
      ctx.reportDrainFailure(failure)
      throw failure
    }
  },
}
