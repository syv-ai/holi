/**
 * The Home tab. Home is the setting `home`: by default the recents, shown
 * here. PaneView shows Home's app instead whenever Home names one the vault
 * has. Anything else Home is opens as itself (`state/home.ts`), so reaching
 * this with one means it was not there, or Home changed while the tab was
 * open: here it says what Home is and why it is not showing, and going there
 * is one click. A missing app can be created with the default Home app;
 * nothing is written unasked.
 */
import { appName, type HomeTarget, type RecentEntry, type SingletonSurface } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button } from '@/primitives'
import { openHomeAtom } from '@/state/home'
import { openApp, openPinned, openSingleton, workspaceAtom } from '@/state/panes'
import { recentsAtom } from '@/state/recents'
import { activeRemoteAtom } from '@/state/vaults'

const VIEW_NAMES = { board: 'the board', agenda: 'your agenda', mail: 'mail' } as const

export function HomeView({ target }: { target: HomeTarget }): React.JSX.Element {
  return target.kind === 'recents' ? <Recents /> : <NotThere target={target} />
}

/** How many recents Home lists. */
const SHOWN = 8

/** What a recent is called here, and where it lives. */
function labelOf(entry: RecentEntry): { name: string; where: string } {
  if (entry.kind === 'surface') {
    return { name: entry.key.charAt(0).toUpperCase() + entry.key.slice(1), where: '' }
  }
  const slash = entry.key.lastIndexOf('/')
  return {
    name: entry.key.slice(slash + 1).replace(/\.(md|app)$/, ''),
    where: slash < 0 ? '' : entry.key.slice(0, slash),
  }
}

/** What you opened recently: notes, files, apps and Holi's views. Sessions
 *  and terminals are left out (the sidebar lists the running ones), and so is
 *  Home itself, since you are on it. */
function Recents(): React.JSX.Element {
  const recents = useAtomValue(recentsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const entries = recents
    .filter((e) =>
      e.kind === 'surface' ? e.key !== 'home' : e.kind === 'path' || e.kind === 'app',
    )
    .slice(0, SHOWN)

  const open = (entry: RecentEntry): void =>
    setWorkspace((w) =>
      entry.kind === 'path'
        ? openPinned(w, entry.key)
        : entry.kind === 'app'
          ? openApp(w, entry.key)
          : openSingleton(w, entry.key as SingletonSurface),
    )

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8 text-sm">
      <section className="w-full max-w-[22rem]">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Recently opened</h2>
        {entries.length === 0 ? (
          <p className="text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="-mx-2">
            {entries.map((entry) => {
              const { name, where } = labelOf(entry)
              return (
                <li key={`${entry.kind}:${entry.key}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start gap-3 px-2 py-1 font-normal"
                    onClick={() => open(entry)}
                  >
                    <span className="truncate">{name}</span>
                    {where !== '' && (
                      <span className="ml-auto shrink-0 text-muted-foreground">{where}</span>
                    )}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function NotThere({
  target,
}: {
  target: Exclude<HomeTarget, { kind: 'recents' }>
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const openHome = useSetAtom(openHomeAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = (): void => {
    if (remote === null) return
    setBusy(true)
    setError(null)
    // The app appears through the vault's own rescan, and PaneView swaps it in.
    trpc.apps.createHome.mutate({ remote }).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false)
        setError((e as Error).message)
      },
    )
  }

  const name = (text: string) => <span className="text-foreground">{text}</span>
  let says: React.ReactNode
  let action: React.ReactNode = null
  switch (target.kind) {
    case 'app':
      says = <>Home is the {name(appName(target.path))} app, and this vault has none yet.</>
      action = (
        <Button variant="secondary" size="sm" disabled={busy} onClick={create}>
          Create Home app
        </Button>
      )
      break
    case 'file':
      says = <>Home is {name(target.path)}, which is not in this vault.</>
      break
    case 'daily':
      says = <>Home is today’s note, and this vault keeps no daily note.</>
      break
    default:
      says = <>Home is {VIEW_NAMES[target.kind]}.</>
      action = (
        <Button variant="secondary" size="sm" onClick={() => void openHome()}>
          Go there
        </Button>
      )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
      <p className="text-muted-foreground">{says}</p>
      {action}
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
