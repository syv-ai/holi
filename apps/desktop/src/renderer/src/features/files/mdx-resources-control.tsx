import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/composites/empty-state'
import type { useMdxResources } from './use-mdx-resources'

type Props = {
  resources: NonNullable<ReturnType<typeof useMdxResources>['model']>
  onRun: () => void
}

export function MdxResourcesControl({ resources, onRun }: Props) {
  const {
    approved,
    pending,
    loading,
    queryError,
    decisionErrors,
    diagnosticsError,
    updatingOrigins,
    visit,
    decide,
  } = resources
  const [opened, setOpened] = useState<object | null>(null)
  const empty = pending.length === 0 && approved.length === 0
  const updating = updatingOrigins.length > 0
  const showEmptyState =
    empty && !loading && !queryError && !decisionErrors.length && !diagnosticsError && !updating

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
          {loading && !queryError && !decisionErrors.length && !diagnosticsError && empty ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Checking MDX resources">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-8 w-1/3" />
            </div>
          ) : null}
          {queryError ? (
            <div className="flex flex-wrap items-center gap-2">
              <Alert variant="destructive">
                <AlertDescription className="break-words">{queryError.message}</AlertDescription>
              </Alert>
              <Button
                type="button"
                variant="outline"
                disabled={queryError.retrying}
                onClick={queryError.retry}
              >
                Retry resource list
              </Button>
            </div>
          ) : null}
          {decisionErrors.map(({ origin, message, retry }) => (
            <div key={origin} className="flex flex-wrap items-center gap-2">
              <Alert variant="destructive">
                <AlertDescription className="break-words">{message}</AlertDescription>
              </Alert>
              <Button
                type="button"
                variant="outline"
                aria-label={`Retry decision for ${origin}`}
                disabled={updatingOrigins.includes(origin)}
                onClick={retry}
              >
                Retry
              </Button>
            </div>
          ))}
          {diagnosticsError ? (
            <div className="flex flex-wrap items-center gap-2">
              <Alert variant="destructive">
                <AlertDescription className="break-words">{diagnosticsError}</AlertDescription>
              </Alert>
              <Button type="button" variant="outline" disabled={updating} onClick={onRun}>
                Retry diagnostics
              </Button>
            </div>
          ) : null}
          {showEmptyState ? (
            <EmptyState
              title="No MDX resource requests or approvals"
              action={{ label: 'Run diagnostics', onClick: onRun }}
            />
          ) : null}
          {updatingOrigins.map((origin) => (
            <p key={origin} role="status">
              Updating MDX resources: {origin}
            </p>
          ))}
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
                        disabled={updatingOrigins.includes(origin)}
                        onClick={() => void decide('deny', id)}
                      >
                        Deny
                      </Button>
                      <Button
                        type="button"
                        aria-label={`Allow ${origin}`}
                        disabled={updatingOrigins.includes(origin)}
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
              <h2 className="font-medium">{queryError ? 'Known approvals' : 'Approved origins'}</h2>
              <p className="text-muted-foreground">
                Manage which origins may supply module data for MDX dependency diagnostics in this
                vault.
              </p>
              <ul className="flex flex-col gap-3">
                {approved.map((grant) => {
                  const { id, origin } = grant
                  const blocked = 'revocationPending' in grant && grant.revocationPending === true
                  const label = blocked ? 'Retry revocation' : 'Revoke'
                  return (
                    <li
                      key={id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="font-mono break-all">{origin}</span>
                        {blocked ? (
                          <p role="status" className="text-muted-foreground">
                            Access blocked; revocation not saved
                          </p>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`${label} ${origin}`}
                        disabled={updatingOrigins.includes(origin)}
                        onClick={() => void decide('revoke', id)}
                      >
                        {label}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
          {!showEmptyState && !loading && !diagnosticsError && !updating ? (
            <div>
              <Button type="button" variant="outline" onClick={onRun}>
                Run diagnostics
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
