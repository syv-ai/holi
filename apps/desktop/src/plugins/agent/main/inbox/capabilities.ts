/**
 * The agent inbox's capabilities (docs/features/agent-inbox.md), under the
 * agent's own namespace: `holi agent notify` and `holi agent log` for the
 * agent, and the inbox's list, dismiss and seen for the renderer.
 *
 * `notify` is the agent telling the person something worth their attention;
 * `log` is a line in the work log and nothing else, for what is worth
 * remembering but not an interruption. Both are harmless (a banner and a line
 * on this machine), so the seed allows them without a prompt; the quiet is in
 * the inbox's rules, not a gate.
 *
 * The work log needs only the vault's folder, so it is written even when Holi
 * does not have the vault open; the inbox is the open vault's, so a notice
 * for another vault is a log line only.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  shownPath,
  stringParam,
  type CapabilityContext,
} from '../../../../main/plugin-api'
import { JOB_ID } from '../claude/listing'
import type { Inbox, RaiseResult } from './inbox'
import type { InboxView } from './rules'
import { appendWorkLog, workLogPath } from './work-log'

export interface InboxCapabilitiesDeps {
  inbox: Inbox
  /** The open vault's remote, or null with none open. */
  liveRemote(): string | null
  now?: () => Date
}

/** Long enough for a sentence, short enough for a banner. */
const MAX_TITLE = 120
const MAX_LINE = 400

function bounded(raw: Record<string, unknown>, key: string, max: number): string {
  const value = stringParam(raw, key).trim()
  if (value === '') throw new CapabilityError('BAD_REQUEST', `${key} is empty`)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

type NotifyResult = RaiseResult | 'logged'

const NOTIFY_TEXT: Record<NotifyResult, string> = {
  banner: 'notified',
  inbox: 'added to the inbox',
  repeat: 'already in the inbox, not repeated',
  logged: 'Holi does not have this vault open: written to the work log only',
}

export const inboxCapabilities = (deps: InboxCapabilitiesDeps) => {
  const now = deps.now ?? (() => new Date())
  const isLive = (ctx: CapabilityContext): boolean => deps.liveRemote() === ctx.remote
  const live = (ctx: CapabilityContext): void => {
    if (!isLive(ctx)) throw new CapabilityError('UNAVAILABLE', 'That vault is not open in Holi.')
  }
  /** Best-effort where a notice is the point: the person has been told. */
  const logQuietly = (root: string, text: string): Promise<void> =>
    appendWorkLog(root, now(), text).catch((err: unknown) =>
      console.error(`[agent] ${workLogPath(now())}:`, err),
    )

  return {
    'agent.notify': cap({
      doors: ['cli'],
      cli: {
        args: ['title', 'line'],
        summary:
          'tell the person something that needs them; --path <file> or --session <id> is what it opens',
        job: 'session',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const path = optionalStringParam(p, 'path')
        const session = optionalStringParam(p, 'session')
        if (session !== undefined && !JOB_ID.test(session)) {
          throw new CapabilityError('BAD_REQUEST', `not a session id: ${session}`)
        }
        // What the entry opens is shown to the person, so it is held to what
        // `holi docs open` may show: never machine state or a secret file.
        const rel = path === undefined ? undefined : shownPath(path)
        return {
          title: bounded(p, 'title', MAX_TITLE),
          line: bounded(p, 'line', MAX_LINE),
          ...(rel === undefined ? {} : { path: rel }),
          ...(session === undefined ? {} : { session }),
        }
      },
      run: async (ctx, notice): Promise<NotifyResult> => {
        const link = notice.path === undefined ? '' : ` [[${notice.path}]]`
        const line = `${notice.title}: ${notice.line}${link}`
        if (!isLive(ctx)) {
          await appendWorkLog(ctx.root, now(), line)
          return 'logged'
        }
        const result = await deps.inbox.raise(notice)
        if (result !== 'repeat') await logQuietly(ctx.root, line)
        return result
      },
      text: (result) => NOTIFY_TEXT[result],
    }),

    'agent.log': cap({
      doors: ['cli'],
      cli: {
        args: ['line'],
        summary: "add a line to today's work log, .holi/state/log/<date>.local.md",
      },
      params: (raw) => ({ line: bounded(paramsObject(raw), 'line', MAX_LINE) }),
      run: async (ctx, { line }): Promise<string> => {
        const at = now()
        await appendWorkLog(ctx.root, at, line)
        return workLogPath(at)
      },
      text: (path) => `logged to ${path}`,
    }),

    'agent.inbox': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<InboxView> => {
        if (deps.liveRemote() !== ctx.remote) return { entries: [], unread: 0 }
        return deps.inbox.view()
      },
    }),

    'agent.inboxDismiss': cap({
      doors: ['ui'],
      params: (raw) => ({ id: stringParam(paramsObject(raw), 'id') }),
      run: async (ctx, { id }): Promise<InboxView> => {
        live(ctx)
        return deps.inbox.dismiss(id)
      },
    }),

    'agent.inboxSeen': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<InboxView> => {
        live(ctx)
        return deps.inbox.seen()
      },
    }),
  }
}
