/**
 * The Home tab. Home is the setting `home`: by default the recents, shown
 * here under the vault's README when it has one. The home surface shows Home's folder document (an app) instead
 * whenever Home names one the vault has. Anything else Home is opens as
 * itself (`state/home.ts`), so reaching this with one means it was not there,
 * or Home changed while the tab was open: here it says what Home is and why
 * it is not showing, and going there is one click.
 */
import type { HomeTarget, RecentEntry } from '@holi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { MarkdownText } from '@/composites'
import { trpc } from '@/lib/trpc'
import { surfaceLabel } from '@/lib/folder-documents'
import { Button } from '@/primitives'
import type { Surface } from '@/plugin-api/types'
import { openHomeAtom } from '@/state/home'
import { openPinned, openSurface, workspaceAtom } from '@/state/panes'
import { surfacesAtom } from '@/state/plugins'
import { recentsAtom } from '@/state/recents'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

export function HomeView({ target }: { target: HomeTarget }): React.JSX.Element {
  return target.kind === 'recents' ? <Recents /> : <NotThere target={target} />
}

/** How many recents Home lists. */
const SHOWN = 8

/** Where a path lives: its folder. */
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

/** What a recent is called here, and where it lives. */
function labelOf(
  entry: RecentEntry,
  surfaces: ReadonlyMap<string, Surface>,
): { name: string; where: string } {
  if (entry.kind === 'surface') {
    const surface = surfaces.get(entry.key)
    return {
      name: surface === undefined ? '' : surfaceLabel(surface, entry.id),
      where: entry.id === undefined ? '' : folderOf(entry.id),
    }
  }
  return {
    name: entry.key.slice(entry.key.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    where: folderOf(entry.key),
  }
}

/** What you opened recently: notes, files, apps and Holi's views. Tabs of an
 *  unlisted surface (an agent's terminals) are left out, and so is
 *  Home itself, since you are on it. */
function Recents(): React.JSX.Element {
  const recents = useAtomValue(recentsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  // A surface whose plugin is off is left out, as a deleted file would be.
  const entries = recents
    .filter((e) =>
      e.kind === 'surface'
        ? e.key !== 'home' && surfaces.has(e.key) && surfaces.get(e.key)!.unlisted !== true
        : e.kind === 'path',
    )
    .slice(0, SHOWN)

  const open = (entry: RecentEntry): void =>
    setWorkspace((w) =>
      entry.kind === 'path' ? openPinned(w, entry.key) : openSurface(w, entry.key, entry.id),
    )

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-8 text-sm">
      <Readme />
      <section className="w-full max-w-[22rem]">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Recently opened</h2>
        {entries.length === 0 ? (
          <p className="text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="-mx-2">
            {entries.map((entry) => {
              const { name, where } = labelOf(entry, surfaces)
              return (
                <li key={`${entry.kind}:${entry.key}:${entry.id ?? ''}`}>
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

const README = 'README.md'

/** The vault's `README.md`, read-only, when it has one: what the vault is for,
 *  above what you opened. Read again whenever the file changes on disk. */
function Readme(): React.JSX.Element | null {
  const remote = useAtomValue(activeRemoteAtom)
  const doc = useAtomValue(snapshotAtom).docs.find((d) => d.path === README)
  const setWorkspace = useSetAtom(workspaceAtom)
  const [text, setText] = useState<string | null>(null)
  const updatedAt = doc?.updatedAt

  useEffect(() => {
    if (remote === null || updatedAt === undefined) {
      setText(null)
      return
    }
    let current = true
    trpc.notes.read.query({ remote, path: README }).then(
      (read) => current && setText(read),
      () => current && setText(null),
    )
    return () => {
      current = false
    }
  }, [remote, updatedAt])

  if (doc === undefined || text === null || text.trim() === '') return null
  return (
    <section className="w-full max-w-[22rem]">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted-foreground">README</h2>
        <Button
          variant="ghost"
          size="xs"
          className="font-normal text-muted-foreground"
          onClick={() => setWorkspace((w) => openPinned(w, README))}
        >
          Open
        </Button>
      </div>
      <MarkdownText
        body={text}
        className="max-h-72 space-y-2 overflow-auto break-words text-muted-foreground"
      />
    </section>
  )
}

function NotThere({
  target,
}: {
  target: Exclude<HomeTarget, { kind: 'recents' }>
}): React.JSX.Element {
  const surfaces = useAtomValue(surfacesAtom)
  const openHome = useSetAtom(openHomeAtom)

  const name = (text: string) => <span className="text-foreground">{text}</span>
  let says: React.ReactNode
  let action: React.ReactNode = null
  switch (target.kind) {
    case 'file':
      says = <>Home is {name(target.path)}, which is not in this vault.</>
      break
    case 'daily':
      says = <>Home is today’s note, and this vault keeps no daily note.</>
      break
    case 'surface': {
      // Reaching the tab with a view means it is not there, or Home changed
      // while the tab was open.
      const view = surfaces.get(target.surface)
      if (view === undefined) {
        says = <>Home is {name(target.surface)}, which this vault does not have.</>
      } else if (view.homeable !== true) {
        says = <>Home is {name(surfaceLabel(view))}, which cannot be Home.</>
      } else {
        says = <>Home is {name(surfaceLabel(view))}.</>
        action = (
          <Button variant="secondary" size="sm" onClick={() => void openHome()}>
            Go there
          </Button>
        )
      }
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
      <p className="text-muted-foreground">{says}</p>
      {action}
    </div>
  )
}
