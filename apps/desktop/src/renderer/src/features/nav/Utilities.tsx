/**
 * Settings and the vault's sync state as two icons of their own
 * (docs/features/nav-menu.md), where a plugin's layout takes them out of the
 * nav menu (`ShellLayout.utilities`, `header`): beside the vault's name in the
 * sidebar's header, and at the head of the rail while the sidebar is hidden,
 * so they are at the window's top left either way.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Settings } from 'lucide-react'
import { IconButton } from '@/primitives'
import { utilitiesPlacementAtom } from '@/state/plugins'
import { openSurfaceAtom } from '@/state/surfaces'
import { SyncButton } from './SyncItem'

export function Utilities({
  rail = false,
}: {
  /** Down the rail: what they open goes to the right, not below. */
  rail?: boolean
}): React.JSX.Element | null {
  const inHeader = useAtomValue(utilitiesPlacementAtom) === 'header'
  const openSurface = useSetAtom(openSurfaceAtom)
  if (!inHeader) return null
  const side = rail ? 'right' : 'bottom'
  return (
    <>
      <SyncButton side={side} />
      <IconButton
        icon={Settings}
        label="Settings"
        tooltipSide={side}
        data-utility="settings"
        onClick={() => openSurface('settings')}
      />
    </>
  )
}
