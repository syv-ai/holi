// ⌘K (ReUI app-shell-21's search palette, wired to Holi): the places the
// sidebar holds and this machine's vaults, filtered by what you type. Enter
// opens the top match.
import { useMemo, useState, type ReactNode } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import {
  BotIcon,
  FileTextIcon,
  FolderGit2Icon,
  PlusIcon,
  SearchIcon,
} from "lucide-react"
import { cn } from "@/lib/cn"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { appModeAtom } from "@/state/app-mode"
import { runningPluginsAtom } from "@/state/plugins"
import { switchVaultAtom } from "@/state/vault-switch"
import { activeRemoteAtom, vaultsAtom } from "@/state/vaults"

type Result = {
  id: string
  group: "Places" | "Vaults"
  label: string
  detail?: string
  icon: ReactNode
  run: () => void
}

function ResultRow({
  result,
  onSelect,
}: {
  result: Result
  onSelect: (result: Result) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(result)}
        className="hover:bg-accent focus-visible:bg-accent group/row flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-start transition-colors outline-none [&_svg]:text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0"
      >
        {result.icon}
        <span className="min-w-0 flex-1 truncate text-sm">{result.label}</span>
        {result.detail ? (
          <span className="text-muted-foreground shrink-0 text-xs group-hover/row:hidden">
            {result.detail}
          </span>
        ) : null}
        <Kbd className="hidden group-hover/row:inline-flex">Enter</Kbd>
      </button>
    </li>
  )
}

export function ChatSearchDialog({
  open,
  onOpenChange,
  onAddVault,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddVault: () => void
}) {
  const [query, setQuery] = useState("")
  const vaults = useAtomValue(vaultsAtom)
  const active = useAtomValue(activeRemoteAtom)
  const setMode = useSetAtom(appModeAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  const hasAgents = useAtomValue(runningPluginsAtom).some(
    (plugin) => plugin.agentsMode !== undefined
  )

  const results = useMemo<Result[]>(() => {
    const all: Result[] = [
      {
        id: "documents",
        group: "Places",
        label: "Documents",
        icon: <FileTextIcon aria-hidden="true" />,
        run: () => setMode("documents"),
      },
      ...(hasAgents
        ? [
            {
              id: "agents",
              group: "Places" as const,
              label: "Agents",
              icon: <BotIcon aria-hidden="true" />,
              run: () => setMode("agents"),
            },
          ]
        : []),
      ...vaults
        .filter((vault) => vault.remote !== active)
        .map((vault) => ({
          id: vault.remote,
          group: "Vaults" as const,
          label: vault.name,
          detail: vault.remote,
          icon: <FolderGit2Icon aria-hidden="true" />,
          run: () => switchVault(vault.remote),
        })),
      {
        id: "add-vault",
        group: "Vaults",
        label: "Add Vault",
        icon: <PlusIcon aria-hidden="true" />,
        run: onAddVault,
      },
    ]
    const term = query.trim().toLowerCase()
    return term
      ? all.filter((result) =>
          `${result.label} ${result.detail ?? ""}`.toLowerCase().includes(term)
        )
      : all
  }, [query, vaults, active, hasAgents, setMode, switchVault, onAddVault])

  const places = results.filter((result) => result.group === "Places")
  const vaultResults = results.filter((result) => result.group === "Vaults")

  function choose(result: Result) {
    setQuery("")
    onOpenChange(false)
    result.run()
  }

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("")
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* No close button: it would sit inside the search field, and Escape or
          the overlay already dismiss the palette. */}
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-xl translate-y-0 gap-0 p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Go to a place or another vault.</DialogDescription>
        </DialogHeader>

        <div className="p-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon className="text-muted-foreground" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter opens the top result, the palette convention.
                if (event.key !== "Enter" || !results[0]) return
                event.preventDefault()
                choose(results[0])
              }}
              placeholder="Search places and vaults"
              aria-label="Search places and vaults"
            />
          </InputGroup>
        </div>

        {/* Results scroll so the dialog height never chases the list, and the
            scrollbar only appears while the pointer is in the panel. */}
        <ScrollArea
          className={cn(
            "max-h-96 min-h-0 p-2",
            // Radix wraps viewport children in a display:table div, which
            // breaks the rows' truncate. Targets that wrapper only.
            "[&>[data-slot=scroll-area-viewport]>div]:block!",
            "[&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-150 hover:[&_[data-slot=scroll-area-scrollbar]]:opacity-100"
          )}
        >
          <p aria-live="polite" className="sr-only">
            {results.length} results
          </p>

          {results.length === 0 ? (
            <Empty className="border-0 bg-transparent py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No Matches</EmptyTitle>
                <EmptyDescription>
                  Try a vault's name or its owner.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}

          {places.length > 0 ? (
            <>
              <p className="text-muted-foreground px-2 py-1.5 text-xs">Places</p>
              <ul className="flex flex-col">
                {places.map((result) => (
                  <ResultRow key={result.id} result={result} onSelect={choose} />
                ))}
              </ul>
            </>
          ) : null}

          {vaultResults.length > 0 ? (
            <>
              <p className="text-muted-foreground px-2 py-1.5 text-xs">Vaults</p>
              <ul className="flex flex-col">
                {vaultResults.map((result) => (
                  <ResultRow key={result.id} result={result} onSelect={choose} />
                ))}
              </ul>
            </>
          ) : null}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
