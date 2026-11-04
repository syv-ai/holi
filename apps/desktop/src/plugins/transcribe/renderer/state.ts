/**
 * The meetings as the window knows them: main's list and each meeting's
 * live state, kept in step by the plugin's `meetings` and `meeting` events,
 * the profiles, whether a speech key is set, and what the surface is showing.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { activeRemoteAtom, type PluginEventHandler, type PluginStore } from '@/plugin-api'
import type { SpeechKeyStatus } from '../main/speech-key'
import type {
  Card,
  MeetingProfile,
  MeetingState,
  MeetingSummary,
  Segment,
  SendTarget,
  Topic,
} from '../shared/meeting'
import { meetingCap } from './meeting-cap'

export const MEETINGS_SURFACE = 'meetings'

/** A failure in words to show. */
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Main's list of this vault's meetings, newest first; null until it answers. */
export const meetingsAtom = atom<readonly MeetingSummary[] | null>(null)
export const meetingsErrorAtom = atom<string | null>(null)

/** Each meeting fetched or heard about, by id. */
export const meetingStatesAtom = atom<Readonly<Record<string, MeetingState>>>({})

/** The meeting the surface shows; null shows the list. */
export const shownMeetingIdAtom = atom<string | null>(null)

/** The vault's meeting profiles; null until main answers. */
export const profilesAtom = atom<readonly MeetingProfile[] | null>(null)

/** Whether this machine or the vault has a speech key, and which; null
 *  until main answers. Never the key. */
export const speechKeyAtom = atom<SpeechKeyStatus | null>(null)

const pickedProfileAtom = atom<string | null>(null)

/** The profile the next Record uses: the one picked, else the first. */
export const selectedProfileIdAtom = atom(
  (get): string | null => {
    const list = get(profilesAtom) ?? []
    const picked = get(pickedProfileAtom)
    return list.some((p) => p.id === picked) ? picked : (list[0]?.id ?? null)
  },
  (_get, set, id: string) => set(pickedProfileAtom, id),
)

/** A quote clicked: the segment the transcript scrolls to and marks. `n`
 *  counts clicks, so clicking the same quote twice scrolls twice. */
export const highlightAtom = atom<{ meetingId: string; i: number; n: number } | null>(null)
let clicks = 0
export const highlightSegmentAtom = atom(null, (_get, set, meetingId: string, i: number) =>
  set(highlightAtom, { meetingId, i, n: ++clicks }),
)

/** Whether a live meeting shows its whole transcript as a column, or only
 *  its last lines in a strip: the strip until the person asks, remembered on
 *  this machine. */
export const showTranscriptAtom = atomWithStorage<boolean>(
  'holi.meetings.show-transcript',
  false,
  undefined,
  { getOnInit: true },
)

/** When Hviske was last asked to change a meeting's groups (Ask Hviske), and
 *  when it had last written one then: the minutes say Hviske is on it until
 *  it writes again. */
export const minutesAskedAtom = atom<
  Readonly<Record<string, { at: number; minutesAt: number | undefined }>>
>({})

/** The card open in the task panel, if any. */
export const openTaskAtom = atom<{ meetingId: string; cardId: string } | null>(null)

/** The group, or a suggestion in it, open in the Send panel, if any. */
export const sendPanelAtom = atom<{
  meetingId: string
  topicId: string
  suggestionId?: string
} | null>(null)

/** Who Send sends a card to: the last one picked, the vault's agent to
 *  begin with. */
export const sendTargetAtom = atom<SendTarget>({ kind: 'agent' })

export const loadMeetingsAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(meetingsErrorAtom, null)
  try {
    set(meetingsAtom, await meetingCap.list(remote))
  } catch (e) {
    set(meetingsErrorAtom, message(e))
  }
})

const loadProfilesAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  try {
    set(profilesAtom, await meetingCap['profiles.list'](remote))
  } catch {
    set(profilesAtom, [])
  }
})

/** Ask main again whether a speech key is set. */
export const loadSpeechKeyAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  try {
    set(speechKeyAtom, await meetingCap['key.status'](remote))
  } catch {
    // Unknown stays unknown: no notice is better than a wrong one.
  }
})

/** Fetch one meeting's whole state; rejects with the reason it could not. */
export const loadMeetingAtom = atom(null, async (get, set, meetingId: string): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const state = await meetingCap.get(remote, { meetingId })
  set(meetingStatesAtom, (all) => ({ ...all, [meetingId]: state }))
})

/** A card main answered with, put in its meeting at once rather than waiting
 *  for the next `meeting` event: in place of the one it changes, or added. */
export const putCardAtom = atom(null, (_get, set, meetingId: string, card: Card) =>
  set(meetingStatesAtom, (all) => {
    const m = all[meetingId]
    if (m === undefined) return all
    const cards = m.cards.some((c) => c.id === card.id)
      ? m.cards.map((c) => (c.id === card.id ? card : c))
      : [...m.cards, card]
    return { ...all, [meetingId]: { ...m, cards } }
  }),
)

/** A line main answered with, put in its meeting at once. */
export const putSegmentAtom = atom(null, (_get, set, meetingId: string, segment: Segment) =>
  set(meetingStatesAtom, (all) => {
    const m = all[meetingId]
    if (m === undefined) return all
    return {
      ...all,
      [meetingId]: {
        ...m,
        segments: m.segments.map((s) => (s.i === segment.i ? segment : s)),
        cards: m.cards.map((c) =>
          c.quotes.some((q) => q.i === segment.i)
            ? {
                ...c,
                quotes: c.quotes.map((q) => (q.i === segment.i ? { ...q, text: segment.text } : q)),
              }
            : c,
        ),
      },
    }
  }),
)

/** Groups main answered with (a split or merge), put in their meeting at once. */
export const putTopicsAtom = atom(null, (_get, set, meetingId: string, topics: Topic[]) =>
  set(meetingStatesAtom, (all) => {
    const m = all[meetingId]
    if (m === undefined) return all
    return { ...all, [meetingId]: { ...m, topics } }
  }),
)

/** One group main answered with (an edit), put in its meeting at once. */
export const putTopicAtom = atom(null, (_get, set, meetingId: string, topic: Topic) =>
  set(meetingStatesAtom, (all) => {
    const m = all[meetingId]
    if (m === undefined) return all
    return {
      ...all,
      [meetingId]: { ...m, topics: m.topics.map((t) => (t.id === topic.id ? topic : t)) },
    }
  }),
)

/** A meeting the person stopped: shown as finishing until main says more. */
export const markStoppedAtom = atom(null, (_get, set, meetingId: string) =>
  set(meetingStatesAtom, (all) => {
    const m = all[meetingId]
    if (m?.phase !== 'recording') return all
    return { ...all, [meetingId]: { ...m, phase: 'finishing', endedAt: Date.now() } }
  }),
)

export const transcribeEvents: Readonly<Record<string, PluginEventHandler>> = {
  meeting: ({ remote, payload }, store) => {
    const m = payload as MeetingState
    if (remote !== store.get(activeRemoteAtom) || typeof m?.id !== 'string') return
    store.set(meetingStatesAtom, (all) => ({ ...all, [m.id]: m }))
  },
  meetings: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom) && Array.isArray(payload)) {
      store.set(meetingsAtom, payload as MeetingSummary[])
    }
  },
}

/** While `remote` is open: its meetings and profiles, forgotten when it closes. */
export function meetingsVault(_remote: string, store: PluginStore): () => void {
  void store.set(loadMeetingsAtom)
  void store.set(loadProfilesAtom)
  void store.set(loadSpeechKeyAtom)
  return () => {
    store.set(speechKeyAtom, null)
    store.set(meetingsAtom, null)
    store.set(meetingStatesAtom, {})
    store.set(profilesAtom, null)
    store.set(shownMeetingIdAtom, null)
    store.set(openTaskAtom, null)
    store.set(minutesAskedAtom, {})
    store.set(sendPanelAtom, null)
    store.set(sendTargetAtom, { kind: 'agent' })
  }
}
