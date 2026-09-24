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
 * **`/pdf/comments` is the one exception**, and on purpose: its output is the
 * answer itself, text the agent reads, and a refusal (no such file, not a PDF)
 * is an error the command exits non-zero on, the way `cat` does. So it answers
 * `text/plain`, 200 with the comments or 422 with one line, and the script
 * routes the one to stdout and the other to stderr.
 *
 * NOTE: no `electron` import, here or in `hook-server.ts` — both load under
 * vitest, and an import of it breaks the suite in a way that looks unrelated.
 */
import { commentThreadsJson, formatCommentThreads, type PdfCommentThread } from '@holi/shared'

/** What a route needs main to do. Injected, so this module stays testable
 *  without a window, a vault, or a running app. */
export interface AgentOpsDeps {
  /** Open (or focus) the app's tab in the active pane. */
  openApp(appId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Scaffold a new app directory: manifest, entry document. */
  initApp(appId: string): Promise<{ ok: true; created: string[] } | { ok: false; error: string }>
  /** Re-write the managed files Holi still owns (D75). */
  /** Run the enabled pre-commit transforms over the staged set. Called by
   *  Holi's own git hook, not by the agent — but it lives here because this is
   *  where the loopback port and its token already are. */
  runPreCommitHooks(): Promise<{ changed: string[]; failed: unknown[] }>
  refreshSeed(input: {
    path?: string
    force?: boolean
  }): Promise<{ refreshed: string[]; skipped: { path: string; reason: string }[] }>
  /** A vault PDF's comment threads, read from the saved file (D106). `path` is
   *  as the agent typed it; the dep checks it against the vault. */
  pdfComments(
    path: string,
  ): Promise<{ ok: true; path: string; threads: PdfCommentThread[] } | { ok: false; error: string }>
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
      case '/hooks/pre-commit': {
        try {
          return json(await deps.runPreCommitHooks())
        } catch (error) {
          // The hook ignores the body and exits 0 regardless; answering rather
          // than 500ing keeps the shape one branch instead of two.
          return json({ changed: [], failed: [{ error: message(error) }] })
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
      case '/pdf/comments': {
        const path = params.get('path')
        if (path === null || path === '') return text(422, 'needs a path to a PDF in the vault')
        try {
          const result = await deps.pdfComments(path)
          if (!result.ok) return text(422, result.error)
          return params.get('json') === 'true'
            ? text(200, JSON.stringify(commentThreadsJson(result.path, result.threads), null, 2))
            : text(200, formatCommentThreads(result.path, result.threads))
        } catch (error) {
          return text(422, message(error))
        }
      }
      default:
        return null
    }
  }
}
