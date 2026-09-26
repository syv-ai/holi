/**
 * The vault's apps as a menu, for while the nav is hidden: the nav's apps
 * section out of reach of the mouse otherwise (⌥⌘S). Beside the show-sidebar
 * button at the start of the first pane's strip. Registered apps only, opened
 * as their row opens them; an unregistered one has no manifest to open.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AppWindow } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives'
import { appIdsAtom } from '@/state/apps'
import { openApp, workspaceAtom } from '@/state/panes'

export function AppsMenu(): React.JSX.Element | null {
  const appIds = useAtomValue(appIdsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  if (appIds.length === 0) return null

  return (
    <DropdownMenu>
      <Tooltip content="apps">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label="apps"
          >
            <AppWindow size={16} />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" className="max-w-72">
        {appIds.map((appId) => (
          <DropdownMenuItem
            key={appId}
            className="text-xs"
            onSelect={() => setWorkspace((w) => openApp(w, appId))}
          >
            <span className="truncate">{appId}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
