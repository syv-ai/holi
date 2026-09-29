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
 * **`/pdf/comments` is the one exception**: its output is the answer itself, so
 * it answers `text/plain`, 200 with the comments or 422 with one line, and the
 * script routes them to stdout and stderr the way `cat` would.
 *
 * NOTE: no `electron` import, here or in `hook-server.ts`: both load under
 * vitest.
 */
import { commentThreadsJson, formatCommentThreads, type PdfCommentThread } from '@holi/shared'
import type { TaskDoneResult } from '../vault/task-done'
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
  /** A vault PDF's comment threads, read from the saved file. `path` is
   *  as the agent typed it; the dep checks it against the vault. */
  pdfComments(
    path: string,
  ): Promise<{ ok: true; path: string; threads: PdfCommentThread[] } | { ok: false; error: string }>
  /** `holi task done`: complete a task the way the app does, so a recurring
   *  one rolls forward. `path` is as the agent typed it. */
  taskDone(path: string): Promise<TaskDoneResult>
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
      case '/task/done': {
        const path = params.get('path')
        if (path === null || path === '')
          return json({ ok: false, error: 'task/done needs a path' })
        try {
          return json(await deps.taskDone(path))
        } catch (error) {
          return json({ ok: false, error: message(error) })
        }
      }
      default:
        return null
    }
  }
}
