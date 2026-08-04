import { useAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { useCallback } from 'react'

/** A react-resizable-panels layout: panel id → flexGrow weight. */
export type PanelLayout = Record<string, number>

/**
 * Resizable-panel layouts, persisted per vault. One localStorage key holds a
 * `{ [remote]: { [groupId]: layout } }` map — the same per-vault preference shape
 * the tree flags use ([[showHiddenByVaultAtom]] in state/vaults). A vault or group
 * absent falls back to the panels' own `defaultSize`, so a fresh vault opens at the
 * standard widths and only diverges once the user drags a handle.
 */
export const panelLayoutsByVaultAtom = atomWithStorage<Record<string, Record<string, PanelLayout>>>(
  'holi:panelLayouts',
  {},
)

/**
 * Layouts for panel groups that are **not** vault content — one flat
 * `{ [groupId]: layout }` map, no remote in the key.
 *
 * Mail and the agenda are account-wide singletons (D67): they show the same
 * Google account whichever vault is open, and one is open in the same tab strip
 * regardless. Filing their split under a vault would be wrong twice over — the
 * same two panes would remember different widths depending on which vault
 * happened to be active, and a user with no vault open would get no persistence
 * at all, because [[usePanelLayout]] cannot key a save on a null remote.
 */
export const globalPanelLayoutsAtom = atomWithStorage<Record<string, PanelLayout>>(
  'holi:panelLayouts:global',
  {},
)

/** What a `ResizablePanelGroup` needs to restore and record its layout. */
export interface PanelLayoutBinding {
  defaultLayout: PanelLayout | undefined
  onLayoutChanged: (layout: PanelLayout, meta: { isUserInteraction: boolean }) => void
}

/**
 * Bind a `ResizablePanelGroup` to the persisted layout for `groupId` under the
 * active vault. Returns `defaultLayout` to restore on mount and `onLayoutChanged`
 * to save — but only on a real user drag (`isUserInteraction`), never on the
 * programmatic reflow that mounting/opening a panel triggers.
 */
export function usePanelLayout(remote: string | null, groupId: string): PanelLayoutBinding {
  const [map, setMap] = useAtom(panelLayoutsByVaultAtom)
  const defaultLayout = remote ? map[remote]?.[groupId] : undefined
  const onLayoutChanged = useCallback(
    (layout: PanelLayout, meta: { isUserInteraction: boolean }) => {
      if (remote === null || !meta.isUserInteraction) return
      setMap((prev) => ({ ...prev, [remote]: { ...prev[remote], [groupId]: layout } }))
    },
    [remote, groupId, setMap],
  )
  return { defaultLayout, onLayoutChanged }
}

/**
 * The same binding for a group that belongs to the account rather than to a
 * vault — see [[globalPanelLayoutsAtom]] for why those are stored apart.
 *
 * The `isUserInteraction` guard is the same one, and it is not optional: mounting
 * a group, or opening a sibling panel anywhere in it, makes the library recompute
 * every size and report it with `isUserInteraction: false`. Saving that overwrites
 * the width the user actually dragged.
 */
export function useGlobalPanelLayout(groupId: string): PanelLayoutBinding {
  const [map, setMap] = useAtom(globalPanelLayoutsAtom)
  const onLayoutChanged = useCallback(
    (layout: PanelLayout, meta: { isUserInteraction: boolean }) => {
      if (!meta.isUserInteraction) return
      setMap((prev) => ({ ...prev, [groupId]: layout }))
    },
    [groupId, setMap],
  )
  return { defaultLayout: map[groupId], onLayoutChanged }
}
