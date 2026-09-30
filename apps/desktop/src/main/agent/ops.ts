/**
 * The routes the `holi` CLI talks to — what the agent can ask Holi to *do*,
 * as opposed to what it can read off the filesystem itself.
 *
 * Mounted on the hook server, which already owns an ephemeral loopback port and
 * a per-instance token. The `holi-google` shape with a smaller surface.
 *
 * **A turn-signal route and an ops route answer differently.** Whatever a Claude
 * Code hook prints is injected into the agent's context, so a hook route replies
 * empty. An ops route replies to a command the agent deliberately typed.
 *
 * **Every refusal is a value, never a status code.** The agent reads stdout, and
 * `--fail-with-body` turns a non-2xx into a non-zero exit that reads like "Holi
 * is broken" rather than "that app has no manifest yet". A thrown dep becomes
 * `{ok:false,error}` for the same reason.
 *
 * **`/cap/<method>` is the exception**: its output is the answer itself, so it
 * answers `text/plain`, 200 with it or 422 with one line, and the script routes
 * them to stdout and stderr the way `cat` would.
 * `/merge/record` is git's, not the agent's: 200 with the merged record, or 409.
 *
 * NOTE: no `electron` import, here or in `hook-server.ts`: both load under
 * vitest.
 */
import { mergeRecordText } from '@holi/shared'
import type { SkillsUpdate } from './seed-content'

/** What a route needs main to do. Injected, so this module stays testable
 *  without a window, a vault, or a running app. */
export interface AgentOpsDeps {
  /** Open (or focus) the tab of the app at this bundle path, in the active pane. */
  openApp(path: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Scaffold a new app bundle at this path: manifest, entry document. */
  initApp(path: string): Promise<{ ok: true; created: string[] } | { ok: false; error: string }>
  /** Run the enabled pre-commit transforms over the staged set. Called by
   *  Holi's own git hook, not by the agent, but it lives here because this is
   *  where the loopback port and its token already are. */
  runPreCommitHooks(): Promise<{ changed: string[]; failed: unknown[] }>
  /** `holi skills update`: this release's skills and hooks, merged in. */
  updateSkills(): Promise<SkillsUpdate>
  /** The CLI door into the capability registry (`apps/capabilities.ts`): run
   *  `name` for this vault with the command's fields as params. Throws the
   *  refusal, whose message is the one line the command prints. */
  capability(
    name: string,
    params: Record<string, string>,
  ): Promise<{ value: unknown; text: string }>
}

export interface OpsReply {
  status: number
  body: string
  /** `application/json` when absent, which is every route but one. */
  contentType?: string
}

/** `null` means "not one of mine" — the server turns that into a 404. */
export type AgentOps = (pathname: string, params: URLSearchParams) => Promise<OpsReply | null>

const json = (value: unknown): OpsReply => ({ status: 200, body: JSON.stringify(value) })

const text = (status: number, body: string): OpsReply => ({
  status,
  body,
  contentType: 'text/plain; charset=utf-8',
})

/** A thrown dep is an answer, not an outage — see the module doc. */
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  return async (pathname, params) => {
    switch (pathname) {
      case '/app/open': {
        const path = params.get('path')
        if (path === null || path === '') return json({ ok: false, error: 'app/open needs a path' })
        try {
          return json(await deps.openApp(path))
        } catch (error) {
          return json({ ok: false, error: message(error) })
        }
      }
      case '/app/init': {
        const path = params.get('path')
        if (path === null || path === '') return json({ ok: false, error: 'app/init needs a path' })
        try {
          return json(await deps.initApp(path))
        } catch (error) {
          return json({ ok: false, error: message(error) })
        }
      }
      case '/hooks/pre-commit': {
        try {
          return json(await deps.runPreCommitHooks())
        } catch (error) {
          // The hook ignores the body and exits 0 regardless; answering rather
          // than 500ing keeps the shape one branch instead of two.
          return json({ changed: [], failed: [{ error: message(error) }] })
        }
      }
      case '/skills/update': {
        try {
          const result = await deps.updateSkills()
          return text(result.ok ? 200 : 422, result.ok ? result.summary : result.message)
        } catch (error) {
          return text(422, message(error))
        }
      }
      case '/merge/record': {
        // Git's merge driver, not the agent: the three versions of one app
        // record. An empty base is two additions of one id.
        const base = params.get('base') ?? ''
        const out = mergeRecordText(
          base === '' ? null : base,
          params.get('ours') ?? '',
          params.get('theirs') ?? '',
        )
        return out.ok ? text(200, out.text) : text(409, out.reason)
      }
      default: {
        if (!pathname.startsWith('/cap/')) return null
        const fields: Record<string, string> = {}
        for (const [key, value] of params) if (key !== 't' && key !== 'json') fields[key] = value
        try {
          const result = await deps.capability(pathname.slice('/cap/'.length), fields)
          return text(
            200,
            params.get('json') === 'true' ? JSON.stringify(result.value, null, 2) : result.text,
          )
        } catch (error) {
          return text(422, message(error))
        }
      }
    }
  }
}
