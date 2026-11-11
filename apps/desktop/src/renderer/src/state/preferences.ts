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

/** Whether this machine enables Vim keys in code and plain-text file editors. */
export const vimCodeEditingAtom = atomWithStorage<boolean>(
  'holi:vimCodeEditing',
  false,
  {
    getItem(key) {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
        return typeof value === 'boolean' ? value : false
      } catch {
        return false
      }
    },
    setItem(key, value) {
      localStorage.setItem(key, JSON.stringify(value))
    },
    removeItem(key) {
      localStorage.removeItem(key)
    },
  },
  { getOnInit: true },
)

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
