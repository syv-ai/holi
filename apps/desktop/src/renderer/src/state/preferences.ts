import { useAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { useCallback } from 'react'

/** A react-resizable-panels layout: panel id → flexGrow weight. */
type PanelLayout = Record<string, number>

/**
 * Layouts for panel groups, persisted as one flat `{ [groupId]: layout }` map
 * under a single localStorage key.
 *
 * Mail and the agenda are account-wide singletons, so filing their split
 * under a vault would make the same panes remember different widths per vault.
 * @public exported for its test
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
