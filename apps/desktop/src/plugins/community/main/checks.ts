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
import { expandCommand, runCheck } from './setup'

export type CheckResult = { ok: true } | { ok: false; hint: string }

export interface Checks {
  /** The last answer for the plugin `id` in the vault at `root`, or null
   *  when it has not been asked since it was last forgotten. */
  get(root: string, id: string): CheckResult | null
  /** Ask now, in `cwd`, and keep the answer. A check already running for the
   *  same plugin, asked since it was last forgotten, is joined rather than run
   *  twice. */
  run(root: string, id: string, check: PluginCheck, cwd: string): Promise<CheckResult>
  /** Drop the answer, for a plugin removed, replaced, set up again or turned
   *  off. A check still running from before is not kept when it ends. */
  forget(root: string, id: string): void
  /** Stop every check still running, as the vault's plugins stop. */
  stop(): void
}

const keyOf = (root: string, id: string) => `${root}\0${id}`

export function createChecks(runner: typeof runCheck = runCheck): Checks {
  const results = new Map<string, CheckResult>()
  /** Bumped by `forget`: an answer from an older generation is stale. */
  const generations = new Map<string, number>()
  const running = new Map<string, { generation: number; ask: Promise<CheckResult> }>()
  const stopping = new AbortController()
  const generationOf = (key: string) => generations.get(key) ?? 0
  return {
    get: (root, id) => results.get(keyOf(root, id)) ?? null,
    run(root, id, check, cwd) {
      const key = keyOf(root, id)
      const generation = generationOf(key)
      const pending = running.get(key)
      if (pending !== undefined && pending.generation === generation) return pending.ask
      const ask = (async (): Promise<CheckResult> => {
        let ok = false
        try {
          ok = await runner({
            argv: expandCommand(check.run, { vault: root }),
            cwd,
            signal: stopping.signal,
          })
        } catch {
          // Could not be run: it cannot pass.
        }
        const result: CheckResult = ok ? { ok: true } : { ok: false, hint: check.hint }
        if (generationOf(key) === generation) results.set(key, result)
        return result
      })().finally(() => {
        if (running.get(key)?.ask === ask) running.delete(key)
      })
      running.set(key, { generation, ask })
      return ask
    },
    forget(root, id) {
      const key = keyOf(root, id)
      results.delete(key)
      generations.set(key, generationOf(key) + 1)
    },
    stop: () => stopping.abort(),
  }
}
