import { useAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { useCallback } from 'react'

/** A react-resizable-panels layout: panel id → flexGrow weight. */
export type PanelLayout = Record<string, number>

/**
 * Resizable-panel layouts, persisted per vault. One localStorage key holds a
 * `{ [remote]: { [groupId]: layout } }` map, the same shape as `showHiddenByVaultAtom`.
 * A vault or group absent falls back to the panels' own `defaultSize`.
 */
export const panelLayoutsByVaultAtom = atomWithStorage<Record<string, Record<string, PanelLayout>>>(
  'holi:panelLayouts',
  {},
)

/**
 * Layouts for panel groups that are **not** vault content: one flat
 * `{ [groupId]: layout }` map, no remote in the key.
 *
 * Mail and the agenda are account-wide singletons, so filing their split
 * under a vault would make the same panes remember different widths per vault.
 */
export const globalPanelLayoutsAtom = atomWithStorage<Record<string, PanelLayout>>(
  'holi:panelLayouts:global',
  {},
)

/** Whether the nav drawer is showing (⌘B, `nav.toggle`). Remembered across
 *  launches and vaults: it is about the screen, not the notes. */
export const navOpenAtom = atomWithStorage('holi:navOpen', true)

/** What a `ResizablePanelGroup` needs to restore and record its layout. */
export interface PanelLayoutBinding {
  defaultLayout: PanelLayout | undefined
  onLayoutChanged: (layout: PanelLayout, meta: { isUserInteraction: boolean }) => void
}

/**
 * Bind a `ResizablePanelGroup` to the persisted layout for `groupId` under the
 * active vault. Returns `defaultLayout` to restore on mount and `onLayoutChanged`
 * to save, but only on a real user drag (`isUserInteraction`), never on the
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
 * vault (see `globalPanelLayoutsAtom`).
 *
 * The `isUserInteraction` guard is not optional: mounting
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
