import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/composites/empty-state'
import { ExternalLinkIcon, PlusIcon } from 'lucide-react'
import type {
  AttachEventFilesResult,
  DriveFile,
  EventAttachment,
  EventAttachments as AttachmentList,
  EventAttachmentTarget,
} from '../../shared/event-attachments'
import { googleCap } from '../google-cap'
import { codeOf, isDisconnected, messageOf } from '../google-errors'
import { DriveFilesDialog } from './drive-files-dialog'

type Read = { data: AttachmentList } | { error: unknown }
type Attempt = { files: DriveFile[]; result: AttachEventFilesResult; reconnect?: boolean }

/** The caller keys this section by the vault, account, calendar and event. */
export function EventAttachments({
  remote,
  target,
  eventTitle,
  onOpenExternal,
  onOpenConnections,
  openCalendar,
}: {
  remote: string
  target: EventAttachmentTarget
  eventTitle: string
  onOpenExternal: (url: string) => void
  onOpenConnections: () => void
  openCalendar: () => void
}) {
  const { expectedAccountSub, calendarId, eventId } = target
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [revision, setRevision] = useState(0)
  const [dialog, setDialog] = useState<'pick' | 'retry' | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const writing = useRef(false)
  const mounted = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let current = true
    void googleCap.eventAttachments(remote, { expectedAccountSub, calendarId, eventId }).then(
      (data) => {
        if (current) setRead({ data })
      },
      (error: unknown) => {
        if (current) setRead({ error })
      },
    )
    return () => {
      current = false
    }
  }, [remote, expectedAccountSub, calendarId, eventId, revision])

  const reload = () => {
    setRead(null)
    setRevision((previous) => previous + 1)
  }
  const data = read && 'data' in read ? read.data : null
  const readError = read && 'error' in read ? read : null
  const confirm = async (files: DriveFile[]) => {
    if (writing.current || !mounted.current || !data?.canAttach) return
    writing.current = true
    setBusy(true)
    try {
      const result = await googleCap.attachEventFiles(remote, {
        ...target,
        fileIds: files.map(({ id }) => id),
      })
      if (!mounted.current) return
      setAttempt({ files, result: { ...result, sharing: result.sharing ?? [] } })
    } catch (error) {
      if (!mounted.current) return
      setAttempt({
        files,
        result: {
          attachments: [],
          attachmentStatus: 'unknown',
          sharing: [],
          message: messageOf(error, 'Google did not return an attachment result.'),
        },
        reconnect: codeOf(error) === 'FORBIDDEN' || isDisconnected(error),
      })
    } finally {
      writing.current = false
      if (mounted.current) {
        setBusy(false)
        setDialog(null)
        // The write's snapshot is not always authoritative. Read the event again,
        // even if the write failed, without turning that read into a retry.
        reload()
      }
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} ref={heading} tabIndex={-1} className="text-sm font-medium">
          Attachments
        </h3>
        {data?.canAttach && data.attachments.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              trigger.current = event.currentTarget
              setDialog('pick')
            }}
          >
            <PlusIcon aria-hidden="true" />
            Add from Drive
          </Button>
        )}
      </div>
      {!read && <Skeleton className="h-7 w-full" role="status" aria-label="Loading attachments" />}
      {readError && (
        <div className="flex flex-col items-start gap-2">
          <ErrorState
            compact
            title="Could not load attachments"
            message={messageOf(readError.error, 'Google did not return the event attachments.')}
            onRetry={reload}
          />
          {(codeOf(readError.error) === 'FORBIDDEN' || isDisconnected(readError.error)) && (
            <Button type="button" size="sm" variant="outline" onClick={onOpenConnections}>
              Open Connections
            </Button>
          )}
        </div>
      )}
      {data &&
        (data.attachments.length ? (
          <ul className="flex flex-col gap-1">
            {data.attachments.map((attachment, index) => (
              <AttachmentRow
                key={JSON.stringify([attachment.fileId, attachment.fileUrl, index])}
                attachment={attachment}
                onOpenExternal={onOpenExternal}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No attachments"
            action={
              data.canAttach
                ? undefined
                : { label: 'View event in Google Calendar', onClick: openCalendar }
            }
          >
            {data.canAttach && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  trigger.current = event.currentTarget
                  setDialog('pick')
                }}
              >
                Add from Drive
              </Button>
            )}
          </EmptyState>
        ))}
      {data?.canAttach === false && (
        <p className="text-muted-foreground text-xs">
          {data.reason ?? 'You can’t add files to this event.'}
        </p>
      )}
      {attempt && (
        <AttachmentOutcome
          attempt={attempt}
          canAttach={data?.canAttach === true}
          onCheck={read ? reload : undefined}
          onRetry={(button) => {
            trigger.current = button
            setDialog('retry')
          }}
          onOpenConnections={onOpenConnections}
        />
      )}
      {dialog && data && (
        <DriveFilesDialog
          remote={remote}
          target={target}
          eventTitle={eventTitle}
          attachedIds={data.attachments.flatMap(({ fileId }) => (fileId ? [fileId] : []))}
          retryFiles={dialog === 'retry' ? attempt?.files : undefined}
          busy={busy}
          onConfirm={(files) => void confirm(files)}
          onClose={() => setDialog(null)}
          onRestoreFocus={() =>
            (trigger.current?.isConnected ? trigger.current : heading.current)?.focus()
          }
          onOpenConnections={onOpenConnections}
        />
      )}
    </section>
  )
}

function AttachmentRow({
  attachment: { title, fileUrl },
  onOpenExternal,
}: {
  attachment: EventAttachment
  onOpenExternal: (url: string) => void
}) {
  const name = title || 'Untitled attachment'
  return (
    <li className="min-w-0 wrap-break-word">
      {fileUrl && /^https?:\/\//i.test(fileUrl) && URL.canParse(fileUrl) ? (
        <Button type="button" variant="text" size="inline" onClick={() => onOpenExternal(fileUrl)}>
          <span className="min-w-0 text-start wrap-break-word">{name}</span>
          <ExternalLinkIcon className="icon-sm" aria-hidden="true" />
        </Button>
      ) : (
        name
      )}
    </li>
  )
}

function AttachmentOutcome({
  attempt,
  canAttach,
  onCheck,
  onRetry,
  onOpenConnections,
}: {
  attempt: Attempt
  canAttach: boolean
  onCheck?: () => void
  onRetry: (button: HTMLButtonElement) => void
  onOpenConnections: () => void
}) {
  const { attachmentStatus, message, sharing } = attempt.result
  const denied = sharing.filter(({ status }) => status === 'failed')
  const uncertain = sharing.filter(({ status }) => status === 'unknown')
  const accessible = sharing.length - denied.length - uncertain.length
  const needsRetry = attachmentStatus !== 'attached' || denied.length > 0 || uncertain.length > 0
  return (
    <Alert
      variant={attachmentStatus === 'failed' ? 'destructive' : needsRetry ? 'warning' : 'success'}
    >
      <AlertTitle>
        {attachmentStatus === 'attached'
          ? 'Files attached'
          : attachmentStatus === 'failed'
            ? 'Attachment failed'
            : 'Attachment not confirmed'}
      </AlertTitle>
      <AlertDescription>
        {message && <p>{message}</p>}
        {accessible > 0 && (
          <p className="tabular-nums">
            {`Guest access confirmed for ${accessible} file–guest ${accessible === 1 ? 'pair' : 'pairs'}.`}
          </p>
        )}
        {[...denied, ...uncertain].map(({ fileId, guest, status, message }, index) => (
          <p key={JSON.stringify([fileId, guest, index])} className="wrap-anywhere">
            {status === 'failed' ? 'Sharing failed' : 'Sharing not confirmed'}:{' '}
            {attempt.files.find(({ id }) => id === fileId)?.name ?? fileId} · {guest}
            {message ? ` — ${message}` : ''}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          {attempt.reconnect && (
            <Button type="button" variant="outline" size="sm" onClick={onOpenConnections}>
              Open Connections
            </Button>
          )}
          {attachmentStatus === 'unknown' && (
            <Button type="button" variant="outline" size="sm" disabled={!onCheck} onClick={onCheck}>
              Check attachments
            </Button>
          )}
          {needsRetry && canAttach && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(event) => onRetry(event.currentTarget)}
            >
              Retry same files
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
