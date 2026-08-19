/**
 * The sidebar's list of vault apps — the only way to open one in slice 1.
 *
 * **Hidden entirely when the vault has no apps**, heading included. That is the
 * rule the agenda and mail chips already follow: a launcher whose only
 * destination is "go make one" is a dead end wearing the clothes of a feature,
 * and an app is made by asking the agent, not by clicking here.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { LayoutGrid } from 'lucide-react'
import { Button } from '@/primitives'
import { appIdsAtom } from '../../state/apps'
import { openApp, workspaceAtom } from '../../state/panes'

export function AppsSection(): React.JSX.Element | null {
  const appIds = useAtomValue(appIdsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  if (appIds.length === 0) return null

  return (
    <div className="flex flex-col gap-0.5 px-2 pt-2">
      <p className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">apps</p>
      {appIds.map((appId) => (
        <Button
          key={appId}
          variant="ghost"
          size="xs"
          className="h-auto justify-start gap-1.5 px-1 py-1 text-muted-foreground hover:text-foreground"
          onClick={() => setWorkspace((w) => openApp(w, appId))}
        >
          <LayoutGrid size={13} />
          {appId}
        </Button>
      ))}
    </div>
  )
}
