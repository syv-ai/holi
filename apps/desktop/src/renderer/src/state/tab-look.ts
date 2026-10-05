/**
 * What naming and marking a tab needs from the open vault and the surface
 * registry (`composites/tab-look.tsx`), read once per list of tabs.
 */
import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { snapshotTasks } from '@holi/shared'
import type { PathMarks, TabSources } from '@/composites/tab-look'
import { surfaceTabLooksAtom, surfacesAtom } from './plugins'
import { snapshotAtom } from './vaults'

export function useTabLook(): { marks: PathMarks; sources: TabSources } {
  const snapshot = useAtomValue(snapshotAtom)
  const marks = useMemo<PathMarks>(
    () => ({
      icons: snapshot.icons,
      tasks: new Map(snapshotTasks(snapshot).items.map((t) => [t.path, t.status])),
    }),
    [snapshot],
  )
  const surfaces = useAtomValue(surfacesAtom)
  const looks = useAtomValue(surfaceTabLooksAtom)
  const sources = useMemo<TabSources>(() => ({ surfaces, looks }), [surfaces, looks])
  return { marks, sources }
}
