/**
 * The Holi dialogs: the approval, a Holi's settings, and the new-Holi wizard.
 * Contributed as one of the plugin's drawers, so a document's Agent menu,
 * which closes as a row is picked, can open them; and also mounted by the
 * Holis' sidebar section, since the fresh shell mounts no plugin drawers yet
 * and every way into them in the Agents view starts there. Whichever mounts
 * first draws them; a second copy draws nothing, so they never open twice.
 */
import { useEffect, useState } from 'react'
import { ApproveHoliDialog } from './ApproveHoliDialog'
import { HoliSettings } from './HoliSettings'
import { HoliWizard } from './wizard/HoliWizard'

let owner: symbol | null = null
const listeners = new Set<() => void>()

/** Whether this mount is the one that draws the dialogs. */
function useOwner(): boolean {
  const [me] = useState(() => Symbol('holi-dialogs'))
  const [, bump] = useState(0)
  useEffect(() => {
    const changed = () => bump((n) => n + 1)
    listeners.add(changed)
    if (owner === null) {
      owner = me
      listeners.forEach((l) => l())
    }
    return () => {
      listeners.delete(changed)
      if (owner === me) {
        owner = null
        // Another mount takes over.
        listeners.forEach((l) => l())
      }
    }
  }, [me])
  useEffect(() => {
    if (owner === null) {
      owner = me
      listeners.forEach((l) => l())
    }
  })
  return owner === me
}

export function HoliDialogs(): React.JSX.Element | null {
  if (!useOwner()) return null
  return (
    <>
      <ApproveHoliDialog />
      <HoliSettings />
      <HoliWizard />
    </>
  )
}
