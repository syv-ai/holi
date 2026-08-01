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
 * Bind a `ResizablePanelGroup` to the persisted layout for `groupId` under the
 * active vault. Returns `defaultLayout` to restore on mount and `onLayoutChanged`
 * to save — but only on a real user drag (`isUserInteraction`), never on the
 * programmatic reflow that mounting/opening a panel triggers.
 */
export function usePanelLayout(
  remote: string | null,
  groupId: string,
): {
  defaultLayout: PanelLayout | undefined
  onLayoutChanged: (layout: PanelLayout, meta: { isUserInteraction: boolean }) => void
} {
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
