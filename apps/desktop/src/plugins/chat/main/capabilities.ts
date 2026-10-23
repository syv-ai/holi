/**
 * The chat sessions' capabilities (docs/features/chat.md): the chat rows' way
 * into `chats.ts`. UI door only: a chat is what a person types into.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  cap,
  CapabilityError,
  noParams,
  optionalStringParam,
  paramsObject,
  stringParam,
  type CapabilityContext,
} from '../../../main/plugin-api'
import {
  isEffort,
  type ChatCommand,
  type ChatSummary,
  type Effort,
  type PermissionMode,
  type TranscriptItem,
} from '../shared/chat'
import type { PermissionAnswer } from './claude-stream'
import type { ChatResult, Chats, CommandTarget, TurnOptions } from './chats'
import { configDirOf, listCommands } from './commands'

export const CHAT_NAMESPACES = ['chats'] as const

/** A terminal the agent opened (`agent.open`). */
export type OpenResult = { ok: true; terminalId: string } | { ok: false; message: string }

export interface ChatCapabilitiesDeps {
  chats: Chats
  liveRemote(): string | null
  /** How Claude Code runs in the open vault (`agent.target`). */
  target(): Promise<CommandTarget | null>
  /** A terminal on a copy of a conversation: the raw view. */
  openFork(conversationId: string): Promise<OpenResult>
  /** A terminal running Claude Code's `/login` for the vault. */
  openLogin(): Promise<OpenResult>
}

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan']

function modeParam(p: Record<string, unknown>): PermissionMode | undefined {
  const v = p['mode']
  if (v === undefined || v === null) return undefined
  // Only the modes that still ask: never a bypass, whatever the caller sends.
  if (!MODES.includes(v as PermissionMode)) throw new CapabilityError('BAD_REQUEST', 'unknown mode')
  return v as PermissionMode
}

/** `model`: absent leaves it, null clears it to Claude Code's default. */
function modelParam(p: Record<string, unknown>): string | null | undefined {
  const v = p['model']
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string' || !/^[A-Za-z0-9][\w./:[\]-]*$/.test(v)) {
    throw new CapabilityError('BAD_REQUEST', 'model must be one model name')
  }
  return v
}

/** `effort`: absent leaves it, null clears it to Claude Code's default. */
function effortParam(p: Record<string, unknown>): Effort | null | undefined {
  const v = p['effort']
  if (v === undefined) return undefined
  if (v === null) return null
  if (!isEffort(v)) throw new CapabilityError('BAD_REQUEST', 'unknown effort')
  return v
}

function turnOptions(p: Record<string, unknown>): TurnOptions {
  const mode = modeParam(p)
  const model = modelParam(p)
  const effort = effortParam(p)
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

function answerParam(raw: unknown): PermissionAnswer {
  const a = paramsObject(raw)
  const kind = a['kind']
  if (kind === 'allow') return { kind: 'allow', ...(a['always'] === true ? { always: true } : {}) }
  if (kind === 'deny') return { kind: 'deny' }
  if (kind === 'answer') {
    const answers = paramsObject(a['answers'])
    const out: Record<string, string> = {}
    for (const [q, v] of Object.entries(answers)) if (typeof v === 'string') out[q] = v
    return { kind: 'answer', answers: out }
  }
  throw new CapabilityError('BAD_REQUEST', 'answer.kind is allow, deny or answer')
}

const notOpen = { ok: false as const, message: 'That vault is not open.' }

export const chatCapabilities = (deps: ChatCapabilitiesDeps) => {
  const live = (ctx: CapabilityContext): boolean => deps.liveRemote() === ctx.remote
  const id = (raw: unknown) => stringParam(paramsObject(raw), 'id')

  return {
    'chats.list': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<ChatSummary[]> => {
        if (!live(ctx)) return []
        await deps.chats.attach(ctx.remote)
        return deps.chats.list()
      },
    }),

    'chats.transcript': cap({
      doors: ['ui'],
      params: (raw) => ({ id: id(raw) }),
      run: async (ctx, { id: chat }): Promise<TranscriptItem[]> =>
        live(ctx) ? deps.chats.transcript(chat) : [],
    }),

    /** What the composer's `/` menu lists: what Claude Code runs as a
     *  command in this vault (`commands.ts`). */
    'chats.commands': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<ChatCommand[]> => {
        if (!live(ctx)) return []
        const target = await deps.target()
        if (target === null) return []
        return listCommands({
          root: target.root,
          configDir: configDirOf(target.env),
          session: deps.chats.sessionCommands(),
        })
      },
    }),

    /** Where a chat works, for the composer's chips: the clone's branch. */
    'chats.where': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<{ branch: string | null }> => {
        if (!live(ctx)) return { branch: null }
        const status = await ctx.core.repo().status()
        return { branch: status.branch === '' ? null : status.branch }
      },
    }),

    /** A new chat session whose first turn is `text`. */
    'chats.start': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const text = stringParam(p, 'text')
        const title = optionalStringParam(p, 'title')
        return { text, ...turnOptions(p), ...(title === undefined ? {} : { title }) }
      },
      run: async (ctx, args): Promise<ChatResult> => (live(ctx) ? deps.chats.start(args) : notOpen),
    }),

    'chats.send': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return { id: stringParam(p, 'id'), text: stringParam(p, 'text'), ...turnOptions(p) }
      },
      run: async (ctx, { id: chat, text, ...opts }): Promise<ChatResult> =>
        live(ctx) ? deps.chats.send(chat, text, opts) : notOpen,
    }),

    /** The person's answer to a permission card or a question, sent back to
     *  Claude Code as its own permission response. */
    'chats.answer': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        return {
          id: stringParam(p, 'id'),
          requestId: stringParam(p, 'requestId'),
          answer: answerParam(p['answer']),
        }
      },
      run: async (ctx, { id: chat, requestId, answer }): Promise<ChatResult> =>
        live(ctx) ? deps.chats.answer(chat, requestId, answer) : notOpen,
    }),

    'chats.interrupt': cap({
      doors: ['ui'],
      params: (raw) => ({ id: id(raw) }),
      run: async (ctx, { id: chat }): Promise<ChatResult> =>
        live(ctx) ? deps.chats.interrupt(chat) : notOpen,
    }),

    /** Archive, pin, mark reviewed, rename, or change how the next turn runs. */
    'chats.update': cap({
      doors: ['ui'],
      params: (raw) => {
        const p = paramsObject(raw)
        const title = optionalStringParam(p, 'title')
        const flag = (key: string): boolean | undefined =>
          typeof p[key] === 'boolean' ? (p[key] as boolean) : undefined
        const archived = flag('archived')
        const pinned = flag('pinned')
        const reviewed = flag('reviewed')
        return {
          id: stringParam(p, 'id'),
          ...turnOptions(p),
          ...(title === undefined ? {} : { title }),
          ...(archived === undefined ? {} : { archived }),
          ...(pinned === undefined ? {} : { pinned }),
          ...(reviewed === undefined ? {} : { reviewed }),
        }
      },
      run: async (ctx, { id: chat, ...change }): Promise<ChatResult> =>
        live(ctx) ? deps.chats.update(chat, change) : notOpen,
    }),

    /** Forget a chat on this machine: Holi's record and transcript of it.
     *  Claude Code's own transcript stays where Claude Code keeps it. */
    'chats.delete': cap({
      doors: ['ui'],
      params: (raw) => ({ id: id(raw) }),
      run: async (ctx, { id: chat }): Promise<ChatResult> =>
        live(ctx) ? deps.chats.remove(chat) : notOpen,
    }),

    /** Claude Code's own sign-in, in a terminal: each vault's config
     *  directory signs in once, and a chat has no TUI to type `/login` in. */
    'chats.signIn': cap({
      doors: ['ui'],
      params: noParams,
      run: async (ctx): Promise<OpenResult> => (live(ctx) ? deps.openLogin() : notOpen),
    }),

    /** A terminal on a copy of the conversation: the raw view of a chat. */
    'chats.terminal': cap({
      doors: ['ui'],
      params: (raw) => ({ id: id(raw) }),
      run: async (ctx, { id: chat }): Promise<OpenResult> => {
        if (!live(ctx)) return notOpen
        const conversation = deps.chats.conversationOf(chat)
        if (conversation === null) {
          return { ok: false, message: 'It has not started a conversation yet.' }
        }
        return deps.openFork(conversation)
      },
    }),
  }
}
