/**
 * Apps: every vault app, most recently opened first, from the sidebar's row
 * under Search. Read off the registry's `app` surface (its `instances`, label
 * and icon), so core never reaches into the apps plugin, and the page says
 * so when that plugin is off.
 */
import { useState } from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { AppWindowIcon, FolderIcon, PlusIcon, SettingsIcon } from "lucide-react"
import { toast } from "sonner"

import { IconStackEmpty } from "@/components/reui/icon-stack-empty"
import { ViewHeader, ViewHeaderTitle } from "@/composites/ViewHeader"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { claimsAtom, surfacesAtom } from "@/state/plugins"
import { openTabAtom } from "@/state/shell-tabs"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"

const NO_APPS = atom<readonly string[]>([])

function folderOf(path: string): string | null {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? null : path.slice(0, slash)
}

/** The first `Untitled`, `Untitled 2`, … that no vault path takes, as an
 *  app's name at the vault root. */
function freeAppName(taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? "Untitled" : `Untitled ${n}`
    if (!taken.has(`${name}.app`)) return name
  }
}

export function AppsView({ onOpen }: { onOpen: (path: string) => void }) {
  const surface = useAtomValue(surfacesAtom).get("app")
  const apps = useAtomValue(surface?.instances ?? NO_APPS)
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const openTab = useSetAtom(openTabAtom)
  /** The apps plugin's New app, as the Files menu offers it. */
  const create = useAtomValue(claimsAtom).find(
    (claim) => claim.create?.id === "app"
  )
  const [creating, setCreating] = useState(false)

  async function newApp() {
    if (remote === null || create?.create === undefined) return
    const taken = new Set([
      ...snapshot.dirs,
      ...snapshot.files.map((file) => file.path),
    ])
    setCreating(true)
    try {
      const entry = await create.create.run({
        remote,
        parent: "",
        name: freeAppName(taken),
      })
      if (entry === null) {
        toast.error("Couldn't create the app. Try again.")
        return
      }
      const suffix = `/${create.folder?.entry ?? "index.html"}`
      onOpen(entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : entry)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader>
        <ViewHeaderTitle
          title="Apps"
          badge={
            apps.length > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {apps.length}
              </span>
            ) : undefined
          }
        />
      </ViewHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 lg:px-6">
        {surface === undefined ? (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="Vault apps are off"
            description="Turn on the Vault apps plugin in Settings to open the apps in this vault."
            action={{
              label: "Open Settings",
              icon: SettingsIcon,
              onClick: () => openTab({ kind: "settings" }),
            }}
          />
        ) : apps.length === 0 ? (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="No apps yet"
            description="An app is a small web page in the vault, like a dashboard or a CSV explorer. Start one here, or ask the agent to build it."
            action={
              create?.create === undefined
                ? undefined
                : {
                    label: creating ? "Creating…" : "New app",
                    icon: PlusIcon,
                    disabled: creating || remote === null,
                    onClick: () => void newApp(),
                  }
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {apps.map((path) => {
              const name =
                typeof surface.label === "function"
                  ? surface.label(path)
                  : surface.label
              const folder = folderOf(path)
              const Icon = surface.icon
              return (
                <li key={path}>
                  <Item asChild variant="outline">
                    <button
                      type="button"
                      onClick={() => onOpen(path)}
                      className="hover:bg-muted/50 w-full text-start transition-colors"
                    >
                      <ItemMedia variant="icon">
                        <Icon className="size-4" />
                      </ItemMedia>
                      <ItemContent className="min-w-0">
                        <ItemTitle className="truncate">{name}</ItemTitle>
                        <ItemDescription className="flex min-w-0 items-center gap-1.5">
                          <FolderIcon
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {folder ?? "Vault root"}
                          </span>
                        </ItemDescription>
                      </ItemContent>
                    </button>
                  </Item>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
