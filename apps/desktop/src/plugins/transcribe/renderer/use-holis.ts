/**
 * The vault's Holis a card can be sent to, while the Holis plugin offers
 * `holis.send`; none otherwise, and Send goes to Claude alone. Asked once per
 * view.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, useHasCapability } from '@/plugin-api'
import { holisCap } from './holis-cap'

export function useHolis(): readonly PickableHoli[] {
  const remote = useAtomValue(activeRemoteAtom)
  const has = useHasCapability('holis.send')
  const [list, setList] = useState<readonly PickableHoli[]>([])
  useEffect(() => {
    if (remote === null || !has) {
      setList([])
      return
    }
    let gone = false
    void holisCap.list(remote).then(
      (all) => {
        if (!gone) setList(all.filter((h) => h.status !== 'invalid'))
      },
      () => {},
    )
    return () => {
      gone = true
    }
  }, [remote, has])
  return list
}
