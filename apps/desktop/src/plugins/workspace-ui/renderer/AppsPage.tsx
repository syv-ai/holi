/**
 * The Apps page (docs/features/vault-apps.md): every finished app in the
 * vault as a tile, the most recently opened first. The nav's Apps item opens
 * it; a tile opens that app in a tab of its own. It is a page rather than a
 * drill-down of the nav menu, because a list of apps wants room to be read.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { openSurfaceAtom } from '@/plugin-api'
import { Button, Icon } from '@/primitives'
import { AppIcon } from '../../apps/renderer/AppIcon'
import { appInstancesAtom } from '../../apps/renderer/apps'
import { appName } from '../../apps/shared/bundle'

/** The folder an app lives in, as a person reads it, or '' for the root. */
export function appFolder(bundle: string): string {
  const cut = bundle.lastIndexOf('/')
  return cut === -1 ? '' : bundle.slice(0, cut)
}

export function AppsPage(): React.JSX.Element {
  const apps = useAtomValue(appInstancesAtom)
  const open = useSetAtom(openSurfaceAtom)

  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto" data-apps-page="">
      <div className="flex w-full max-w-4xl flex-col gap-4 p-6">
        <header className="flex items-baseline gap-2">
          <h1 className="text-lg font-medium text-foreground">Apps</h1>
          <span className="text-xs text-muted-foreground">
            {apps.length} {apps.length === 1 ? 'app' : 'apps'}
          </span>
        </header>

        {apps.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-xl bg-muted/50 px-6 py-16 text-center"
            data-apps-empty=""
          >
            <Icon icon={AppIcon} size="md" tone="muted" />
            <p className="text-sm text-foreground">No apps in this vault yet.</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              An app is a small page that works on your notes and tasks. Ask the agent for one, such
              as a dashboard, a tracker or a calculator, and it appears here.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((bundle) => (
              <li key={bundle}>
                {/* One tile, one press. A tile, not a row: an app is a thing
                    you open, with a glyph of its own. Flat, as the page it
                    sits on: no edge and no shadow, which are for what floats
                    (docs/ui-system.md); the press shows by its background. */}
                <Button
                  variant="ghost"
                  data-app-card={bundle}
                  className="h-auto w-full justify-start gap-3 rounded-xl bg-muted/50 p-3 text-left font-normal hover:bg-accent"
                  onClick={() => open('app', bundle)}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-background text-foreground">
                    <AppIcon className="size-5" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {appName(bundle)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {appFolder(bundle) === '' ? 'Vault root' : appFolder(bundle)}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
