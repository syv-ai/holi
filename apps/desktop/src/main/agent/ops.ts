/**
 * The routes the `holi` CLI talks to — what the agent can ask Holi to *do*,
 * as opposed to what it can read off the filesystem itself.
 *
 * Mounted on the hook server because that server already owns the two things
 * this needs and neither is worth minting twice: an ephemeral loopback port and
 * a per-instance token. It is the `holi-google` shape (D67) with a smaller
 * surface.
 *
 * **A turn-signal route and an ops route answer differently, and the difference
 * matters.** A hook route replies with an empty body, because whatever a
 * Claude Code hook prints is injected into the agent's context — a stray reply
 * there is unattributed text appearing mid-conversation. An ops route is a
 * reply to a command the agent deliberately typed, so it may and should answer.
 * Mixing the two is how CLI output ends up in the context window.
 *
 * **Every refusal is a value, never a status code.** The agent reads stdout; a
 * 500 with an HTML body tells it nothing it can act on, and `--fail-with-body`
 * turns a non-2xx into a non-zero exit that reads like "Holi is broken" rather
 * than "that app has no manifest yet". A thrown dep becomes `{ok:false,error}`
 * for the same reason.
 *
 * NOTE: no `electron` import, here or in `hook-server.ts` — both load under
 * vitest, and an import of it breaks the suite in a way that looks unrelated.
 */

/** What a route needs main to do. Injected, so this module stays testable
 *  without a window, a vault, or a running app. */
export interface AgentOpsDeps {
  /** Open (or focus) the app's tab in the active pane. */
  openApp(appId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Scaffold a new app directory: manifest, entry document. */
  initApp(appId: string): Promise<{ ok: true; created: string[] } | { ok: false; error: string }>
  /** Re-write the managed files Holi still owns (D75). */
  refreshSeed(input: {
    path?: string
    force?: boolean
  }): Promise<{ refreshed: string[]; skipped: { path: string; reason: string }[] }>
}

export interface OpsReply {
  status: number
  body: string
}

/** `null` means "not one of mine" — the server turns that into a 404. */
export type AgentOps = (pathname: string, params: URLSearchParams) => Promise<OpsReply | null>

const json = (value: unknown): OpsReply => ({ status: 200, body: JSON.stringify(value) })

/** A thrown dep is an answer, not an outage — see the module doc. */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  return async (pathname, params) => {
    switch (pathname) {
      case '/app/open': {
        const id = params.get('id')
        if (id === null || id === '') return json({ ok: false, error: 'app/open needs an id' })
        try {
          return json(await deps.openApp(id))
        } catch (error) {
          return json({ ok: false, error: message(error) })
        }
      }
      case '/app/init': {
        const id = params.get('id')
        if (id === null || id === '') return json({ ok: false, error: 'app/init needs an id' })
        try {
          return json(await deps.initApp(id))
        } catch (error) {
          return json({ ok: false, error: message(error) })
        }
      }
      case '/seed/refresh': {
        const path = params.get('path')
        try {
          return json(
            await deps.refreshSeed({
              path: path === null || path === '' ? undefined : path,
              force: params.get('force') === 'true',
            }),
          )
        } catch (error) {
          // Keeps the shape the caller parses, so a failure is one branch in the
          // CLI rather than two.
          return json({ refreshed: [], skipped: [], error: message(error) })
        }
      }
      default:
        return null
    }
  }
}
