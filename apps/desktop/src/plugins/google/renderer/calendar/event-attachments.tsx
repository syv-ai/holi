import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState, ErrorState } from '@/composites/empty-state'
import { atom, useAtomValue, useStore } from 'jotai'
import { ExternalLinkIcon, PlusIcon } from 'lucide-react'
import {
  ATTACHMENT_LIMIT,
  type AttachEventFilesResult,
  type DriveFile,
  type EventAttachment,
  type EventAttachments as AttachmentList,
  type EventAttachmentTarget,
} from '../../shared/event-attachments'
import { googleAccountRevisionAtom, useGoogleAccount } from '../account'
import { googleCap } from '../google-cap'
import { codeOf, isDisconnected, messageOf } from '../google-errors'
import { DriveFilesDialog } from './drive-files-dialog'

type Read = { data: AttachmentList } | { error: unknown }
type Attempt = { files: DriveFile[]; result: AttachEventFilesResult }
interface Recovery {
  attempt: Attempt | null
  pending?: 'submit' | 'check'
  checkError: { cause: unknown } | null
}

// Settings parks Calendar and unmounts the card content. Keep only recovery,
// not the open picker or its unsubmitted selection, in the window's store.
const recoveryAtom = atom(new Map<string, Recovery>())

const needsCheck = (result: AttachEventFilesResult) =>
  result.attachmentStatus === 'unknown' ||
  result.sharing.some(({ status }) => status === 'unknown') ||
  (result.reconnect === true && result.attachmentStatus !== 'failed')

const needsAttention = (result: AttachEventFilesResult) =>
  result.attachmentStatus !== 'attached' ||
  result.sharingComplete === false ||
  result.sharing.some(({ status }) => status === 'failed' || status === 'unknown') ||
  result.reconnect === true ||
  Boolean(result.message)

function reconcile(
  previous: AttachEventFilesResult,
  checked: AttachEventFilesResult,
): AttachEventFilesResult {
  const sharing = [...checked.sharing]
  const present = new Set(checked.attachments.map(({ fileId }) => fileId))
  for (const row of previous.sharing) {
    const index = sharing.findIndex(
      ({ fileId, guest }) => fileId === row.fileId && guest === row.guest,
    )
    const observed = sharing[index]
    // A missing permission does not prove an in-flight POST failed. Only
    // observing access clears that uncertainty. Keep completed rows if the
    // check stopped partway through (for example, due to a scope refusal).
    if (
      (row.status === 'unknown' &&
        (observed?.status === 'failed' || (!observed && checked.sharingComplete !== true))) ||
      (checked.reconnect &&
        !observed &&
        present.has(row.fileId) &&
        (row.status === 'granted' || row.status === 'already-accessible'))
    ) {
      if (index === -1) sharing.push(row)
      else sharing[index] = row
    }
  }
  return {
    ...checked,
    attachmentStatus:
      checked.attachmentStatus !== 'attached' && previous.attachmentStatus === 'unknown'
        ? 'unknown'
        : checked.attachmentStatus,
    sharing,
  }
}

const reconnectFor = (error: unknown) => codeOf(error) === 'FORBIDDEN' || isDisconnected(error)

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
  const { currentSub, loading: accountLoading, readError: accountReadError } = useGoogleAccount()
  const currentAccount = currentSub === expectedAccountSub && !accountLoading && !accountReadError
  const accountRevision = useAtomValue(googleAccountRevisionAtom)
  const store = useStore()
  const key = JSON.stringify([remote, expectedAccountSub, calendarId, eventId])
  const recovery = useAtomValue(recoveryAtom).get(key)
  const attempt = recovery?.attempt ?? null
  const busy = recovery?.pending === 'submit'
  const checking = recovery?.pending === 'check'
  const checkError = recovery?.checkError ?? null
  const saveRecovery = (next: Recovery) => {
    store.set(recoveryAtom, (previous) => new Map(previous).set(key, next))
  }
  // Guard against a second click or another view of the same event, including
  // while the original card is hidden and the request is still in flight.
  const canStart = () => !recovery?.pending && store.get(recoveryAtom).get(key) === recovery

  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [snapshot, setSnapshot] = useState<{
    read: Read
    attempt: Attempt | null
    accountRevision: number
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const [dialog, setDialog] = useState<'pick' | 'revise' | null>(null)

  useEffect(() => {
    if (!currentAccount) return
    let current = true
    const accept = (read: Read) => {
      if (current) setSnapshot({ read, attempt, accountRevision })
    }
    void googleCap.eventAttachments(remote, { expectedAccountSub, calendarId, eventId }).then(
      (data) => accept({ data }),
      (error: unknown) => accept({ error }),
    )
    return () => {
      current = false
    }
  }, [
    remote,
    expectedAccountSub,
    calendarId,
    eventId,
    revision,
    attempt,
    currentAccount,
    accountRevision,
  ])

  const reload = () => {
    setSnapshot(null)
    setRevision((previous) => previous + 1)
  }
  // Only a fresh Calendar read can re-enable confirmation after an attempt or
  // when a connection is refreshed. The outcome itself isn't the live list.
  const read =
    currentAccount && snapshot?.attempt === attempt && snapshot.accountRevision === accountRevision
      ? snapshot.read
      : null
  const data = read && 'data' in read ? read.data : null
  const readError = read && 'error' in read ? read : null
  const attachedIds = new Set(data?.attachments.flatMap(({ fileId }) => (fileId ? [fileId] : [])))
  const slots = Math.max(0, ATTACHMENT_LIMIT - (data?.attachments.length ?? 0))
  const canSubmit =
    data?.canAttach === true &&
    !(attempt && needsCheck(attempt.result)) &&
    !recovery?.pending &&
    checkError === null
  const confirm = async (files: DriveFile[]) => {
    if (
      !canStart() ||
      !canSubmit ||
      files.length === 0 ||
      files.length > ATTACHMENT_LIMIT ||
      files.filter(({ id }) => !attachedIds.has(id)).length > slots
    )
      return
    saveRecovery({ attempt, pending: 'submit', checkError: null })
    let result: AttachEventFilesResult
    try {
      // A refused preflight returns a definite failure, so users may choose
      // to confirm again once the event is re-read and still eligible.
      result = await googleCap.attachEventFiles(remote, {
        ...target,
        fileIds: files.map(({ id }) => id),
      })
    } catch (error) {
      // A rejected call may have lost the reply after sending the write.
      result = {
        attachments: [],
        attachmentStatus: 'unknown',
        sharing: [],
        message: messageOf(error, 'Google did not return an attachment result.'),
        reconnect: reconnectFor(error),
      }
    }
    setDialog(null)
    saveRecovery({ attempt: { files, result }, checkError: null })
  }

  const check = async () => {
    if (!attempt || !currentAccount || !canStart()) return
    saveRecovery({ attempt, pending: 'check', checkError: null })
    try {
      const result = await googleCap.checkEventFileAccess(remote, {
        ...target,
        fileIds: attempt.files.map(({ id }) => id),
      })
      saveRecovery({
        attempt: { ...attempt, result: reconcile(attempt.result, result) },
        checkError: null,
      })
    } catch (error) {
      saveRecovery({ attempt, checkError: { cause: error } })
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
            disabled={!canSubmit || slots === 0}
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
          {reconnectFor(readError.error) && (
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
                disabled={!canSubmit}
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
      {data?.canAttach && slots === 0 && (
        <p className="text-muted-foreground text-xs">
          This event has no remaining attachment slots.
        </p>
      )}
      {data?.canAttach === false && (
        <p className="text-muted-foreground text-xs">
          {data.reason ?? 'You can’t add files to this event.'}
        </p>
      )}
      {busy && !dialog && (
        <p role="status" className="text-muted-foreground text-sm">
          Waiting for Google to confirm attachments and guest access…
        </p>
      )}
      {attempt && (
        <AttachmentOutcome
          attempt={attempt}
          canRevise={
            canSubmit && (slots > 0 || attempt.files.some(({ id }) => attachedIds.has(id)))
          }
          checking={checking}
          canCheck={currentAccount && !busy}
          checkError={checkError}
          onCheck={() => void check()}
          onRevise={(button) => {
            trigger.current = button
            setDialog('revise')
          }}
          onOpenConnections={onOpenConnections}
        />
      )}
      {dialog && data && (
        <DriveFilesDialog
          remote={remote}
          target={target}
          eventTitle={eventTitle}
          attachedIds={attachedIds}
          slots={slots}
          initialFiles={dialog === 'revise' ? attempt?.files : undefined}
          busy={busy}
          canSubmit={canSubmit}
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
  canRevise,
  checking,
  canCheck,
  checkError,
  onCheck,
  onRevise,
  onOpenConnections,
}: {
  attempt: Attempt
  canRevise: boolean
  checking: boolean
  canCheck: boolean
  checkError: Recovery['checkError']
  onCheck: () => void
  onRevise: (button: HTMLButtonElement) => void
  onOpenConnections: () => void
}) {
  const { attachmentStatus, message, sharing, reconnect } = attempt.result
  const accessible = sharing.filter(
    ({ status }) => status === 'granted' || status === 'already-accessible',
  )
  const incomplete = needsAttention(attempt.result)
  const checkNeeded = needsCheck(attempt.result) || checkError !== null
  const canReconcile = checkNeeded || (incomplete && attachmentStatus === 'attached')
  return (
    <Alert
      variant={attachmentStatus === 'failed' ? 'destructive' : incomplete ? 'warning' : 'success'}
    >
      <AlertTitle>
        {attachmentStatus === 'attached'
          ? incomplete
            ? 'Guest access incomplete'
            : 'Files attached'
          : attachmentStatus === 'failed'
            ? 'Attachment failed'
            : 'Attachment not confirmed'}
      </AlertTitle>
      <AlertDescription>
        {attachmentStatus === 'attached' && incomplete && <p>Files attached.</p>}
        {message && <p>{message}</p>}
        {accessible.length > 0 && (
          <p className="tabular-nums">
            {`Guest access confirmed for ${accessible.length} file–guest ${accessible.length === 1 ? 'pair' : 'pairs'}.`}
          </p>
        )}
        {sharing
          .filter(({ status }) => status === 'failed' || status === 'unknown')
          .map(({ fileId, guest, status, message }) => (
            <p key={JSON.stringify([fileId, guest])} className="wrap-anywhere">
              {status === 'failed' ? 'Guest access incomplete' : 'Sharing not confirmed'}:{' '}
              {attempt.files.find(({ id }) => id === fileId)?.name ?? fileId} · {guest}
              {message ? ` — ${message}` : ''}
            </p>
          ))}
        {checking && <p role="status">Checking attachments and guest access…</p>}
        {checkError !== null && (
          <p>{messageOf(checkError.cause, 'Could not check attachments and guest access.')}</p>
        )}
        {attachmentStatus === 'failed' && reconnect && (
          <p>
            Reconnect Google before confirming again. No files were attached or shared by this
            request.
          </p>
        )}
        {checkNeeded && (
          <p>
            {reconnect || reconnectFor(checkError?.cause)
              ? 'Reconnect Google, then check file access before trying again.'
              : 'Check access before trying again. Google may still be processing the previous request.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(reconnect || reconnectFor(checkError?.cause)) && (
            <Button type="button" variant="outline" size="sm" onClick={onOpenConnections}>
              Open Connections
            </Button>
          )}
          {canReconcile && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={checking || !canCheck}
              onClick={onCheck}
            >
              Check file access
            </Button>
          )}
          {incomplete && canRevise && !checkNeeded && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={(event) => onRevise(event.currentTarget)}
            >
              Revise selection
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
