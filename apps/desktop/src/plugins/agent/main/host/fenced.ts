/**
 * Fenced sessions: a session Holi runs (`pty-sessions.ts`) in a scratch
 * folder of its own rather than the vault, for a provider with `fenced` and
 * no supervisor (Codex). docs/features/agent-sessions.md, Fenced sessions.
 *
 * It is an ordinary session in the one list, in its terminal, where the
 * person watches it, answers its approvals and adds to it. What fences it is
 * the folder: `<userData>/agent-fenced/<id>/`, the files it reads copied in
 * at their vault paths, its writes sandboxed there by the agent's own rules.
 * As each turn ends, and once more when its process exits, what it wrote
 * inside its write scope is copied back by the jobs' own copy
 * (`jobs.ts`, `copyBack`: the vault's shared content only, no symlink
 * followed, `app.yaml` last, nothing past the caps). The folder goes when
 * the process exits, and every folder when the agent leaves the vault.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import type { AgentProvider, VaultRef } from '../provider'
import type { JobScope, Jobs } from './jobs'
import type { PtySessions } from './pty-sessions'
import type { Geometry, StartResult } from './sessions'

export interface FencedSessionsDeps {
  vault: VaultRef
  /** Where the folders go: `<userData>/agent-fenced`. */
  scratchRoot: string
  own: Pick<PtySessions, 'start'>
  copyBack: Jobs['copyBack']
  log?: (msg: string) => void
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
  /** Wait for the copies under way, then delete every folder. */
  leave(): Promise<void>
}

export function createFencedSessions(deps: FencedSessionsDeps): FencedSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-fenced] ${msg}`))
  const copies = new Set<Promise<void>>()
  // Folders a crash left behind. Their processes died with Holi's PTYs.
  const swept = rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)

  return {
    async start({ provider, name, prompt, system, scope, cols, rows }) {
      await swept
      const dir = join(deps.scratchRoot, randomBytes(6).toString('hex'))
      const drop = (): Promise<void> =>
        rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(dir, { recursive: true })
      for (const path of scope.read) {
        const abs = await exactPath(deps.vault.root, path)
        const copied =
          abs !== null &&
          (await mkdir(dirname(join(dir, path)), { recursive: true })
            .then(() => copyFile(abs, join(dir, path)))
            .then(
              () => true,
              () => false,
            ))
        if (!copied) {
          await drop()
          return { ok: false, message: `Holi could not read ${path}.` }
        }
      }

      // One copy at a time: a turn's end and the exit never overlap.
      let chain = Promise.resolve()
      const copy = (): Promise<void> => {
        const next = chain.then(async () => {
          try {
            const { written, skipped } = await deps.copyBack(dir, scope.write)
            log(`${name}: ${written} file(s) copied back, ${skipped.length} left out`)
          } catch (err) {
            log(`${name}: ${(err as Error).message}`)
          }
        })
        chain = next
        copies.add(next)
        void next.finally(() => copies.delete(next))
        return next
      }

      const started = await deps.own.start(provider.id, {
        name,
        prompt: system === undefined ? prompt : `${system}\n\n${prompt}`,
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
        fence: {
          dir,
          turnEnded: copy,
          exited: () => void copy().finally(drop),
        },
      })
      if (!started.ok) await drop()
      return started
    },

    async leave() {
      await Promise.all([...copies])
      await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
