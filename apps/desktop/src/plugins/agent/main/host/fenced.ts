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
  leftOutMessage,
  takenDestination,
  takenMessage,
  type JobScope,
  type Jobs,
  type Made,
} from './jobs'
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

export function createFencedSessions(deps: FencedSessionsDeps): FencedSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-fenced] ${msg}`))
  const copies = new Set<Promise<unknown>>()
  const finalizers = new Set<Promise<unknown>>()
  const active = new Set<string>()
  const cancellations = new Set<AbortController>()
  const drainErrors = new Set<unknown>()
  const DRAIN_CAP_MS = 5_000
  const bounded = async <T>(work: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} did not finish before teardown timed out.`)),
            DRAIN_CAP_MS,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  // Folders a crash left behind. Their processes died with Holi's PTYs.
  const swept = rm(deps.scratchRoot, { recursive: true, force: true })

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
    const began = generation
    const left = (): boolean => generation !== began
    const gone = { ok: false as const, message: 'The vault was left before the session started.' }
    await swept
    if (left()) return gone
    const taken = await takenDestination(deps.vault.root, scope.write)
    if (taken !== null) return { ok: false, message: takenMessage(taken) }
    const id = randomBytes(6).toString('hex')
    const dir = join(deps.scratchRoot, id)
    const state = join(deps.scratchRoot, `${id}.agent`)
    const controller = new AbortController()
    cancellations.add(controller)
    let sessionId: string | null = null
    const drop = async (): Promise<void> => {
      cancellations.delete(controller)
      if (sessionId !== null) active.delete(sessionId)
      await rm(dir, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
    await mkdir(dir, { recursive: true })
    await mkdir(state, { recursive: true, mode: 0o700 })
    // What it was given and what it wrote, each written again only while
    // the vault still holds it, and what it wrote into new folders, which
    // no copy writes over otherwise.
    const made: Made = new Map()
    const unread = await copyIn(deps.vault.root, dir, scope.read, made)
    if (unread !== null) {
      await drop()
      return { ok: false, message: unread }
    }

    // One copy at a time: a turn's end and the exit never overlap.
    // How it went goes on the session's row, where its caller reads it.
    let chain: Promise<unknown> = Promise.resolve()
    const copy = (): Promise<FenceCopy> => {
      const next = chain.then(async (): Promise<FenceCopy> => {
        try {
          const { written, skipped } = await deps.copyBack(
            dir,
            scope.write,
            made,
            controller.signal,
          )
          log(`${name}: ${written} file(s) copied back, ${skipped.length} left out`)
          const leftOut = leftOutMessage(skipped)
          return leftOut === undefined ? {} : { leftOut }
        } catch (err) {
          log(`${name}: ${(err as Error).message}`)
          return { error: (err as Error).message }
        }
      })
      chain = next
      copies.add(next)
      void next.then(
        () => copies.delete(next),
        (err: unknown) => {
          drainErrors.add(err)
          copies.delete(next)
        },
      )
      return next
    }

    if (left()) {
      await drop()
      return gone
    }
    const started = await deps.own.start(provider.id, {
      name,
      prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
      ...(cols === undefined ? {} : { cols }),
      ...(rows === undefined ? {} : { rows }),
      fence: {
        dir,
        state,
        turnEnded: copy,
        exited: () => {
          const finalizer = copy()
            .then(async (result) => {
              try {
                await provider.release?.(state)
                return result
              } catch (err) {
                drainErrors.add(err)
                throw new Error(`Could not release agent state: ${String(err)}`)
              }
            })
            .then(async (result) => {
              await drop()
              return result
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
    if (!started.ok) await drop()
    else {
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
      const work = Promise.allSettled([...copies, ...finalizers])
      await bounded(work, 'Fenced session finalization')
      if (active.size > 0) throw new Error(`Fenced PTYs did not exit: ${[...active].join(', ')}`)
      if (drainErrors.size > 0)
        throw new AggregateError([...drainErrors], 'Fenced session cleanup did not complete.')
      await rm(deps.scratchRoot, { recursive: true, force: true })
    },
  }
}
