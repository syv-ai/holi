/**
 * The field that finds a plugin to install: type part of a name or an
 * `owner/repo`, and a list drops below it with the matching repositories,
 * each read as a plugin or not (`community.search`). A plugin shows its name
 * and newest release and installs on choosing it; anything else says why it
 * cannot, so a typo or a missing manifest is visible as you type.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/plugin-api'
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/primitives'
import type { Candidate } from '../main/search'
import { communityCap } from './state'

/** Long enough that typing `syv-ai/prezzi` is one search, not thirteen. */
const DEBOUNCE_MS = 300

type Results =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'done'; candidates: readonly Candidate[] }
  | { kind: 'failed'; message: string }

export function PluginSearch({
  remote,
  disabled,
  onChoose,
}: {
  remote: string
  disabled: boolean
  /** A plugin with a release was chosen. */
  onChoose(candidate: Candidate & { latest: string }): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const typed = query.trim()
    if (typed === '') {
      setResults({ kind: 'idle' })
      return
    }
    let live = true
    setResults({ kind: 'searching' })
    const timer = setTimeout(() => {
      communityCap.search(remote, { query: typed }).then(
        (candidates) => live && setResults({ kind: 'done', candidates }),
        (err: unknown) =>
          live &&
          setResults({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
      )
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [remote, query])

  const choose = (c: Candidate) => {
    if (c.latest === null || c.problem !== null) return
    setOpen(false)
    setQuery('')
    onChoose({ ...c, latest: c.latest })
  }

  return (
    // cmdk ranks nothing here: the order is main's, plugins first.
    <Command shouldFilter={false} className="h-auto overflow-visible bg-transparent">
      <Popover open={open && query.trim() !== ''} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div ref={anchor} className="rounded-md bg-muted">
            <CommandInput
              value={query}
              onValueChange={(v) => {
                setQuery(v)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              disabled={disabled}
              placeholder="Search GitHub, or type owner/repo"
              aria-label="Find a plugin on GitHub"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-1"
          // The input keeps the keyboard: arrows move through the list and
          // Enter chooses, as in the palette.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (anchor.current?.contains(e.target as Node)) e.preventDefault()
          }}
        >
          <CommandList className="max-h-72 overflow-y-auto">
            {results.kind === 'searching' && <Note>Searching…</Note>}
            {results.kind === 'failed' && <Note>{results.message}</Note>}
            {results.kind === 'done' && results.candidates.length === 0 && (
              <Note>No repositories match.</Note>
            )}
            {results.kind === 'done' &&
              results.candidates.map((c) => {
                const installable = c.latest !== null && c.problem === null
                return (
                  <CommandItem
                    key={c.repo}
                    value={c.repo}
                    disabled={!installable}
                    onSelect={() => choose(c)}
                    className="flex-col items-start gap-0.5 rounded-md text-xs data-[disabled=true]:opacity-100"
                  >
                    <span className="flex w-full items-baseline justify-between gap-2">
                      <span className={cn('truncate', !installable && 'text-muted-foreground')}>
                        {c.plugin?.name ?? c.repo}
                        {c.plugin !== null && (
                          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                            {c.repo}
                          </span>
                        )}
                      </span>
                      {installable && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {c.latest}
                        </span>
                      )}
                    </span>
                    <span className="w-full truncate text-[11px] text-muted-foreground">
                      {c.problem ?? (c.plugin?.description || c.description)}
                    </span>
                  </CommandItem>
                )
              })}
          </CommandList>
        </PopoverContent>
      </Popover>
    </Command>
  )
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-2.5 py-2 text-[11px] text-muted-foreground">{children}</p>
}
