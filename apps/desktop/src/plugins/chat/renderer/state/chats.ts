/**
 * The chat rows' state: the vault's chat sessions, their transcripts, which
 * one the Agents view shows, and what you do to them (docs/features/chat.md).
 *
 * Main owns every session (`main/chats.ts`) and tells this side the list
 * (`chats`) and each transcript's changed items (`chat-items`) as events. A
 * transcript is asked for when a session is first shown, then kept in step by
 * the events. What the Agents view shows is core's `agentsSelectionAtom`:
 * this plugin's rows select `{owner: 'chat', id}`, `new` for the composer.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  activeRemoteAtom,
  agentsSelectionAtom,
  appModeAtom,
  type AgentsSessionItem,
  type AgentsStatus,
  type PluginEventHandler,
} from '@/plugin-api'
import { chatCap } from '../chat-cap'
import type { ChatSummary, PermissionMode, TranscriptItem } from '../../shared/chat'

export { chatCap }

/** The chat plugin's id: the owner of its rows in the Agents view. */
export const CHAT_OWNER = 'chat'

/** The vault's chat sessions, most recently active first. */
export const chatsAtom = atom<ChatSummary[]>([])

/** Each shown session's transcript, by session id. */
export const transcriptsAtom = atom<Record<string, TranscriptItem[]>>({})

/** Whether the list has come back from main once, so an empty list means
 *  none rather than not asked yet. */
export const chatsLoadedAtom = atom(false)

/** Main never answered the list: the session list offers Retry. */
export const chatsErrorAtom = atom(false)

/** What the chat rows put in the Agents view: the composer, or a chat. */
export type ChatView = { kind: 'none' } | { kind: 'new' } | { kind: 'chat'; id: string }

export const chatViewAtom = atom(
  (get): ChatView => {
    const sel = get(agentsSelectionAtom)
    if (sel === null || sel.owner !== CHAT_OWNER) return { kind: 'none' }
    return sel.id === 'new' ? { kind: 'new' } : { kind: 'chat', id: sel.id }
  },
  (_get, set, view: ChatView) =>
    set(
      agentsSelectionAtom,
      view.kind === 'none'
        ? null
        : { owner: CHAT_OWNER, id: view.kind === 'new' ? 'new' : view.id },
    ),
)

/** What a new chat runs with unless the composer says otherwise: this
 *  person's last pick, kept on this machine. */
export interface ComposerPrefs {
  model: string | null
  mode: PermissionMode
}

export const composerPrefsAtom = atomWithStorage<ComposerPrefs>('holi.chat.composer', {
  model: null,
  mode: 'default',
})

/** Unsent text, per composer: `new` and each session's id. */
export const draftsAtom = atom<Record<string, string>>({})

/** The chats the sidebar lists: not archived. */
export const sidebarChatsAtom = atom((get) => get(chatsAtom).filter((c) => !c.archived))

/** A chat's row key in the Agents sidebar's session list. */
export const chatKey = (id: string): string => `${CHAT_OWNER}:${id}`

/** A chat as a row of the agent's session list (its slot's `sessions`):
 *  selecting it shows the conversation in the chat's main view. */
export function chatItem(c: ChatSummary): AgentsSessionItem {
  return {
    key: chatKey(c.id),
    selection: { owner: CHAT_OWNER, id: c.id },
    title: c.title,
    state: c.state,
    updatedAt: c.updatedAt,
    archived: c.archived,
    ...(c.model === undefined ? {} : { model: c.model }),
    ...(c.waitingFor === undefined ? {} : { waitingFor: c.waitingFor }),
    ...(c.endedAt === undefined ? {} : { endedAt: c.endedAt }),
  }
}

export const chatSessionItemsAtom = atom((get) => get(chatsAtom).map(chatItem))

export const chatSessionsStatusAtom = atom((get): 'loading' | 'ready' | 'error' =>
  get(chatsLoadedAtom) ? 'ready' : get(chatsErrorAtom) ? 'error' : 'loading',
)

/** Ask main for the list again: the session list's Retry. */
export const reloadChatsAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(chatsErrorAtom, false)
  try {
    set(chatsAtom, await chatCap.list(remote))
    set(chatsLoadedAtom, true)
  } catch {
    set(chatsErrorAtom, true)
  }
})

/** Archive a chat by its row key, or bring it back. */
export const archiveChatRowAtom = atom(null, (_get, set, key: string, archived: boolean) => {
  const prefix = `${CHAT_OWNER}:`
  if (!key.startsWith(prefix)) return
  return set(updateChatAtom, { id: key.slice(prefix.length), archived })
})

/** What the chats add to the mode toggle's report. */
export const chatStatusAtom = atom((get): AgentsStatus => {
  let needsYou = 0
  let working = 0
  for (const c of get(chatsAtom)) {
    if (c.state === 'needs-you') needsYou++
    else if (c.state === 'working') working++
  }
  return { needsYou, working }
})

/** Merge changed items into a transcript, by id, keeping order. */
export function mergeItems(
  items: readonly TranscriptItem[],
  changed: readonly TranscriptItem[],
): TranscriptItem[] {
  const next = [...items]
  for (const item of changed) {
    const at = next.findIndex((i) => i.id === item.id)
    if (at === -1) next.push(item)
    else next[at] = item
  }
  return next
}

export const chatEvents: Readonly<Record<string, PluginEventHandler>> = {
  chats: ({ remote, payload }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    store.set(chatsAtom, payload as ChatSummary[])
    store.set(chatsLoadedAtom, true)
  },
  'chat-items': ({ remote, payload }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    const { id, items } = payload as { id: string; items: TranscriptItem[] }
    store.set(transcriptsAtom, (all) => ({ ...all, [id]: mergeItems(all[id] ?? [], items) }))
  },
}

/**
 * Ask until main answers: the renderer can ask before the vault's plugin has
 * started in main, which refuses as "no such method". A few tries a second
 * apart, then the events are what fill it.
 */
export function askSoon<T>(
  ask: () => Promise<T>,
  then: (value: T) => void,
  tries = 8,
  fail?: () => void,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const go = (left: number): void => {
    ask()
      .then((value) => {
        if (!stopped) then(value)
      })
      .catch(() => {
        if (stopped) return
        if (left > 1) timer = setTimeout(() => go(left - 1), 1_000)
        else fail?.()
      })
  }
  go(tries)
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

/** Fill the lists for the open vault; the events keep them in step. */
export function chatsVault(
  remote: string,
  store: Parameters<NonNullable<PluginEventHandler>>[1],
): () => void {
  const asked = store.get(chatsAtom)
  const offList = askSoon(
    () => chatCap.list(remote),
    (list) => {
      if (store.get(chatsAtom) === asked) store.set(chatsAtom, list)
      store.set(chatsLoadedAtom, true)
    },
    8,
    () => store.set(chatsErrorAtom, true),
  )
  return () => {
    offList()
    store.set(chatsAtom, [])
    store.set(transcriptsAtom, {})
    store.set(chatsLoadedAtom, false)
    store.set(chatsErrorAtom, false)
    store.set(draftsAtom, {})
  }
}

/** What an action answers: done, or why not, in words to show. */
export type ChatActionResult = { ok: true; id?: string } | { ok: false; message: string }

const NO_VAULT = { ok: false as const, message: 'No vault is open.' }

/** Ask for a transcript the first time it is shown. */
export const loadTranscriptAtom = atom(null, async (get, set, id: string) => {
  const remote = get(activeRemoteAtom)
  if (remote === null || get(transcriptsAtom)[id] !== undefined) return
  const items = await chatCap.transcript(remote, { id })
  // Events that landed while this was in flight are newer than the file.
  set(transcriptsAtom, (all) => ({ ...all, [id]: mergeItems(items, all[id] ?? []) }))
})

/** A new chat session whose first turn is `text`, brought forward. */
export const startChatAtom = atom(
  null,
  async (
    get,
    set,
    args: { text: string; model?: string | null; mode?: PermissionMode },
  ): Promise<ChatActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return NO_VAULT
    const prefs = get(composerPrefsAtom)
    const res = await chatCap.start(remote, {
      text: args.text,
      mode: args.mode ?? prefs.mode,
      ...((args.model ?? prefs.model) ? { model: args.model ?? prefs.model } : {}),
    })
    if (!res.ok) return res
    set(chatViewAtom, { kind: 'chat', id: res.id })
    set(appModeAtom, 'agents')
    return { ok: true, id: res.id }
  },
)

export const sendChatAtom = atom(
  null,
  async (
    get,
    _set,
    args: {
      id: string
      text: string
      model?: string | null
      mode?: PermissionMode
    },
  ): Promise<ChatActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return NO_VAULT
    return chatCap.send(remote, args)
  },
)

export const answerChatAtom = atom(
  null,
  async (
    get,
    _set,
    args: {
      id: string
      requestId: string
      answer:
        | { kind: 'allow'; always?: boolean }
        | { kind: 'deny' }
        | { kind: 'answer'; answers: Record<string, string> }
    },
  ): Promise<ChatActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return NO_VAULT
    return chatCap.answer(remote, args)
  },
)

export const interruptChatAtom = atom(null, async (get, _set, id: string) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return NO_VAULT
  return chatCap.interrupt(remote, { id })
})

export const updateChatAtom = atom(
  null,
  async (
    get,
    set,
    args: {
      id: string
      archived?: boolean
      reviewed?: boolean
      title?: string
      model?: string | null
      mode?: PermissionMode
    },
  ): Promise<ChatActionResult> => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return NO_VAULT
    const res = await chatCap.update(remote, args)
    // An archived session leaves the view it was shown in.
    const view = get(chatViewAtom)
    if (res.ok && args.archived === true && view.kind === 'chat' && view.id === args.id) {
      set(chatViewAtom, { kind: 'new' })
    }
    return res
  },
)

/** Show the Agents view at the chat composer: New chat. */
export const newChatViewAtom = atom(null, (_get, set) => {
  set(chatViewAtom, { kind: 'new' })
  set(appModeAtom, 'agents')
})
