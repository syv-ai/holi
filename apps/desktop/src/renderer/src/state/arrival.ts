/**
 * Arriving at a path main asked for: a clicked reminder's task, `holi docs
 * open`, a Holi link (docs/features/holi-links.md).
 *
 * In the open vault it is a pinned tab, a deliberate arrival rather than
 * browsing. In another vault it is a vault switch first, through the same
 * `switchVaultAtom` as any other (so a switch that would cost something still
 * asks), and the tab once that vault has landed: opened earlier, the vault's
 * Home would land on top of it.
 */
import { atom } from 'jotai'
import { activeTab, focusPane, workspaceAtom } from './panes'
import { surfacesAtom } from './plugins'
import { openPathAtom } from './surfaces'
import { switchVaultAtom } from './vault-switch'
// A cycle (`vaults` subscribes through `requestArrivalAtom`), safe because
// neither module reads the other's atoms until a store does.
import { activeRemoteAtom } from './vaults'

export interface Arrival {
  remote: string
  path: string
  /** A heading to scroll to, by its slug or its words. */
  heading?: string
}

/**
 * A heading for `path`'s editor to scroll to. The editor showing `path` takes
 * it, now if it is already open, or once its document has loaded.
 */
export const headingRequestAtom = atom<{ path: string; heading: string } | null>(null)

/** An arrival waiting on its vault's switch. Only the newest waits. */
const pendingArrivalAtom = atom<Arrival | null>(null)

/**
 * Open `path` pinned, and ask for its heading. When the active tab keeps the
 * focused note (the agent's), the path opens in the pane beside it, or a new
 * one, so the agent that asked stays in view.
 */
const arriveAtom = atom(null, (get, set, { path, heading }: Arrival): void => {
  set(headingRequestAtom, heading === undefined ? null : { path, heading })
  const workspace = get(workspaceAtom)
  const tab = activeTab(workspace)
  const agent =
    tab?.kind === 'surface' && get(surfacesAtom).get(tab.surface)?.keepsFocusedNote === true
  if (!agent) return set(openPathAtom, path, 'pinned')
  const beside =
    workspace.active + 1 < workspace.panes.length ? workspace.active + 1 : workspace.active - 1
  if (beside < 0) return set(openPathAtom, path, 'pane')
  set(workspaceAtom, focusPane(workspace, beside))
  set(openPathAtom, path, 'pinned')
})

/** Main asked for an arrival: here, or after a switch to its vault. */
export const requestArrivalAtom = atom(null, (get, set, arrival: Arrival): void => {
  if (arrival.remote !== '' && arrival.remote !== get(activeRemoteAtom)) {
    set(pendingArrivalAtom, arrival)
    set(switchVaultAtom, arrival.remote)
  } else {
    set(arriveAtom, arrival)
  }
})

/**
 * The open vault has landed: arrive where a switch was waiting to. An arrival
 * for any other vault is dropped (its switch was declined), so it cannot fire
 * on some later visit.
 */
export const landArrivalAtom = atom(null, (get, set): void => {
  const pending = get(pendingArrivalAtom)
  if (pending === null) return
  set(pendingArrivalAtom, null)
  if (pending.remote === get(activeRemoteAtom)) set(arriveAtom, pending)
})
