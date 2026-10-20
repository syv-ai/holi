/**
 * A note's page toggles from its page menu (after ReUI's page actions): full
 * width, small text, and a lock (docs/features/editor.md).
 *
 * **Machine-local, per vault and note path**, like pins and panel widths. How
 * wide one person likes to read, and a guard on their own keystrokes, are not
 * facts about the note: in frontmatter they would be committed, shown to
 * everyone and to the agent, and toggling a view would be a git change. A
 * rename loses them, as it loses a pin; they are a gesture away.
 */
import { atom, type WritableAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export interface NotePage {
  fullWidth: boolean
  smallText: boolean
  locked: boolean
}

export const NOTE_PAGE_DEFAULTS: NotePage = { fullWidth: false, smallText: false, locked: false }

/** Every note's toggles that differ from the defaults, keyed `remote\0path`. */
export const notePagesAtom = atomWithStorage<Record<string, Partial<NotePage>>>('holi:notePage', {})

const keyOf = (remote: string, path: string): string => `${remote}\u0000${path}`

type PageAtom = WritableAtom<NotePage, [Partial<NotePage>], void>

const byKey = new Map<string, PageAtom>()

/** One note's toggles, read and written, one atom per note. Writing a default
 *  value drops it, so storage holds only what someone changed. */
export function notePageAtom(remote: string, path: string): PageAtom {
  const key = keyOf(remote, path)
  let a = byKey.get(key)
  if (a === undefined) {
    a = atom(
      (get): NotePage => ({ ...NOTE_PAGE_DEFAULTS, ...get(notePagesAtom)[key] }),
      (get, set, patch: Partial<NotePage>) => {
        const all = { ...get(notePagesAtom) }
        const next: Partial<NotePage> = { ...all[key], ...patch }
        for (const k of Object.keys(next) as (keyof NotePage)[]) {
          if (next[k] === NOTE_PAGE_DEFAULTS[k]) delete next[k]
        }
        if (Object.keys(next).length === 0) delete all[key]
        else all[key] = next
        set(notePagesAtom, all)
      },
    )
    byKey.set(key, a)
  }
  return a
}
