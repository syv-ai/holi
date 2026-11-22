/**
 * A plugin's readiness `check` (docs/features/community-plugins.md): whether
 * it can do its work now, beyond being set up, such as a companion app having
 * a setting switched on. Run when the vault opens, when a plugin is turned on
 * there, right after setup, and when the person asks again, never on a timer.
 * The last answer is kept here, in memory, per vault and plugin: a vault's
 * plugins are activated afresh each time it opens, so leaving the vault drops
 * it.
 *
 * A failing check never stops the plugin. Its row says so, with the
 * manifest's hint, beside the status rather than as one.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import type { PluginCheck } from '@holi/shared'
import { UnconfirmedOwnedProgramError } from '../../../main/plugin-api'
import { expandCommand, runCheck } from './setup'

export type CheckResult = { ok: true } | { ok: false; hint: string }

type CheckCompletion =
  | { kind: 'stopped' }
  | {
      kind: 'joined'
      /** A current answer from this launch or a newer one. Null means the
       *  join proved drain only for the authorization the caller now holds. */
      answerSince(fingerprint: string): CheckResult | null
    }

export interface Checks {
  /** The last answer for the plugin `id` in the vault at `root`, or null
   *  when it has not been asked since it was last forgotten. */
  get(root: string, id: string): CheckResult | null
  /** Ask now, in `cwd`, or join the running check. On Windows that can be
   *  a stale launch still draining. Read the completed ticket against the
   *  freshly authorized fingerprint, not as proof that a new check ran. */
  run(
    root: string,
    id: string,
    check: PluginCheck,
    cwd: string,
    fingerprint?: string,
  ): Promise<CheckCompletion>
  /** Drop the answer, for a plugin removed, replaced, set up again or turned
   *  off. A check still running from before is not kept when it ends. */
  forget(root: string, id: string): Promise<void>
  /** Invalidate synchronously. Returns a join only if a check is still draining;
   *  throws an already retained proof failure instead of reporting idle. */
  invalidate(root: string, id: string): Promise<CheckCompletion> | undefined
  /** Stop every check still running, as the vault's plugins stop. */
  stop(): Promise<void>
}

const keyOf = (root: string, id: string) => `${root}\0${id}`

export function createChecks(runner: typeof runCheck = runCheck): Checks {
  const results = new Map<
    string,
    { result: CheckResult; fingerprint: string; generation: number; launch: number }
  >()
  let launches = 0
  /** Bumped by `forget`: an answer from an older generation is stale. */
  const generations = new Map<string, number>()
  const running = new Map<
    string,
    { generation: number; ask: Promise<CheckCompletion>; abort: AbortController }
  >()
  const failures = new Map<string, UnconfirmedOwnedProgramError>()
  const stopping = new AbortController()
  const windows = process.platform === 'win32'
  let stopped: Promise<void> | undefined
  const generationOf = (key: string) => generations.get(key) ?? 0
  const invalidate = (root: string, id: string) => {
    const key = keyOf(root, id)
    results.delete(key)
    generations.set(key, generationOf(key) + 1)
    const failure = failures.get(key)
    if (failure) throw failure
    const pending = running.get(key)
    pending?.abort.abort()
    return pending?.ask
  }
  return {
    get: (root, id) => results.get(keyOf(root, id))?.result ?? null,
    run(root, id, check, cwd, fingerprint = '') {
      const key = keyOf(root, id)
      const failure = failures.get(key)
      if (failure) return Promise.reject(failure)
      if (stopping.signal.aborted) return Promise.resolve({ kind: 'stopped' })
      const generation = generationOf(key)
      const pending = running.get(key)
      // Even after invalidation, a Windows check still owns its launch until joined.
      if (pending !== undefined && (windows || pending.generation === generation))
        return pending.ask
      const launch = ++launches
      const abort = new AbortController()
      const stop = () => abort.abort()
      stopping.signal.addEventListener('abort', stop, { once: true })
      const ask = (async (): Promise<CheckCompletion> => {
        let ok = false
        try {
          ok = await runner({
            argv: expandCommand(check.run, { vault: root }),
            cwd,
            signal: abort.signal,
          })
        } catch (error) {
          if (error instanceof UnconfirmedOwnedProgramError) {
            const failure = failures.get(key) ?? error
            failures.set(key, failure)
            results.delete(key)
            throw failure
          }
          // A known command failure is a readiness answer, not a disposal failure.
        }
        const result: CheckResult = ok ? { ok: true } : { ok: false, hint: check.hint }
        if (generationOf(key) === generation)
          results.set(key, { result, fingerprint, generation, launch })
        return {
          kind: 'joined',
          answerSince(currentFingerprint) {
            const answer = results.get(key)
            return !stopping.signal.aborted &&
              answer !== undefined &&
              answer.launch >= launch &&
              answer.generation === generationOf(key) &&
              answer.fingerprint === currentFingerprint
              ? answer.result
              : null
          },
        }
      })().finally(() => {
        stopping.signal.removeEventListener('abort', stop)
        // A waiter who needs a current answer must never rejoin this ticket.
        if (running.get(key)?.ask === ask) running.delete(key)
      })
      running.set(key, { generation, ask, abort })
      return ask
    },
    async forget(root, id) {
      const pending = invalidate(root, id)
      if (pending !== undefined) await pending
    },
    invalidate,
    stop() {
      if (stopped) return stopped
      stopping.abort()
      for (const key of running.keys()) generations.set(key, generationOf(key) + 1)
      stopped = Promise.allSettled([...running.values()].map(({ ask }) => ask)).then(() => {
        const failure = failures.values().next().value
        if (failure) throw failure
      })
      // Aborting the attachment starts stop without awaiting it; cleanup rejoins it.
      void stopped.catch(() => {})
      return stopped
    },
  }
}
