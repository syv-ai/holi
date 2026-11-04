import { useMemo } from 'react'
import { useAtomValue } from 'jotai'

import { activityEntriesAtom, activityQueryAtom, activitySearchAtom } from '@/state/activity'

import { LogSearch } from './log-search'
import { outputFilterFields } from './output-filters'

/** The Output's search: the vaults the log has named become Vault's options. */
export function OutputSearch() {
  const entries = useAtomValue(activityEntriesAtom)
  const remotes = useMemo(
    () => [...new Set(entries.flatMap((e) => (e.remote === undefined ? [] : [e.remote])))].sort(),
    [entries],
  )
  const fields = useMemo(() => outputFilterFields(remotes), [remotes])
  return (
    <LogSearch
      searchAtom={activitySearchAtom}
      queryAtom={activityQueryAtom}
      fields={fields}
      placeholder="Search output…"
      label="Search the output"
    />
  )
}
