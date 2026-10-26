/**
 * What is wrong with the vault's planning files, said above the tasks: the
 * statuses file that could not be read or understood, and task files that
 * could not be parsed. Null when there is nothing to say.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { FileWarningIcon, TriangleAlertIcon } from 'lucide-react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/reui/alert'
import { Button } from '@/components/ui/button'
import { retryPlanningFilesAtom, statusesFileAtom } from '@/state/planning'
import { brokenTasksAtom } from '@/state/tasks'
import { loadSnapshotAtom } from '@/state/vaults'

import { reportError } from './report-error'

export function usePlanningNotices(): React.ReactNode | null {
  const statusesFile = useAtomValue(statusesFileAtom)
  const broken = useAtomValue(brokenTasksAtom)
  const retryFiles = useSetAtom(retryPlanningFilesAtom)
  const reload = useSetAtom(loadSnapshotAtom)

  const hasNotices =
    statusesFile.state === 'error' ||
    (statusesFile.state === 'ready' && statusesFile.warnings.length > 0) ||
    broken.length > 0
  if (!hasNotices) return null

  return (
    <>
      {statusesFile.state === 'error' ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>The statuses file could not be read</AlertTitle>
          <AlertDescription>Showing the default columns. {statusesFile.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={retryFiles}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : statusesFile.state === 'ready' && statusesFile.warnings.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Part of .holi/statuses.yaml was not understood</AlertTitle>
          <AlertDescription>{statusesFile.warnings.join(' ')}</AlertDescription>
        </Alert>
      ) : null}
      {broken.length > 0 ? (
        <Alert variant="destructive">
          <FileWarningIcon aria-hidden="true" />
          <AlertTitle>
            {broken.length} task {broken.length === 1 ? 'file' : 'files'} could not be read
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-0.5">
              {broken.map((b) => (
                <li key={b.path} data-broken-task={b.path}>
                  <span className="font-mono">{b.path}</span>: {b.error}
                </li>
              ))}
            </ul>
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void reload().catch(reportError('The vault could not be read'))}
            >
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </>
  )
}
