import { atom, useAtomValue } from 'jotai'
import { DEFAULT_HOLI_COLOUR } from '@holi/shared'
import { useCallback } from 'react'
import {
  AppWindowIcon,
  FileTextIcon,
  LayoutGridIcon,
  SettingsIcon,
  SquareKanbanIcon,
  WaypointsIcon,
  SquarePenIcon,
  ZapIcon,
} from 'lucide-react'

import { AgentMark, FolderDocumentMark } from '@/composites/marks'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import type { AgentsTabLook } from '@/plugin-api'
import { changedDocsAtom } from '@/state/doc-changes'
import { folderClaimsAtom, runningPluginsAtom, surfacesAtom } from '@/state/plugins'
import { parseTabKey } from '@/state/tab-descriptor'
import { basename } from '@/lib/tree-paths'

import type { HeaderTab } from './tab-strip'
import { useSidebarApps } from '@/features/sidebar/sidebar-apps'

type LookUp = (selection: { owner: string; id: string }) => AgentsTabLook | undefined

const NO_LOOKS = atom<LookUp>(() => () => undefined)

/** A file's name as its tab says it, as the files list shows it: without its
 *  folders or its extension. */
function fileTitle(path: string): string {
  return basename(path).replace(/(?<=.)\.[^./]+$/, '')
}

/** A session's mark: the Holi's face when one ran it, the automation's
 *  bolt, else its agent's (Claude's, OpenAI's for Codex), as the session
 *  list draws them. */
function SessionMark({ look }: { look: AgentsTabLook | undefined }) {
  const by = look?.by
  if (by?.kind === 'holi' && by.mascot !== undefined) {
    return (
      <PixelPersona
        name={by.mascot}
        color={by.color ?? DEFAULT_HOLI_COLOUR}
        status={look?.state === 'done' ? 'idle' : look?.state}
        still
        className="size-4 shrink-0"
      />
    )
  }
  if (by !== undefined) {
    return (
      <ZapIcon aria-hidden="true" className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
    )
  }
  return <AgentMark agent={look?.agent} className="size-4" />
}

/** How each tab looks in a strip: its title, its mark, and its state: a
 *  session's, or Updated for a document that changed while hidden. */
export function useTabLook(): (key: string) => HeaderTab {
  const apps = useSidebarApps()
  const surfaces = useAtomValue(surfacesAtom)
  const folderClaims = useAtomValue(folderClaimsAtom)
  const looksAtom =
    useAtomValue(runningPluginsAtom).find((plugin) => plugin.agentsMode)?.agentsMode?.tabLook ??
    NO_LOOKS
  const lookUp = useAtomValue(looksAtom)
  const changedDocs = useAtomValue(changedDocsAtom)
  return useCallback(
    (key: string): HeaderTab => {
      const tab = parseTabKey(key)
      switch (tab?.kind) {
        case 'doc':
          return {
            id: key,
            title: fileTitle(tab.path),
            icon: FileTextIcon,
            ...(changedDocs.has(tab.path) ? { status: 'updated' as const } : {}),
          }
        case 'vault-app':
          return {
            id: key,
            title: fileTitle(tab.path),
            mark: <FolderDocumentMark name={basename(tab.path)} />,
          }
        case 'board':
          return { id: key, title: 'Board', icon: SquareKanbanIcon }
        case 'graph':
          return { id: key, title: 'Graph', icon: WaypointsIcon }
        case 'apps':
          return { id: key, title: 'Apps', icon: LayoutGridIcon }
        case 'surface': {
          const surface = surfaces.get(tab.surface)
          const label = surface?.label
          // A folder document's tab (a deck, an app) holds its path as the
          // id, and shows the glyph its row in the tree does.
          const path =
            tab.id !== undefined && folderClaims.some((c) => c.folder.surface === tab.surface)
              ? tab.id
              : null
          return {
            id: key,
            title: typeof label === 'function' ? label(tab.id ?? '') : (label ?? tab.surface),
            icon: surface?.icon ?? AppWindowIcon,
            ...(path === null ? {} : { mark: <FolderDocumentMark name={basename(path)} /> }),
          }
        }
        case 'new':
          return { id: key, title: 'New tab' }
        case 'agents-home':
          return { id: key, title: 'New session', icon: SquarePenIcon }
        case 'settings':
          return { id: key, title: 'Settings', icon: SettingsIcon }
        case 'app': {
          const app = apps.find((candidate) => candidate.id === tab.id)
          return { id: key, title: app?.label ?? tab.id, icon: app?.icon }
        }
        case 'session': {
          const look = lookUp({ owner: tab.owner, id: tab.id })
          return {
            id: key,
            title: look?.title ?? 'Session',
            mark: <SessionMark look={look} />,
            ...(look === undefined || look.state === 'idle' ? {} : { status: look.state }),
          }
        }
        default:
          return { id: key, title: key }
      }
    },
    [apps, surfaces, folderClaims, lookUp, changedDocs],
  )
}
