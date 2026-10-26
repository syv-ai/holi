/**
 * The field that finds a plugin to install: type part of a name or an
 * `owner/repo`, and a list drops below it with the matching repositories,
 * each read as a plugin or not (`community.search`). A plugin shows its name
 * and newest release and installs on choosing it; anything else says why it
 * cannot, so a typo or a missing manifest is visible as you type.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/plugin-api'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
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
          className="w-(--radix-popover-trigger-width)"
          // The input keeps the keyboard: arrows move through the list and
          // Enter chooses, as in the palette.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (anchor.current?.contains(e.target as Node)) e.preventDefault()
          }}
        >
          <CommandList className="max-h-72 overflow-y-auto">
            {results.kind === 'searching' && <Note role="status">Searching…</Note>}
            {results.kind === 'failed' && (
              <Note role="alert" className="text-destructive">
                {results.message}
              </Note>
            )}
            {results.kind === 'done' && results.candidates.length === 0 && (
              <Note>No repositories match.</Note>
            )}
            {results.kind === 'done' &&
              results.candidates.map((c) => {
                const installable = c.latest !== null && c.problem === null
                return (
                  <CommandItem
                    key={`${c.repo}/${c.path}`}
                    value={`${c.repo}/${c.path}`}
                    disabled={!installable}
                    onSelect={() => choose(c)}
                    className="flex-col items-start text-xs"
                  >
                    <span className="flex w-full items-baseline justify-between gap-2">
                      {/* Wraps rather than truncates: the path is how two
                          plugins of one name are told apart. */}
                      <span
                        className={cn(
                          'min-w-0 break-words',
                          !installable && 'text-muted-foreground',
                        )}
                      >
                        {c.plugin?.name ?? c.repo}
                        {c.plugin !== null && (
                          <span className="ml-1.5 font-mono text-xs break-all text-muted-foreground">
                            {c.path === '' ? c.repo : `${c.repo}/${c.path}`}
                          </span>
                        )}
                      </span>
                      {installable && (
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {c.latest}
                        </span>
                      )}
                    </span>
                    {/* Wrapped, never truncated: a problem is the reason this
                        repository cannot be installed. */}
                    <span className="w-full text-xs text-pretty break-words text-muted-foreground">
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

function Note({
  children,
  role,
  className,
}: {
  children: React.ReactNode
  role?: 'status' | 'alert'
  className?: string
}): React.JSX.Element {
  return (
    <p
      role={role}
      className={cn('px-2.5 py-2 text-xs text-pretty break-words text-muted-foreground', className)}
    >
      {children}
    </p>
  )
}
