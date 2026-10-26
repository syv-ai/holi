/**
 * A vault app in a tab: a header with its name and folder, the controls the
 * `app` surface brings (Reload, the log) and Edit source, which opens the
 * bundle's `index.html` beside it; then the app itself. Everything app-shaped
 * comes from the registry's `app` surface, so core never imports the plugin.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AppWindowIcon, CodeIcon, SearchIcon } from 'lucide-react'

import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { Button } from '@/components/ui/button'
import { ViewHeader, ViewHeaderTitle } from '@/composites/view-header'
import { surfacesAtom } from '@/state/plugins'
import { openTabAtom } from '@/state/shell-tabs'

export function VaultAppTab({ path, onOpenSearch }: { path: string; onOpenSearch: () => void }) {
  const surface = useAtomValue(surfacesAtom).get('app')
  const openTab = useSetAtom(openTabAtom)

  if (surface === undefined) {
    return (
      <IconStackEmpty
        icon={AppWindowIcon}
        title="Vault apps are off"
        description="Turn on the Vault apps plugin in Settings to open this app."
        action={{ label: 'Search', icon: SearchIcon, onClick: onOpenSearch }}
      />
    )
  }

  const App = surface.render
  const Actions = surface.headerActions
  const name = typeof surface.label === 'function' ? surface.label(path) : surface.label
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const Icon = surface.icon

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader>
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <ViewHeaderTitle
          title={name}
          meta={folder !== null ? <span className="truncate">{folder}</span> : undefined}
        />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Edit source"
            onClick={() => openTab({ kind: 'doc', path: `${path}/index.html` }, { beside: true })}
          >
            <CodeIcon data-icon="inline-start" aria-hidden="true" />
            {/* The label gives way in a narrow pane; the name stays. */}
            <span className="hidden @lg/view-header:inline">Edit source</span>
          </Button>
          {Actions !== undefined ? <Actions id={path} /> : null}
        </div>
      </ViewHeader>
      <App key={path} id={path} visible />
    </div>
  )
}
