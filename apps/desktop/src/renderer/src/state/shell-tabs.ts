/**
 * The shell's open tabs and panes as state (`shell-workspace.ts` holds the
 * rules), one workspace per vault: switching vaults shows that vault's tabs,
 * and coming back finds them as they were. Kept in memory, as the shell's
 * tabs always were; a restart opens on an empty pane
 * (docs/features/tabs-panes.md).
 *
 * `openTabAtom` is the seam for everything that is not the shell: a plugin
 * asks for a tab by its descriptor (an agent session "to the side"), and the
 * shell's own effects (an app folding the sidebar) follow from the tab that
 * comes forward.
 */
import { atom } from "jotai"

import {
  emptyWorkspace,
  openBeside,
  openTab,
  type ShellWorkspace,
} from "./shell-workspace"
import { tabKey, type TabDescriptor } from "./tab-descriptor"
import { activeRemoteAtom } from "./vaults"

const workspacesAtom = atom<Record<string, ShellWorkspace>>({})
const EMPTY = emptyWorkspace()

/** The open vault's workspace. Written with a value or an update. */
export const shellWorkspaceAtom = atom(
  (get): ShellWorkspace =>
    get(workspacesAtom)[get(activeRemoteAtom) ?? ""] ?? EMPTY,
  (
    get,
    set,
    update: ShellWorkspace | ((ws: ShellWorkspace) => ShellWorkspace)
  ) => {
    const remote = get(activeRemoteAtom) ?? ""
    const current = get(workspacesAtom)[remote] ?? EMPTY
    const next = typeof update === "function" ? update(current) : update
    if (next === current) return
    set(workspacesAtom, (all) => ({ ...all, [remote]: next }))
  }
)

/** Open a tab, or focus it where it is; `beside` puts it in the pane next
 *  to the focused one (a new pane while there is room). */
export const openTabAtom = atom(
  null,
  (_get, set, tab: TabDescriptor, options?: { beside?: boolean }) => {
    const key = tabKey(tab)
    set(shellWorkspaceAtom, (ws) =>
      options?.beside ? openBeside(ws, key) : openTab(ws, key)
    )
  }
)
