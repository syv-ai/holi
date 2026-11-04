import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { holiCap, type HoliFiles } from './holis-cap'
import { holisEpochAtom, type HoliSummary } from './state'

/** Its soul and memory as read, and what is on disk when a save found a run
 *  had written since. */
export function useFiles(holi: HoliSummary) {
  const remote = useAtomValue(activeRemoteAtom)
  const epoch = useAtomValue(holisEpochAtom)
  const [files, setFiles] = useState<HoliFiles | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (remote === null) return
    let gone = false
    void holiCap.files(remote, { holi: holi.id }).then(
      (f) => {
        if (!gone) {
          setFiles(f)
          setError(false)
        }
      },
      () => {
        if (!gone) setError(true)
      },
    )
    return () => {
      gone = true
    }
  }, [remote, holi.id, epoch, attempt])
  return { files, error, retry: () => setAttempt((n) => n + 1), remote }
}
