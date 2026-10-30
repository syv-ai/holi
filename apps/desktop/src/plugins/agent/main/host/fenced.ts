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
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import type { AgentProvider, VaultRef } from '../provider'
import { takenDestination, takenMessage, type JobScope, type Jobs } from './jobs'
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
  /** The vault is being left: a start under way opens no session, and
   *  once this resolves every session it opened is one `PtySessions.leave`
   *  ends. Called before that. */
  closing(): Promise<void>
  /** Wait for the copies under way, then delete every folder. */
  leave(): Promise<void>
}

export function createFencedSessions(deps: FencedSessionsDeps): FencedSessions {
  const log = deps.log ?? ((msg: string) => console.log(`[agent-fenced] ${msg}`))
  const copies = new Set<Promise<void>>()
  // Folders a crash left behind. Their processes died with Holi's PTYs.
  const swept = rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)

  /** Bumped as the vault is left: a start that began before sees it. */
  let generation = 0
  const starting = new Set<Promise<StartResult>>()

  async function begin({
    provider,
    name,
    prompt,
    system,
    scope,
    cols,
    rows,
  }: Parameters<FencedSessions['start']>[0]): Promise<StartResult> {
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
    const drop = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      await rm(state, { recursive: true, force: true }).catch(() => undefined)
    }
    await mkdir(dir, { recursive: true })
    await mkdir(state, { recursive: true, mode: 0o700 })
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

    // One copy at a time: a turn's end and the exit never overlap. What
    // it wrote into its new folders, which no copy writes over otherwise.
    const made = new Set<string>()
    let chain = Promise.resolve()
    const copy = (): Promise<void> => {
      const next = chain.then(async () => {
        try {
          const { written, skipped } = await deps.copyBack(dir, scope.write, made)
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
        exited: () =>
          void copy()
            .then(() => provider.release?.(state))
            .finally(drop),
      },
    })
    if (!started.ok) await drop()
    return started
  }

  return {
    async start(args) {
      const begun = begin(args)
      starting.add(begun)
      try {
        return await begun
      } finally {
        starting.delete(begun)
      }
    },

    async closing() {
      generation += 1
      await Promise.allSettled([...starting])
    },

    async leave() {
      await Promise.all([...copies])
      await rm(deps.scratchRoot, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
