/**
 * One vault app on the Apps page, on ReUI's c-card-7 (`components/examples/
 * c-card-7.tsx`, kept as installed): the inset image is the app's own icon on
 * a muted plate, since an app has no picture of itself; the Trending badge
 * says whether the app is shared through the vault or personal to this
 * machine; Featured is its folder; the blurb is its manifest's description;
 * Get Started opens it. The name, which the example has no place for, sits
 * above the description.
 */
import { useEffect, useState, type ComponentType } from "react"
import {
  ArrowRightIcon,
  FolderIcon,
  LockIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react"
import { isLocalOnlyPath } from "@holi/shared"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

type Description =
  | { kind: "loading" }
  | { kind: "ready"; text: string | null }
  | { kind: "error" }

/** The manifest's description, read again when `stamp` (the newest of the
 *  app's files) moves or Retry is pressed. */
function useDescription(
  describe: (() => Promise<string | null>) | undefined,
  stamp: string
): [Description, () => void] {
  const [state, setState] = useState<Description>(
    describe === undefined ? { kind: "ready", text: null } : { kind: "loading" }
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (describe === undefined) return
    let live = true
    describe().then(
      (text) => live && setState({ kind: "ready", text }),
      () => live && setState({ kind: "error" })
    )
    return () => {
      live = false
    }
    // `describe` is a fresh closure every render; the app and its files are
    // what decide when to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, attempt])
  return [
    state,
    () => {
      setState({ kind: "loading" })
      setAttempt((n) => n + 1)
    },
  ]
}

export function AppCard({
  path,
  name,
  icon: Icon,
  stamp,
  describe,
  onOpen,
}: {
  path: string
  name: string
  icon: ComponentType<{ className?: string }>
  /** The newest mtime among the app's files. */
  stamp: string
  describe?: () => Promise<string | null>
  onOpen: () => void
}) {
  const [description, retry] = useDescription(describe, stamp)
  const slash = path.lastIndexOf("/")
  const folder = slash === -1 ? null : path.slice(0, slash)
  const personal = isLocalOnlyPath(path)

  return (
    <Card className="w-full">
      <CardContent className="flex flex-col gap-4">
        <div className="bg-muted relative flex h-48 w-full items-center justify-center overflow-hidden rounded-lg">
          <Icon className="text-muted-foreground size-12" />
        </div>

        <div className="flex items-center justify-between gap-5">
          <Badge variant="outline">
            {personal ? (
              <LockIcon aria-hidden="true" />
            ) : (
              <UsersIcon aria-hidden="true" />
            )}
            {personal ? "Personal" : "Shared"}
          </Badge>
          <div className="flex min-w-0 items-center gap-1">
            <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-secondary-foreground truncate text-xs font-medium">
              {folder ?? "Vault root"}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <CardTitle className="truncate">{name}</CardTitle>
          {description.kind === "loading" ? (
            <div
              className="flex flex-col gap-1.5 py-0.5"
              aria-label="Loading the description"
            >
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : description.kind === "error" ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-sm">
                Couldn't read its description.
              </p>
              <Button variant="outline" size="sm" onClick={retry}>
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : description.text === null ? (
            <p className="text-muted-foreground text-sm">No description yet.</p>
          ) : (
            <p className="text-foreground line-clamp-3 text-sm">
              {description.text}
            </p>
          )}
        </div>

        <Button onClick={onOpen} aria-label={`Open ${name}`}>
          Open
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  )
}

/** A card while the vault's files are still loading, in the card's shape. */
export function AppCardSkeleton() {
  return (
    <Card className="w-full" aria-hidden="true">
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-48 w-full" />
        <div className="flex items-center justify-between gap-5">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-full" />
        </div>
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  )
}
