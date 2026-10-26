import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useSetAtom } from "jotai"
import { GitBranchIcon, GitBranchPlusIcon } from "lucide-react"

import { Alert, AlertAction, AlertTitle } from "@/components/reui/alert"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { trpc } from "@/lib/trpc"
import { switchBranchAtom } from "@/state/vaults"

/**
 * The status bar's branch picker (docs/features/status-bar.md), VS Code's:
 * search, Create branch…, the local branches with the current one checked,
 * then the branches only on origin. Main does the git and refuses, in words,
 * whatever would lose work; this shows the refusal where it was asked.
 */

/** What `sync.branches` answers. */
interface BranchListView {
  current: string | null
  local: { name: string; upstream: string | null }[]
  remote: { name: string }[]
}

/** The refusal's words, from a tRPC error or anything else thrown. */
function messageOf(err: unknown): string {
  return err instanceof Error && err.message !== ""
    ? err.message
    : "Something went wrong"
}

/** How long a typed name rests before main is asked whether git takes it. */
const VALIDATE_MS = 150

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; list: BranchListView }

/**
 * The branch list while the picker is open: read at once from what the clone
 * knows, then fetched (debounced in main) and read again.
 */
function useBranches(open: boolean) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let live = true
    const read = () =>
      trpc.sync.branches.query().then((list) => {
        if (live) setLoad({ kind: "ready", list })
      })
    read()
      .catch((err: unknown) => {
        if (live) setLoad({ kind: "error", message: messageOf(err) })
      })
      .then(() => trpc.sync.fetchBranches.mutate())
      .then(() => read())
      .catch(() => {
        // A failed fetch leaves the list the clone already had.
      })
    return () => {
      live = false
    }
  }, [open, attempt])

  const retry = useCallback(() => {
    setLoad({ kind: "loading" })
    setAttempt((n) => n + 1)
  }, [])
  return { load, retry }
}

/** A typed branch name's problem, or null when git takes it. */
function useNameProblem(name: string, taken: readonly string[]) {
  const [problem, setProblem] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const typed = name.trim()

  useEffect(() => {
    if (typed === "") {
      setProblem(null)
      setChecking(false)
      return
    }
    if (taken.includes(typed)) {
      setProblem(`A branch named “${typed}” already exists`)
      setChecking(false)
      return
    }
    let live = true
    setChecking(true)
    const id = window.setTimeout(() => {
      trpc.sync.branchNameValid
        .query({ name: typed })
        .then((ok) => {
          if (live)
            setProblem(ok ? null : `“${typed}” is not a valid branch name`)
        })
        .catch((err: unknown) => {
          if (live) setProblem(messageOf(err))
        })
        .finally(() => {
          if (live) setChecking(false)
        })
    }, VALIDATE_MS)
    return () => {
      live = false
      window.clearTimeout(id)
    }
  }, [typed, taken])

  return { problem, checking, typed }
}

function CreateBranch({
  from,
  initial,
  taken,
  busy,
  onCancel,
  onCreate,
}: {
  from: string | null
  initial: string
  taken: readonly string[]
  busy: boolean
  onCancel: () => void
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  const { problem, checking, typed } = useNameProblem(name, taken)
  const ready = typed !== "" && problem === null && !checking && !busy
  return (
    <div className="flex flex-col gap-3 p-2">
      <Field data-invalid={problem !== null}>
        <FieldLabel htmlFor="new-branch-name">
          {from === null ? "New branch" : `New branch from ${from}`}
        </FieldLabel>
        <Input
          id="new-branch-name"
          autoFocus
          value={name}
          placeholder="feature/notes"
          aria-invalid={problem !== null}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) {
              e.preventDefault()
              onCreate(typed)
            } else if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
        />
        {problem === null ? null : <FieldError>{problem}</FieldError>}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => onCreate(typed)}
        >
          {busy ? <Spinner aria-hidden /> : null}
          Create branch
        </Button>
      </div>
    </div>
  )
}

function LoadingRows() {
  return (
    <div
      role="status"
      aria-label="Loading branches"
      className="flex flex-col gap-2 p-2"
    >
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

/**
 * The picker, opened by `trigger` (the bar's branch item). The bar reads its
 * branch again on its own: a switch writes a git line to the activity log.
 */
export function BranchPicker({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"list" | "create">("list")
  const [query, setQuery] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { load, retry } = useBranches(open)
  const switchBranch = useSetAtom(switchBranchAtom)
  const busy = pending !== null

  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setMode("list")
      setQuery("")
      setRefusal(null)
    }
  }, [])

  const run = useCallback(
    (name: string, create: boolean) => {
      setPending(name)
      setRefusal(null)
      switchBranch({ name, create })
        .then(() => onOpenChange(false))
        .catch((err: unknown) => setRefusal(messageOf(err)))
        .finally(() => setPending(null))
    },
    [switchBranch, onOpenChange]
  )

  const list = load.kind === "ready" ? load.list : null
  const taken = list === null ? [] : list.local.map((b) => b.name)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        variant="flush"
        className="w-72"
        aria-label="Switch branch"
      >
        {refusal === null ? null : (
          <div className="p-1 pb-0">
            <Alert variant="destructive">
              <AlertTitle className="line-clamp-none text-xs">
                {refusal}
              </AlertTitle>
            </Alert>
          </div>
        )}
        {mode === "create" ? (
          <CreateBranch
            from={list?.current ?? null}
            initial={query}
            taken={taken}
            busy={busy}
            onCancel={() => setMode("list")}
            onCreate={(name) => run(name, true)}
          />
        ) : (
          <Command>
            <CommandInput
              placeholder="Switch to a branch"
              value={query}
              onValueChange={setQuery}
              disabled={busy}
            />
            {load.kind === "error" ? (
              <div className="p-1">
                <Alert variant="destructive">
                  <AlertTitle className="text-xs">
                    Could not list the branches
                  </AlertTitle>
                  <AlertAction>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={retry}
                    >
                      Retry
                    </Button>
                  </AlertAction>
                </Alert>
              </div>
            ) : null}
            <CommandList>
              <CommandEmpty>No branch matches. Create it instead.</CommandEmpty>
              <CommandGroup forceMount>
                <CommandItem
                  value="Create branch…"
                  forceMount
                  disabled={busy || load.kind !== "ready"}
                  onSelect={() => setMode("create")}
                >
                  <GitBranchPlusIcon aria-hidden />
                  {query.trim() === ""
                    ? "Create branch…"
                    : `Create branch “${query.trim()}”…`}
                </CommandItem>
              </CommandGroup>
              {load.kind === "loading" ? <LoadingRows /> : null}
              {list === null ? null : (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Branches">
                    {list.local.map((b) => (
                      <CommandItem
                        key={`local:${b.name}`}
                        value={b.name}
                        data-checked={b.name === list.current}
                        disabled={busy}
                        onSelect={() => {
                          if (b.name === list.current) onOpenChange(false)
                          else run(b.name, false)
                        }}
                      >
                        {pending === b.name ? (
                          <Spinner aria-hidden />
                        ) : (
                          <GitBranchIcon aria-hidden />
                        )}
                        <span className="min-w-0 truncate">{b.name}</span>
                        {b.upstream === null ? (
                          <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                            not published
                          </span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {list.remote.length === 0 ? null : (
                    <CommandGroup heading="Remote branches">
                      {list.remote.map((b) => (
                        <CommandItem
                          key={`remote:${b.name}`}
                          value={`origin/${b.name}`}
                          disabled={busy}
                          onSelect={() => run(b.name, false)}
                        >
                          {pending === b.name ? (
                            <Spinner aria-hidden />
                          ) : (
                            <GitBranchIcon aria-hidden />
                          )}
                          <span className="min-w-0 truncate">
                            origin/{b.name}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
