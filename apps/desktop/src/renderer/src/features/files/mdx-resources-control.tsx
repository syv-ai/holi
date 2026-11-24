import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/composites/empty-state'
import type { useMdxDiagnostics } from './use-mdx-diagnostics'

type Props = {
  resources: NonNullable<ReturnType<typeof useMdxDiagnostics>['resources']>
  onRun: () => void
}

export function MdxResourcesControl({ resources, onRun }: Props) {
  const { load, pendingDecision, visit, decide } = resources
  const [opened, setOpened] = useState<object | null>(null)
  const { pending, approved } = load.kind === 'ready' ? load : { pending: [], approved: [] }

  return (
    <Popover open={opened === visit} onOpenChange={(open) => setOpened(open ? visit : null)}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          MDX resources
        </Button>
      </PopoverTrigger>
      {pending.length > 0 ? <Badge variant="secondary">Approval needed</Badge> : null}
      <PopoverContent align="start" size="calendar" aria-label="MDX resources">
        <div className="flex min-h-0 flex-col gap-4 overflow-auto">
          {load.kind === 'loading' ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Checking MDX resources">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-8 w-1/3" />
            </div>
          ) : load.kind === 'error' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Alert variant="destructive">
                <AlertDescription className="break-words">{load.message}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" onClick={onRun}>
                Retry
              </Button>
            </div>
          ) : pending.length === 0 && approved.length === 0 && !pendingDecision ? (
            <EmptyState
              title="No MDX resource requests or approvals"
              action={{ label: 'Run diagnostics', onClick: onRun }}
            />
          ) : (
            <>
              {pendingDecision ? <p role="status">Updating MDX resources…</p> : null}
              {pending.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="font-medium">Pending approvals</h2>
                  <p className="text-muted-foreground">
                    Allowing an exact HTTPS origin lets it supply dependency module data for MDX
                    diagnostics in this vault for your signed-in account until revoked. It does not
                    allow guest networking or code evaluation.
                  </p>
                  <ul className="flex flex-col gap-3">
                    {pending.map(({ id, origin }) => (
                      <li
                        key={id}
                        className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                      >
                        <span className="min-w-0 font-mono break-all">{origin}</span>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={`Deny ${origin}`}
                            disabled={pendingDecision}
                            onClick={() => void decide('deny', id)}
                          >
                            Deny
                          </Button>
                          <Button
                            type="button"
                            aria-label={`Allow ${origin}`}
                            disabled={pendingDecision}
                            onClick={() => void decide('allow', id)}
                          >
                            Allow
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {approved.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h2 className="font-medium">Approved origins</h2>
                  <p className="text-muted-foreground">
                    Allowed to supply module data for MDX dependency diagnostics in this vault.
                  </p>
                  <ul className="flex flex-col gap-3">
                    {approved.map(({ id, origin }) => (
                      <li
                        key={id}
                        className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                      >
                        <span className="min-w-0 font-mono break-all">{origin}</span>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Revoke ${origin}`}
                          disabled={pendingDecision}
                          onClick={() => void decide('revoke', id)}
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {!pendingDecision ? (
                <div>
                  <Button type="button" variant="outline" onClick={onRun}>
                    Run diagnostics
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
