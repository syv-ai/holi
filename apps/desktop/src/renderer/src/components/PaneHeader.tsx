/**
 * The row under a pane's tabs (after Linear's and Notion's page header):
 * where the active tab is, as a breadcrumb, and what can be done to it at the
 * right end (the surface's own controls, history, Agent). On a note, Agent is
 * a split button whose menu holds what plugins offer to do with the document
 * (`RendererPlugin.documentActions`), which core draws without knowing.
 *
 * A note's breadcrumb is its folders, muted, then its name; a surface's is
 * its name. The folders are text, not links: the tree is where folders open.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Bot, ChevronDown } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Icon,
  IconButton,
} from '@/primitives'
import { useAgentsMode } from '@/features/nav/ModeToggle'
import { appModeAtom } from '@/state/app-mode'
import type { Tab } from '@/state/panes'
import { runningPluginsAtom, surfaceTabLooksAtom, surfacesAtom } from '@/state/plugins'
import { tabName } from './TabStrip'

export function PaneHeader({
  tab,
  actions,
}: {
  tab: Tab | null
  actions?: ReactNode
}): React.JSX.Element | null {
  const surfaces = useAtomValue(surfacesAtom)
  const looks = useAtomValue(surfaceTabLooksAtom)
  const agents = useAgentsMode()
  const setMode = useSetAtom(appModeAtom)
  const plugins = useAtomValue(runningPluginsAtom)
  if (tab === null) return null
  const docActions =
    tab.kind === 'note'
      ? plugins.flatMap((p) =>
          p.documentActions === undefined ? [] : [{ id: p.info.id, Rows: p.documentActions }],
        )
      : []

  const name = tabName(tab, { surfaces, looks })
  const folders = tab.kind === 'note' ? tab.path.split('/').slice(0, -1) : []

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-divider bg-background px-3">
      <nav aria-label="Where you are" className="flex min-w-0 flex-1 items-center gap-1.5 text-nav">
        {folders.map((f, i) => (
          <Fragment key={i}>
            <span className="max-w-40 shrink truncate text-muted-foreground">{f}</span>
            <span aria-hidden className="text-muted-foreground/50">
              /
            </span>
          </Fragment>
        ))}
        <span aria-current="page" className="min-w-0 truncate text-foreground">
          {name}
        </span>
      </nav>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {agents !== undefined && (
          <div className="ms-1 flex items-center gap-px">
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => setMode('agents')}
            >
              <Icon icon={Bot} size="sm" />
              Agent
            </Button>
            {docActions.length > 0 && tab.kind === 'note' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton icon={ChevronDown} label="More with this document" size="md" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {docActions.map(({ id, Rows }) => (
                    <Rows key={id} path={tab.path} />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
