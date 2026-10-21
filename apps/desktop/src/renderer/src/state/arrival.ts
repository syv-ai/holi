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
import { fileKind } from '@holi/shared'
import { atom } from 'jotai'
import { activeTab, focusPane, workspaceAtom } from './panes'
import { claimsAtom, surfacesAtom } from './plugins'
import { openPathAtom, tabForPathAtom } from './surfaces'
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
 * A heading for `path`'s editor to scroll to. The editor showing `path` in the
 * focused pane, where the arrival opened it, takes it: now if it is already
 * open, or once its document has loaded. Asked for only when that pane will
 * show `path` in an editor, so a request nothing takes never lingers for a
 * later visit; the next arrival replaces it either way.
 */
export const headingRequestAtom = atom<{ path: string; heading: string } | null>(null)

/** An arrival waiting on its vault: on a switch to it, or on its opening when
 *  it is already the active one. Only the newest waits. */
const pendingArrivalAtom = atom<Arrival | null>(null)

/**
 * The vault that has landed in this window (`landArrivalAtom`), or null.
 * `activeRemoteAtom` moves the moment a switch starts, so it cannot say whether
 * the vault is open yet: an arrival made before it is would be buried by the
 * vault's Home.
 */
const landedRemoteAtom = atom<string | null>(null)

/**
 * Open `path` pinned, and ask for its heading. When the active tab keeps the
 * focused note (the agent's), the path opens in the pane beside it, or a new
 * one, so the agent that asked stays in view.
 */
const arriveAtom = atom(null, (get, set, { path, heading }: Arrival): void => {
  const inEditor =
    get(tabForPathAtom)(path).kind === 'note' &&
    fileKind(path) === 'markdown' &&
    !get(claimsAtom).some((c) => c.view !== undefined && c.match(path))
  set(headingRequestAtom, heading === undefined || !inEditor ? null : { path, heading })
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

/** Main asked for an arrival: here, or once its vault has landed, after a
 *  switch to it when it is another. */
export const requestArrivalAtom = atom(null, (get, set, arrival: Arrival): void => {
  const active = get(activeRemoteAtom)
  const remote = arrival.remote === '' ? active : arrival.remote
  if (remote !== null && remote === active && remote === get(landedRemoteAtom)) {
    return set(arriveAtom, arrival)
  }
  set(pendingArrivalAtom, remote === null ? arrival : { ...arrival, remote })
  if (remote !== null && remote !== active) set(switchVaultAtom, remote)
})

/**
 * The open vault has landed: arrive where a switch was waiting to. An arrival
 * for any other vault is dropped (a later switch went elsewhere), so it cannot
 * fire on some later visit.
 */
export const landArrivalAtom = atom(null, (get, set): void => {
  const active = get(activeRemoteAtom)
  set(landedRemoteAtom, active)
  const pending = get(pendingArrivalAtom)
  if (pending === null) return
  set(pendingArrivalAtom, null)
  if (pending.remote === active) set(arriveAtom, pending)
})

/** The switch an arrival asked for was declined: the arrival goes with it, or
 *  a later visit to that vault would open a note nobody asked for then. */
export const dropArrivalAtom = atom(null, (_get, set): void => {
  set(pendingArrivalAtom, null)
})
