/**
 * Which open document tabs changed while another tab was in front: the strip
 * says Updated on them until they are looked at (docs/features/tabs-panes.md).
 *
 * **A change is to the text, not the file's time.** Leaving a document
 * writes its pending edits, and the commit's tidy rewrites the file seconds
 * later, so the time moves after every tab you edit and then leave. So a
 * view hands over what it showed as it goes (`sawText`), and a hidden tab's
 * new time is only a reason to read the file and compare, both sides tidied
 * the way the commit tidies (`normalizeText`). A tab never shown since it
 * opened is compared against what the file said the first time it was read.
 *
 * Kept for this window only, like the tabs themselves.
 */
import { useEffect, useRef } from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { normalizeText } from "@holi/shared"

import { trpc } from "@/lib/trpc"

import { shellWorkspaceAtom } from "./shell-tabs"
import { activeEntry, entryViews, type ShellWorkspace } from "./shell-workspace"
import { parseTabKey } from "./tab-descriptor"
import { activeRemoteAtom, snapshotAtom } from "./vaults"

/** The documents open in a tab, and those of them in front (the active
 *  tab, or every member of the active split).
 * @public exported for its test
 */
export function docTabs(ws: ShellWorkspace): {
  open: Set<string>
  showing: Set<string>
} {
  const pathOf = (key: string) => {
    const tab = parseTabKey(key)
    return tab?.kind === "doc" ? tab.path : null
  }
  const paths = (keys: string[]) =>
    new Set(keys.map(pathOf).filter((path): path is string => path !== null))
  const front = activeEntry(ws)
  return {
    open: paths(ws.entries.flatMap(entryViews)),
    showing: paths(front === null ? [] : entryViews(front)),
  }
}

/** The open vault's documents marked Updated, by path. */
export const changedDocsAtom = atom<ReadonlySet<string>>(new Set<string>())

const keyOf = (remote: string, path: string) => `${remote}\n${path}`
const tidy = (text: string, path: string) => normalizeText(text, path, [])

/** What each document last showed in its view, tidied. */
const seen = new Map<string, string>()

/** A view's last text for `path`, as it closes: what was read or saved, or
 *  the edits it is about to write. */
export function sawText(remote: string, path: string, text: string): void {
  seen.set(keyOf(remote, path), tidy(text, path))
}

/** Whether `text` on disk is something other than what the tab showed;
 *  false for a tab with nothing to compare to yet, which takes `text` as
 *  its starting point. */
function changedFromSeen(remote: string, path: string, text: string): boolean {
  const key = keyOf(remote, path)
  const now = tidy(text, path)
  const before = seen.get(key)
  if (before === undefined) seen.set(key, now)
  return before !== undefined && before !== now
}

/** Follows the open vault's document tabs and marks the hidden ones whose
 *  text changes. Mounted once, in the app shell. */
export function useDocChangeMarks(): void {
  const remote = useAtomValue(activeRemoteAtom)
  const ws = useAtomValue(shellWorkspaceAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const setChanged = useSetAtom(changedDocsAtom)
  /** Each document's time when it was last compared or shown. */
  const checked = useRef(new Map<string, string>())
  /** What is in front now, for a read that lands after a switch. */
  const showingRef = useRef<Set<string>>(new Set())
  /** The vault open now, for a read that lands after a vault switch. */
  const remoteRef = useRef(remote)
  remoteRef.current = remote

  // Another vault's marks are not this one's.
  useEffect(() => setChanged(new Set<string>()), [remote, setChanged])

  useEffect(() => {
    if (remote === null) return
    const { open, showing } = docTabs(ws)
    showingRef.current = showing
    setChanged((marked) => {
      const kept = [...marked].filter((p) => open.has(p) && !showing.has(p))
      return kept.length === marked.size ? marked : new Set(kept)
    })
    const times = new Map<string, string>()
    for (const file of [...snapshot.docs, ...snapshot.files]) {
      times.set(file.path, file.updatedAt)
    }
    for (const path of open) {
      const time = times.get(path)
      const key = keyOf(remote, path)
      if (time === undefined || checked.current.get(key) === time) continue
      checked.current.set(key, time)
      if (showing.has(path)) continue
      void trpc.notes.read
        .query({ remote, path })
        .then((text) => {
          if (!changedFromSeen(remote, path, text)) return
          if (remoteRef.current !== remote || showingRef.current.has(path)) return
          setChanged((marked) => new Set(marked).add(path))
        })
        .catch(() => undefined)
    }
  }, [remote, ws, snapshot, setChanged])
}
