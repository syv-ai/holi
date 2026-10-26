/** Members: who can see the vault. */
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import { type Collaborator } from '@holi/shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom } from '@/state/vaults'
import { ExternalLinkIcon } from 'lucide-react'
import { SettingsGroup, SettingsFieldRow, SettingsRowsLoading } from '../settings-kit'
import { EmptyState } from '@/composites/empty-state'

type MembersState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; visibility: string; collaborators: Collaborator[] }

export function MembersPage() {
  const remote = useAtomValue(activeRemoteAtom)
  const [state, setState] = useState<MembersState>({ kind: 'loading' })

  const read = useCallback(() => {
    if (remote === null) return () => {}
    let live = true
    setState({ kind: 'loading' })
    trpc.github.collaborators
      .query({ remote })
      .then(
        ({ visibility, collaborators }) =>
          live && setState({ kind: 'ready', visibility, collaborators }),
      )
      // Ordinary (offline, not on GitHub, a token without the scope): say so
      // rather than show an empty list, which would read as "nobody else".
      .catch(
        (error: unknown) =>
          live &&
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          }),
      )
    return () => {
      live = false
    }
  }, [remote])

  useEffect(() => read(), [read])

  const manage =
    remote === null ? null : (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void trpc.github.openCollaboratorSettings.mutate({ remote })}
      >
        Manage on GitHub
        <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
      </Button>
    )

  return (
    <SettingsGroup
      title="Members"
      description="Who can open this vault. GitHub decides; Holi shows what it says."
      action={manage}
    >
      {state.kind === 'loading' ? (
        <SettingsRowsLoading rows={2} label="Reading the members" />
      ) : state.kind === 'error' ? (
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">GitHub did not list who has access.</span>
            <span className="text-muted-foreground text-xs break-words">{state.message}</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => read()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <SettingsFieldRow
            title="Visibility"
            description="A public vault can be read by anyone on GitHub."
          >
            <Badge variant={state.visibility === 'public' ? 'warning-light' : 'secondary'}>
              {state.visibility}
            </Badge>
          </SettingsFieldRow>
          {state.collaborators.length === 0 ? (
            <EmptyState
              title="Only you, so far"
              description="Invite people on GitHub and they can clone this vault in Holi."
              className="h-auto"
            >
              {manage}
            </EmptyState>
          ) : (
            state.collaborators.map((person) => (
              <SettingsFieldRow
                key={person.accountId}
                title={
                  <span className="flex items-center gap-2">
                    <Avatar size="sm">
                      <AvatarImage src={person.avatarUrl} alt="" />
                      <AvatarFallback className="text-xs">
                        {person.login.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {person.login}
                  </span>
                }
              >
                <Badge variant="outline">{person.permission}</Badge>
              </SettingsFieldRow>
            ))
          )}
        </>
      )}
    </SettingsGroup>
  )
}
