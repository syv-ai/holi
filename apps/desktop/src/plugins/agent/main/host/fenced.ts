/**
 * Fenced sessions: a session Holi runs (`pty-sessions.ts`) in a scratch
 * folder of its own rather than the vault, for a provider with `fenced` and
 * no supervisor (Codex). docs/features/agent-sessions.md, Fenced sessions.
 *
 * It is an ordinary session in the one list, in its terminal, where the
 * person watches it, answers its approvals and adds to it. What fences it is
 * the folder: `<userData>/agent-scratch/<vault-key>/fenced/<id>/`, the files
 * it reads copied in at their vault paths, its writes sandboxed there by
 * the agent's own rules.
 * As each turn ends, and once more when its process exits, what it wrote
 * inside its write scope is copied back by the jobs' own copy
 * (`jobs.ts`, `copyBack`: the vault's shared content only, no symlink
 * followed, `app.yaml` last, nothing past the caps). A new folder it makes
 * (`folder/**`) must not be in the vault when it starts, and is never
 * written over: a copy into one that holds anything this session did not
 * write there is refused (`jobs.ts`). Beside the folder is the agent's own
 * state folder (`<id>.agent/`, its own Codex home), outside what it may
 * write; once the process exits the provider takes back what it keeps of
 * the person's there (`AgentProvider.release`). Both go when the process
 * exits, and every folder when the agent leaves the vault.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentProvider, VaultRef } from '../provider'
import {
  copyIn,
  CopyBackCancelled,
  leftOutMessage,
  takenDestination,
  takenMessage,
  type JobScope,
  type Jobs,
  type Made,
} from './jobs'
import { bounded } from './bounded'
import { scratchEntries, type ActivationOwnership } from './ownership'
import { ptyLaunchCleanup, withPtyOwnership } from './pty'
import type { FenceCopy, PtySessions } from './pty-sessions'
import type { Geometry, StartResult } from './sessions'

export interface FencedSessionsDeps {
  vault: VaultRef
  /** This vault's private scratch root from `agentScratchRoots`. */
  scratchRoot: string
  own: Pick<PtySessions, 'start'>
  copyBack: Jobs['copyBack']
  log?: (msg: string) => void
  /** Revokes admission synchronously when this vault activation is invalidated. */
  activationSignal?: AbortSignal
  /** POSIX registry already recovered for this scratch root, before admission. */
  ownership?: ActivationOwnership
}

export interface FencedSessions {
  /** A session of `provider` whose first turn is `prompt` (after `system`:
   *  the agent has no system prompt of Holi's), fenced to `scope`. */
  start(
    args: Geometry & {
      provider: AgentProvider
      name: string
      prompt: string
      system?: string
      scope: JobScope
    },
  ): Promise<StartResult>
  /** The vault is being left: a start under way opens no session, and
   *  once this resolves every session it opened is one `PtySessions.leave`
   *  ends. Called before that. */
  closing(): Promise<void>
  /** Wait for the copies under way, then delete every folder. */
  leave(): Promise<void>
}

export function recoverFencedScratch(ownership: ActivationOwnership, root: string): void {
  ownership.recover('fenced', {
    root,
    consumerId: (entry) => /^([0-9a-f]{12})(?:\.agent)?$/.exec(entry)?.[1],
  })
}

export function createFencedSessions(deps: FencedSessionsDeps): FencedSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-fenced] ${msg}`))
  const copies = new Set<Promise<unknown>>()
  const finalizers = new Set<Promise<unknown>>()
  const active = new Set<string>()
  const failedStarts = new Map<string, unknown>()
  const cancellations = new Set<AbortController>()
  const drainErrors = new Set<unknown>()
  let retirement: Promise<void> | undefined
  // POSIX recovery inspects its scope before creating owners. Without recovery
  // authority, retain unknown scratch on every platform instead of sweeping it.
  const swept = (async () => {
    if (!deps.ownership && scratchEntries(deps.scratchRoot).length !== 0)
      throw new Error(`Retaining unlinked fenced scratch: ${deps.scratchRoot}`)
  })().catch((err: unknown) => {
    drainErrors.add(err)
    throw err
  })
  void swept.catch(() => {})

  /** Bumped as the vault is left: a start that began before sees it. */
  let generation = 0
  let closing = deps.activationSignal?.aborted === true
  const starting = new Set<Promise<StartResult>>()
  deps.activationSignal?.addEventListener(
    'abort',
    () => {
      closing = true
      generation += 1
      for (const controller of cancellations) controller.abort()
    },
    { once: true },
  )

  async function begin({
    provider,
    name,
    prompt,
    system,
    scope,
    cols,
    rows,
  }: Parameters<FencedSessions['start']>[0]): Promise<StartResult> {
    if (closing) return { ok: false, message: 'The vault is closing.' }
    const blocked = {
      ok: false as const,
      message: 'Previous fenced launch cleanup is unconfirmed.',
      error: new Error('Previous fenced launch cleanup is unconfirmed.'),
      cleanupUnconfirmed: true as const,
    }
    if (failedStarts.size > 0) return blocked
    const began = generation
    const left = (): boolean => generation !== began
    const gone = { ok: false as const, message: 'The vault was left before the session started.' }
    await swept
    if (left()) return gone
    const taken = await takenDestination(deps.vault.root, scope.write)
    if (left()) return gone
    if (taken !== null) return { ok: false, message: takenMessage(taken) }
    const id = randomBytes(6).toString('hex')
    const dir = join(deps.scratchRoot, id)
    const state = join(deps.scratchRoot, `${id}.agent`)
    // Link before even creating the scratch. A crash in staging is an
    // unknown intent until it has an explicit refusal or physical proof.
    const ownership = deps.ownership?.allocate('fenced', id)
    let firstFailure: { error: unknown } | undefined
    const recordFailure = (error: unknown): unknown => {
      if (firstFailure !== undefined) return firstFailure.error
      firstFailure = { error }
      drainErrors.add(error)
      try {
        ownership?.fail(error)
      } catch (recordError) {
        drainErrors.add(recordError)
      }
      return error
    }
    const controller = new AbortController()
    cancellations.add(controller)
    let sessionId: string | null = null
    const drop = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted()
      await rm(dir, { recursive: true, force: true })
      signal?.throwIfAborted()
      await rm(state, { recursive: true, force: true })
      signal?.throwIfAborted()
      cancellations.delete(controller)
      if (sessionId !== null) active.delete(sessionId)
    }
    const discard = async (unlaunched: boolean): Promise<void> => {
      try {
        if (unlaunched) ownership?.nonLaunch()
        await drop()
        ownership?.retire()
      } catch (error) {
        recordFailure(error)
        throw error
      }
    }
    try {
      await mkdir(dir, { recursive: true })
      await mkdir(state, { recursive: true, mode: 0o700 })
    } catch (err) {
      recordFailure(err)
      throw err
    }
    // What it was given and what it wrote, each written again only while
    // the vault still holds it, and what it wrote into new folders, which
    // no copy writes over otherwise.
    const made: Made = new Map()
    let unread: string | null
    try {
      unread = await copyIn(deps.vault.root, dir, scope.read, made)
    } catch (err) {
      recordFailure(err)
      try {
        await drop()
      } catch (cleanupError) {
        drainErrors.add(cleanupError)
      }
      throw err
    }
    if (unread !== null) {
      await discard(true)
      return { ok: false, message: unread }
    }

    // One copy at a time: a turn's end and the exit never overlap.
    // How it went goes on the session's row, where its caller reads it.
    let chain: Promise<unknown> = Promise.resolve()
    const copy = (deadline?: AbortSignal): Promise<FenceCopy> => {
      const next = chain.then(async (): Promise<FenceCopy> => {
        try {
          deadline?.throwIfAborted()
          const { written, skipped } = await deps.copyBack(
            dir,
            scope.write,
            made,
            controller.signal,
            deadline,
          )
          deadline?.throwIfAborted()
          log(`${name}: ${written} file(s) copied back, ${skipped.length} left out`)
          const leftOut = leftOutMessage(skipped)
          return leftOut === undefined ? {} : { leftOut }
        } catch (err) {
          deadline?.throwIfAborted()
          // Ordinary cancellation only succeeds after rollback and cleanup.
          if (err instanceof CopyBackCancelled) return {}
          log(`${name}: ${String(err)}`)
          throw recordFailure(err)
        }
      })
      chain = next
      return next
    }

    function turnEnded(): Promise<FenceCopy> {
      const next = copy()
      copies.add(next)
      void next.then(
        () => copies.delete(next),
        () => copies.delete(next),
      )
      return next
    }

    if (left()) {
      await discard(true)
      return gone
    }
    if (failedStarts.size > 0) {
      await discard(true)
      return blocked
    }
    let launchCleanup: Promise<void> | undefined
    let startFailure: { error: unknown } | undefined
    let started: StartResult
    try {
      const launch = () =>
        deps.own.start(provider.id, {
          name,
          prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
          ...(cols === undefined ? {} : { cols }),
          ...(rows === undefined ? {} : { rows }),
          onStartupCleanup: (work) => {
            launchCleanup = work
            failedStarts.set(id, work)
          },
          fence: {
            dir,
            state,
            canLaunch: () => !left() && failedStarts.size === 0,
            turnEnded,
            retire: async (signal) => {
              try {
                signal?.throwIfAborted()
                ownership?.settleCaller()
                await drop(signal)
              } catch (error) {
                throw recordFailure(signal?.aborted ? signal.reason : error)
              }
            },
            exited: (signal) => {
              const work = (async () => {
                try {
                  const result = await copy(signal)
                  signal?.throwIfAborted()
                  await provider.release?.(state, signal)
                  signal?.throwIfAborted()
                  return result
                } catch (error) {
                  throw recordFailure(signal?.aborted ? signal.reason : error)
                }
              })()
              let abort: (() => void) | undefined
              const cancelled = new Promise<never>((_, reject) => {
                abort = () => reject(recordFailure(signal?.reason))
                if (signal?.aborted) abort()
                else signal?.addEventListener('abort', abort, { once: true })
              })
              // Join the PTY's callback deadline, not a new timer. A timed-out
              // provider may still resolve; the work above must not retire it.
              const finalizer = Promise.race([work, cancelled]).finally(() => {
                if (abort !== undefined) signal?.removeEventListener('abort', abort)
              })
              finalizers.add(finalizer)
              void finalizer.then(
                () => finalizers.delete(finalizer),
                () => finalizers.delete(finalizer),
              )
              return finalizer
            },
          },
        })
      started = await (ownership
        ? withPtyOwnership({ cwd: dir, fence: ownership, allocate: () => ownership }, launch)
        : launch())
    } catch (error) {
      startFailure = { error }
      started = { ok: false, message: String(error) }
      if (launchCleanup === undefined) {
        const cleanup = ptyLaunchCleanup(error)
        if (cleanup !== undefined)
          launchCleanup = cleanup.then(
            () => {},
            (failure: unknown) => {
              throw new AggregateError([error, failure], 'Fenced launch and cleanup failed.', {
                cause: error,
              })
            },
          )
      }
    }
    if (!started.ok) {
      if (launchCleanup !== undefined) {
        failedStarts.set(id, launchCleanup)
        try {
          await launchCleanup
        } catch (error) {
          failedStarts.set(id, error)
          recordFailure(error)
          throw error
        }
      } else if (startFailure !== undefined || started.cleanupUnconfirmed) {
        // A throw can happen after the terminal opened. Without authority
        // to verify cleanup, never drop this source or permit replacement.
        const error = startFailure ? startFailure.error : new Error(started.message)
        failedStarts.set(id, error)
        recordFailure(error)
        throw error
      }
      // A structured refusal without pending cleanup comes from before
      // native entry. A returned cleanup receipt still has to be joined.
      await discard(launchCleanup === undefined)
      failedStarts.delete(id)
      if (startFailure !== undefined) throw startFailure.error
    } else {
      sessionId = started.sessionId
      if (cancellations.has(controller)) active.add(sessionId)
    }
    return started
  }

  return {
    async start(args) {
      if (closing) return { ok: false, message: 'The vault is closing.' }
      const begun = begin(args)
      starting.add(begun)
      try {
        return await begun
      } finally {
        starting.delete(begun)
      }
    },

    async closing() {
      closing = true
      generation += 1
      for (const controller of cancellations) controller.abort()
      await bounded(Promise.allSettled([...starting]), 'Fenced session starts')
    },

    async leave() {
      closing = true
      generation += 1
      for (const controller of cancellations) controller.abort()
      await bounded(Promise.all([...starting]), 'Fenced session starts')
      const work = Promise.allSettled([...copies, ...finalizers])
      await bounded(work, 'Fenced session finalization')
      if (drainErrors.size > 0 || failedStarts.size > 0)
        throw new AggregateError(
          [...new Set([...drainErrors, ...failedStarts.values()])],
          'Fenced session cleanup did not complete.',
        )
      if (active.size > 0) throw new Error(`Fenced PTYs did not exit: ${[...active].join(', ')}`)
      await bounded(swept, 'Fenced startup sweep')
      if (retirement === undefined) {
        const work = rm(deps.scratchRoot, { recursive: true, force: true })
        retirement = work
        // A timeout never releases ownership. Only a settled failure may
        // retry; a completed retirement must not delete a replacement root.
        void work.catch(() => {
          if (retirement === work) retirement = undefined
        })
      }
      await bounded(retirement, 'Fenced scratch cleanup')
    },
  }
}
