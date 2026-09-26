/**
 * The vault's apps as a menu, for while the nav is hidden: the nav's apps
 * section out of reach of the mouse otherwise (⌥⌘S). At the foot of the rail
 * that stands in for the nav, opening to its right. Registered apps only, opened
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
import { appName } from '@holi/shared'
import { appPathsAtom } from '@/state/apps'
import { openApp, workspaceAtom } from '@/state/panes'

export function AppsMenu(): React.JSX.Element | null {
  const appPaths = useAtomValue(appPathsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  if (appPaths.length === 0) return null

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
      <DropdownMenuContent side="right" align="start" className="max-w-72">
        {appPaths.map((path) => (
          <DropdownMenuItem
            key={path}
            className="text-xs"
            onSelect={() => setWorkspace((w) => openApp(w, path))}
          >
            <span className="truncate">{appName(path)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
