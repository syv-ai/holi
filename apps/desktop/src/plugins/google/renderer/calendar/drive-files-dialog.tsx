import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/composites/empty-state'
import type {
  DriveFile,
  DriveFilePage,
  EventAttachmentTarget,
} from '../../shared/event-attachments'
import { googleCap } from '../google-cap'
import { attachmentConsentNeeded, messageOf } from '../google-errors'

export type DriveFileChoice = Pick<DriveFile, 'id' | 'name'>
type PageRequest = { query: string; pageToken?: string }
const NO_FILES: DriveFileChoice[] = []

export function DriveFilesDialog({
  remote,
  target,
  eventTitle,
  attachedIds,
  unconfirmedIds,
  slots,
  initialFiles = NO_FILES,
  busy,
  canSubmit,
  onConfirm,
  onClose,
  onRestoreFocus,
  onOpenConnections,
}: {
  remote: string
  target: EventAttachmentTarget
  eventTitle: string
  attachedIds: ReadonlySet<string>
  unconfirmedIds: ReadonlySet<string>
  slots: number
  initialFiles?: DriveFileChoice[]
  busy: boolean
  canSubmit: boolean
  onConfirm: (files: DriveFileChoice[]) => void
  onClose: () => void
  onRestoreFocus: () => void
  onOpenConnections: () => void
}) {
  const { expectedAccountSub, calendarId, eventId } = target
  const [query, setQuery] = useState('')
  const [request, setRequest] = useState<PageRequest>({ query: '' })
  const latestRequest = useRef(request)
  const [page, setPage] = useState<DriveFilePage>({ files: [] })
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [selection, setSelection] = useState(initialFiles)
  const [confirming, setConfirming] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const remaining = Math.max(0, slots - selection.length)
  const canConfirm =
    canSubmit &&
    !loading &&
    !failure &&
    selection.length > 0 &&
    selection.length <= slots &&
    selection.every(({ id }) => !attachedIds.has(id) && !unconfirmedIds.has(id))
  // Keep selected files reachable even if they are on a different search page.
  const candidates = [
    ...new Map(
      [...selection, ...initialFiles, ...page.files].map((file) => [file.id, file]),
    ).values(),
  ]

  useEffect(() => {
    let current = true
    const { query, pageToken } = request
    void googleCap
      .driveFiles(remote, {
        expectedAccountSub,
        calendarId,
        eventId,
        query: query || undefined,
        pageToken,
      })
      .then(
        (next) => {
          if (!current || latestRequest.current !== request) return
          setPage((previous) => ({
            ...next,
            files: [
              ...new Map(
                [...(pageToken ? previous.files : []), ...next.files].map((file) => [
                  file.id,
                  file,
                ]),
              ).values(),
            ],
          }))
          setLoading(false)
        },
        (cause: unknown) => {
          if (!current || latestRequest.current !== request) return
          setFailure({ cause })
          setLoading(false)
        },
      )
    return () => {
      current = false
    }
  }, [remote, expectedAccountSub, calendarId, eventId, request])

  useEffect(() => {
    if (confirming) title.current?.focus()
    else searchInput.current?.focus()
  }, [confirming, busy])

  const load = (next: PageRequest) => {
    latestRequest.current = next
    setLoading(true)
    setFailure(null)
    setRequest(next)
  }
  const search = (query: string) => {
    setPage({ files: [] })
    load({ query: query.trim() })
    searchInput.current?.focus()
  }
  const loadMore = () => load({ query: request.query, pageToken: page.nextPageToken })
  const clearSearch = () => {
    setQuery('')
    search('')
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        size="lg"
        showCloseButton={false}
        aria-busy={busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy || confirming) event.preventDefault()
        }}
      >
        <div className="flex h-96 max-h-svh min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle ref={title} tabIndex={-1}>
              {confirming ? 'Confirm file sharing' : 'Add from Google Drive'}
            </DialogTitle>
            <DialogDescription>
              {confirming ? (
                <>
                  {`Holi will attach these files to “${eventTitle}” and try to give event guests viewer access.`}{' '}
                  Google may email guests about new access.
                </>
              ) : (
                'Choose the files you want to attach. Nothing is shared until you confirm.'
              )}
            </DialogDescription>
          </DialogHeader>
          {confirming ? (
            <>
              <ul
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto text-sm"
                aria-label="Files to attach"
              >
                {selection.map(({ id, name }) => (
                  <li className="wrap-anywhere" key={id}>
                    {name}
                  </li>
                ))}
              </ul>
              {busy && (
                <p role="status" className="text-muted-foreground text-sm">
                  Waiting for Google to confirm attachments and guest access…
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  type="search"
                  ref={searchInput}
                  aria-label="Search Drive files"
                  placeholder="Search Drive files"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      search(query)
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => search(query)}>
                  Search
                </Button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-1">
                {candidates.length > 0 && (
                  <ul className="flex flex-col gap-2" aria-label="Drive files">
                    {candidates.map((file) => {
                      const attached = attachedIds.has(file.id)
                      const unconfirmed = unconfirmedIds.has(file.id)
                      const selected = selection.some(({ id }) => id === file.id)
                      return (
                        <li key={file.id}>
                          <FieldLabel className="items-center">
                            <Checkbox
                              type="button"
                              checked={attached || selected}
                              disabled={attached || unconfirmed || (!selected && remaining === 0)}
                              onCheckedChange={(checked) =>
                                setSelection((previous) => {
                                  if (!checked) return previous.filter(({ id }) => id !== file.id)
                                  if (
                                    attached ||
                                    unconfirmed ||
                                    previous.length >= slots ||
                                    previous.some(({ id }) => id === file.id)
                                  )
                                    return previous
                                  return [...previous, file]
                                })
                              }
                            />
                            <span className="min-w-0 wrap-anywhere">{file.name}</span>
                            {(attached || unconfirmed) && (
                              <span className="text-muted-foreground text-xs">
                                {attached
                                  ? 'Already attached'
                                  : 'Previous Calendar update not confirmed'}
                              </span>
                            )}
                          </FieldLabel>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {loading && (
                  <div
                    role="status"
                    aria-label="Loading Drive files"
                    className="flex flex-col gap-2"
                  >
                    <Skeleton className="h-5 w-full" />
                    <Skeleton className="h-5 w-2/3" />
                  </div>
                )}
                {failure && (
                  <div className="flex flex-col items-start gap-2">
                    <ErrorState
                      compact
                      title="Could not load Drive files"
                      message={messageOf(failure.cause, 'Google did not return a page of files.')}
                      onRetry={() => load({ ...request })}
                    />
                    {attachmentConsentNeeded(failure.cause) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onClose()
                          onOpenConnections()
                        }}
                      >
                        Open Connections
                      </Button>
                    )}
                  </div>
                )}
                {!loading &&
                  !failure &&
                  (page.files.length === 0 ? (
                    <EmptyState
                      title={
                        page.nextPageToken
                          ? 'No files on this page'
                          : request.query
                            ? 'No matching Drive files'
                            : 'No Drive files found'
                      }
                      action={
                        page.nextPageToken
                          ? { label: 'Load more', onClick: loadMore }
                          : request.query
                            ? { label: 'Clear search', onClick: clearSearch }
                            : { label: 'Refresh files', onClick: clearSearch }
                      }
                    />
                  ) : (
                    page.nextPageToken && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={loadMore}
                      >
                        Load more
                      </Button>
                    )
                  ))}
              </div>
              <div className="flex items-center gap-2">
                <span role="status" className="text-muted-foreground text-xs tabular-nums">
                  {selection.length} selected · {remaining} attachment{' '}
                  {remaining === 1 ? 'slot' : 'slots'} left
                  {selection.length > slots
                    ? ` · Remove ${selection.length - slots} to continue`
                    : ''}
                </span>
                {selection.length > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSelection([])}>
                    Clear selection
                  </Button>
                )}
              </div>
            </>
          )}
          <DialogFooter>
            {confirming && !busy && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Back
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            {confirming ? (
              <Button
                type="button"
                size="sm"
                disabled={busy || !canConfirm}
                onClick={() => onConfirm(selection)}
              >
                Attach and share with guests
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!canConfirm}
                onClick={() => setConfirming(true)}
              >
                Review files
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
