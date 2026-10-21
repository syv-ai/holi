/**
 * The agent inbox's capabilities (docs/features/agent-inbox.md), under the
 * agent's own namespace: `holi agent notify` for the agent, and the inbox's
 * list, dismiss and seen for the renderer.
 *
 * `notify` is the agent telling the person something worth their attention.
 * It is harmless (a banner and a line on this machine), so the seed allows it
 * without a prompt; the quiet is in the inbox's rules, not a gate.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { vaultRelPath } from '@holi/shared'
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../../main/plugin-api'
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

const NOTIFY_TEXT: Record<RaiseResult, string> = {
  banner: 'notified',
  inbox: 'added to the inbox',
  repeat: 'already in the inbox, not repeated',
}

export const inboxCapabilities = (deps: InboxCapabilitiesDeps) => {
  const now = deps.now ?? (() => new Date())
  const live = (ctx: CapabilityContext): void => {
    if (deps.liveRemote() !== ctx.remote) {
      throw new CapabilityError('UNAVAILABLE', 'That vault is not open in Holi.')
    }
  }

  return {
    'agent.notify': cap({
      doors: ['cli'],
      cli: {
        args: ['title', 'line'],
        summary:
          'tell the person something that needs them; --path <file> or --session <id> is what it opens',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const path = optionalStringParam(p, 'path')
        const session = optionalStringParam(p, 'session')
        let rel: string | undefined
        if (path !== undefined) {
          try {
            rel = vaultRelPath(path)
          } catch (err) {
            throw new CapabilityError('BAD_REQUEST', (err as Error).message)
          }
        }
        return {
          title: bounded(p, 'title', MAX_TITLE),
          line: bounded(p, 'line', MAX_LINE),
          ...(rel === undefined ? {} : { path: rel }),
          ...(session === undefined || session === '' ? {} : { session }),
        }
      },
      run: async (ctx, notice): Promise<RaiseResult> => {
        live(ctx)
        const result = await deps.inbox.raise(notice)
        if (result !== 'repeat') {
          const link = notice.path === undefined ? '' : ` [[${notice.path}]]`
          // Best-effort: the person has been told, which is what matters.
          await appendWorkLog(ctx.root, now(), `${notice.title}: ${notice.line}${link}`).catch(
            (err: unknown) => console.error(`[agent] ${workLogPath(now())}:`, err),
          )
        }
        return result
      },
      text: (result) => NOTIFY_TEXT[result],
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
