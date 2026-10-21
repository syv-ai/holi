/**
 * Git's routes on the bridge (`bridge/server.ts`): the clone's pre-commit hook
 * and its merge drivers (`merge-drivers.ts`) call back into Holi here. Git is the caller,
 * not the agent, which is why these are routes rather than capabilities.
 *
 * Resolved from the caller's token rather than from the active vault, so a
 * `git commit` in one vault never runs its pre-commit transforms against
 * whichever vault is on screen.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import { mergeCommentsText, mergeRecordText, type SnapshotClaim } from '@holi/shared'
import type { BridgeServer } from '../bridge/server'
import { PRE_COMMIT_TRANSFORM, type VaultPreCommit } from './hooks/pre-commit'
import { runPreCommit, type Transform } from './hooks/runner'
import { stagedChanges } from './hooks/staged'
import { readHookSettings, vaultTransforms } from './hooks/transforms'

export interface GitRoutesDeps {
  /** The vault's clone on this machine, or null for a vault Holi does not have. */
  rootFor(remote: string): Promise<string | null>
  /** What the plugins the vault at `root` runs claim, for the transforms. */
  claims(root: string): Promise<readonly SnapshotClaim[]>
  /** The enabled plugins' transforms, with their defaults. */
  transforms(root: string): Promise<readonly (Transform & { default: boolean })[]>
  /** The vault's own `.pre-commit-config.yaml`, run last when allowed here. */
  preCommit?: Pick<VaultPreCommit, 'transform'>
  /** Add `text` to the running agent session `job` of the vault `remote`.
   *  Rejects when it cannot (no such session, no agent, no inbox). */
  tellSession?(remote: string, job: string, text: string): Promise<unknown>
  log?: (msg: string) => void
}

/** A Claude Code job id, as the hook script passes it from `CLAUDE_JOB_DIR`. */
const JOB = /^[0-9a-f]{8}$/

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Registers the routes; returns the undo. */
export function registerGitRoutes(
  server: Pick<BridgeServer, 'route'>,
  deps: GitRoutesDeps,
): () => void {
  const log = deps.log ?? ((msg: string) => console.error(`[pre-commit] ${msg}`))
  const undo = [
    /**
     * Holi's own pre-commit hook. The transforms run here rather than in the
     * shell script so they are TypeScript and tested; the script is a curl and
     * an `exit 0`, and it ignores the answer.
     */
    server.route('/hooks/pre-commit', {
      body: 'discard',
      async handle(remote, query) {
        const json = (value: unknown) => ({
          status: 200,
          body: JSON.stringify(value),
          contentType: 'application/json',
        })
        try {
          const root = await deps.rootFor(remote)
          if (root === null) return json({ changed: [], failed: [] })
          // The run log (`.holi/state/hooks.local.log`) always has what the
          // transforms said. A commit an agent session made also tells that
          // session, which is mid-turn and reads it after this commit's tool
          // call. Holi's own commits name no session, so the log is all.
          const job = query.get('job') ?? ''
          const tell = deps.tellSession
          const notify =
            tell !== undefined && JOB.test(job)
              ? (summary: string) =>
                  void tell(
                    remote,
                    job,
                    `Holi's pre-commit transforms on your commit:\n${summary}`,
                  ).catch((error: unknown) =>
                    log(`could not tell session ${job}: ${message(error)}`),
                  )
              : undefined
          const plugins = await deps.transforms(root)
          const own = deps.preCommit?.transform(remote)
          const result = await runPreCommit(root, await stagedChanges(root), {
            // A plugin transform the settings do not name runs as its toggle says.
            // The vault's own hooks always reach their transform, which runs
            // them only where this person has allowed them.
            settings: {
              ...Object.fromEntries(plugins.map((t) => [t.name, t.default])),
              ...(await readHookSettings(root)),
              [PRE_COMMIT_TRANSFORM]: true,
            },
            transforms: [
              ...vaultTransforms(await deps.claims(root), plugins),
              ...(own === undefined ? [] : [own]),
            ],
            ...(notify === undefined ? {} : { notify }),
          })
          return json({ changed: result.changed, failed: result.failed })
        } catch (error) {
          return json({ changed: [], failed: [{ error: message(error) }] })
        }
      },
    }),
    /**
     * The merge driver: the three versions of one app record, form-encoded.
     * 200 with the merged record, or 409 with the reason, which the driver
     * turns into an ordinary conflict. An empty base is two additions of one id.
     */
    server.route('/merge/record', {
      body: 'text',
      handle(_remote, _query, body) {
        const fields = new URLSearchParams(body)
        const base = fields.get('base') ?? ''
        const out = mergeRecordText(
          base === '' ? null : base,
          fields.get('ours') ?? '',
          fields.get('theirs') ?? '',
        )
        return out.ok ? { status: 200, body: out.text } : { status: 409, body: out.reason }
      },
    }),
    /**
     * The comments driver: one note's threads, three ways. Comments are
     * unioned by id, so it refuses only text that is not a comments file.
     */
    server.route('/merge/comments', {
      body: 'text',
      handle(_remote, _query, body) {
        const fields = new URLSearchParams(body)
        const base = fields.get('base') ?? ''
        const out = mergeCommentsText(
          base === '' ? null : base,
          fields.get('ours') ?? '',
          fields.get('theirs') ?? '',
        )
        return out.ok ? { status: 200, body: out.text } : { status: 409, body: out.reason }
      },
    }),
  ]
  return () => undo.forEach((u) => u())
}
