/**
 * Apps: every vault app, most recently opened first, from the sidebar's row
 * under Search, each on a card (`app-card.tsx`). Read off the registry's `app`
 * surface (its `instances`, label, icon and `describe`), so core never reaches
 * into the apps plugin, and the page says so when that plugin is off.
 */
import { useMemo, useState } from "react"
import { atom, useAtomValue, useSetAtom } from "jotai"
import { AppWindowIcon, PlusIcon, SettingsIcon } from "lucide-react"
import { toast } from "sonner"

import { IconStackEmpty } from "@/components/reui/icon-stack-empty"
import { ViewHeader, ViewHeaderTitle } from "@/composites/ViewHeader"
import { claimsAtom, surfacesAtom } from "@/state/plugins"
import { openTabAtom } from "@/state/shell-tabs"
import {
  activeRemoteAtom,
  snapshotAtom,
  snapshotLoadedAtom,
} from "@/state/vaults"
import { AppCard, AppCardSkeleton } from "./app-card"

const NO_APPS = atom<readonly string[]>([])

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
  const loaded = useAtomValue(snapshotLoadedAtom)
  /** Each app's newest file mtime, so its card reads its description again
   *  when the app changes. */
  const stamps = useMemo(() => {
    const out = new Map<string, string>()
    for (const app of apps) {
      let newest = ""
      for (const file of snapshot.files) {
        if (file.path.startsWith(`${app}/`) && file.updatedAt > newest)
          newest = file.updatedAt
      }
      out.set(app, newest)
    }
    return out
  }, [apps, snapshot.files])
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
        ) : !loaded && remote !== null ? (
          <ul
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-label="Loading apps"
          >
            {[0, 1, 2].map((n) => (
              <li key={n}>
                <AppCardSkeleton />
              </li>
            ))}
          </ul>
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
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {apps.map((path) => {
              const name =
                typeof surface.label === "function"
                  ? surface.label(path)
                  : surface.label
              const describe = surface.describe
              return (
                <li key={path}>
                  <AppCard
                    path={path}
                    name={name}
                    icon={surface.icon}
                    stamp={stamps.get(path) ?? ""}
                    describe={
                      describe === undefined || remote === null
                        ? undefined
                        : () => describe(remote, path)
                    }
                    onOpen={() => onOpen(path)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
