import { SiClaude } from "@icons-pack/react-simple-icons"
import { atom, useAtomValue } from "jotai"
import { useCallback } from "react"
import {
  AppWindowIcon,
  FileTextIcon,
  SettingsIcon,
  SquareKanbanIcon,
  SquarePenIcon,
  ZapIcon,
} from "lucide-react"

import { PixelPersona } from "@/composites"
import type { AgentsTabLook } from "@/plugin-api"
import { runningPluginsAtom } from "@/state/plugins"
import { parseTabKey } from "@/state/tab-descriptor"

import type { HeaderTab } from "./site-header"
import { useSidebarApps } from "./sidebar-apps"

type LookUp = (selection: {
  owner: string
  id: string
}) => AgentsTabLook | undefined

const NO_LOOKS = atom<LookUp>(() => () => undefined)

/** A file's name as its tab says it: without its folders, `.md` or `.app`. */
function fileTitle(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|app)$/, "")
}

/** A session's mark: the Holi's face when one ran it, the automation's
 *  bolt, else Claude's, as the session list draws them. */
function SessionMark({ look }: { look: AgentsTabLook | undefined }) {
  const by = look?.by
  if (by?.kind === "holi" && by.mascot !== undefined) {
    return (
      <PixelPersona
        name={by.mascot}
        color={by.color ?? "#8f8f94"}
        status={look?.state === "done" ? "idle" : look?.state}
        still
        className="size-4 shrink-0"
      />
    )
  }
  if (by !== undefined) {
    return (
      <ZapIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
    )
  }
  return (
    <SiClaude
      aria-hidden="true"
      className="size-4 shrink-0 text-orange-500 dark:text-orange-400"
    />
  )
}

/** How each tab looks in a strip: its title, its mark, and for a session
 *  the state its dot shows. */
export function useTabLook(): (key: string) => HeaderTab {
  const apps = useSidebarApps()
  const looksAtom =
    useAtomValue(runningPluginsAtom).find((plugin) => plugin.agentsMode)
      ?.agentsMode?.tabLook ?? NO_LOOKS
  const lookUp = useAtomValue(looksAtom)
  return useCallback(
    (key: string): HeaderTab => {
      const tab = parseTabKey(key)
      switch (tab?.kind) {
        case "doc":
          return { id: key, title: fileTitle(tab.path), icon: FileTextIcon }
        case "vault-app":
          return { id: key, title: fileTitle(tab.path), icon: AppWindowIcon }
        case "board":
          return { id: key, title: "Board", icon: SquareKanbanIcon }
        case "new":
          return { id: key, title: "New tab" }
        case "agents-home":
          return { id: key, title: "New session", icon: SquarePenIcon }
        case "settings":
          return { id: key, title: "Settings", icon: SettingsIcon }
        case "app": {
          const app = apps.find((candidate) => candidate.id === tab.id)
          return { id: key, title: app?.label ?? tab.id, icon: app?.icon }
        }
        case "session": {
          const look = lookUp({ owner: tab.owner, id: tab.id })
          return {
            id: key,
            title: look?.title ?? "Session",
            mark: <SessionMark look={look} />,
            ...(look === undefined || look.state === "idle"
              ? {}
              : { status: look.state }),
          }
        }
        default:
          return { id: key, title: key }
      }
    },
    [apps, lookUp]
  )
}
