/**
 * Git's routes on the bridge (`bridge/server.ts`): the clone's pre-commit hook
 * and its app-record merge driver call back into Holi here. Git is the caller,
 * not the agent, which is why these are routes rather than capabilities.
 *
 * Resolved from the caller's token rather than from the active vault, so a
 * `git commit` in one vault never runs its pre-commit transforms against
 * whichever vault is on screen.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import { mergeRecordText, type SnapshotClaim } from '@holi/shared'
import type { BridgeServer } from '../bridge/server'
import { runPreCommit, type Transform } from './hooks/runner'
import { stagedChanges } from './hooks/staged'
import { readHookSettings, vaultTransforms } from './hooks/transforms'

export interface GitRoutesDeps {
  /** The vault's clone on this machine, or null for a vault Holi does not have. */
  rootFor(remote: string): Promise<string | null>
  /** What the plugins the vault at `root` runs claim, for the transforms. */
  claims(root: string): Promise<readonly SnapshotClaim[]>
  /** The core parts' and enabled plugins' transforms, with their defaults. */
  transforms(root: string): Promise<readonly (Transform & { default: boolean })[]>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Registers the routes; returns the undo. */
export function registerGitRoutes(
  server: Pick<BridgeServer, 'route'>,
  deps: GitRoutesDeps,
): () => void {
  const undo = [
    /**
     * Holi's own pre-commit hook. The transforms run here rather than in the
     * shell script so they are TypeScript and tested; the script is a curl and
     * an `exit 0`, and it ignores the answer.
     */
    server.route('/hooks/pre-commit', {
      body: 'discard',
      async handle(remote) {
        const json = (value: unknown) => ({
          status: 200,
          body: JSON.stringify(value),
          contentType: 'application/json',
        })
        try {
          const root = await deps.rootFor(remote)
          if (root === null) return json({ changed: [], failed: [] })
          // No `notify`: Holi has no push seam into a live Claude Code session,
          // and typing into the agent's PTY is not one. The run log
          // (`.holi/state/hooks.local.log`) is the agent-readable surface.
          const plugins = await deps.transforms(root)
          const result = await runPreCommit(root, await stagedChanges(root), {
            // A plugin transform the settings do not name runs as its toggle says.
            settings: {
              ...Object.fromEntries(plugins.map((t) => [t.name, t.default])),
              ...(await readHookSettings(root)),
            },
            transforms: vaultTransforms(await deps.claims(root), plugins),
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
  ]
  return () => undo.forEach((u) => u())
}
