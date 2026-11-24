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
  type EventAttachment,
  type EventAttachments as AttachmentList,
  type EventAttachmentTarget,
} from '../../shared/event-attachments'
import { googleAccountRevisionAtom, useGoogleAccount } from '../account'
import { googleCap } from '../google-cap'
import { attachmentConsentNeeded, messageOf } from '../google-errors'
import { AttachmentOutcome } from './attachment-outcome'
import { DriveFilesDialog, type DriveFileChoice } from './drive-files-dialog'

type Read = { data: AttachmentList } | { error: unknown }
type Attempt = {
  files: DriveFileChoice[]
  result: AttachEventFilesResult
  priorSharing: AttachEventFilesResult['sharing']
  writeStatus?: AttachEventFilesResult['calendarWriteStatus']
  checked?: boolean
}
interface Recovery {
  attempt: Attempt | null
  unconfirmedFiles: DriveFileChoice[]
  pending?: 'submit' | 'check'
  checkError: { cause: unknown; files: DriveFileChoice[]; previous?: Attempt } | null
}

// Settings parks Calendar and unmounts the card content. Keep only recovery,
// not the open picker or its unsubmitted selection, in the window's store.
const recoveryAtom = atom(new Map<string, Recovery>())

function reconcileAccess(result: AttachEventFilesResult, previous?: Attempt) {
  const files = result.attachmentsVerified
    ? new Set(result.attachments.map(({ fileId }) => fileId))
    : null
  const guests = result.guestsChecked && new Set(result.guestsChecked)
  const relevant = ({ fileId, guest }: AttachEventFilesResult['sharing'][number]) =>
    (!files || files.has(fileId)) && (!guests || guests.has(guest))
  const sharing = result.sharing.filter(relevant)
  // An incomplete read cannot establish that an uncertain grant failed. Keep
  // that history separate from current results; main owns the durable barrier.
  const priorSharing: AttachEventFilesResult['sharing'] = []
  if (previous && (!files || !guests)) {
    for (const row of [...previous.priorSharing, ...previous.result.sharing]) {
      if (row.status !== 'unknown' || !relevant(row)) continue
      const index = sharing.findIndex(
        ({ fileId, guest }) => fileId === row.fileId && guest === row.guest,
      )
      if (index !== -1 && sharing[index]?.status !== 'failed') continue
      if (index !== -1) sharing.splice(index, 1)
      priorSharing.push(row)
    }
  }
  return { result: { ...result, sharing }, priorSharing }
}

function driveAttachments(attachments: AttachmentList['attachments']): DriveFileChoice[] {
  const files = new Map<string, DriveFileChoice>()
  for (const { fileId, title, mimeType } of attachments) {
    // Calendar supplies a resolved Drive ID. Do not extract IDs from links.
    if (fileId && /^[\w-]+$/.test(fileId) && mimeType !== 'application/vnd.google-apps.shortcut') {
      files.set(fileId, { id: fileId, name: title })
    }
  }
  return [...files.values()].slice(0, ATTACHMENT_LIMIT)
}

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
    checkError: Recovery['checkError']
    accountRevision: number
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const [dialog, setDialog] = useState<'pick' | 'revise' | null>(null)

  useEffect(() => {
    if (!currentAccount) return
    let current = true
    const accept = (read: Read) => {
      if (current) setSnapshot({ read, attempt, checkError, accountRevision })
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
    checkError,
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
    currentAccount &&
    snapshot?.attempt === attempt &&
    snapshot.checkError === checkError &&
    snapshot.accountRevision === accountRevision
      ? snapshot.read
      : null
  const data = read && 'data' in read ? read.data : null
  const readError = read && 'error' in read ? read : null
  const attachedIds = new Set(data?.attachments.flatMap(({ fileId }) => (fileId ? [fileId] : [])))
  const existingFiles = driveAttachments(data?.attachments ?? [])
  const slots = Math.max(0, ATTACHMENT_LIMIT - (data?.attachments.length ?? 0))
  const unconfirmedFiles = recovery?.unconfirmedFiles ?? []
  const unconfirmedIds = new Set(unconfirmedFiles.map(({ id }) => id))
  const unavailable = (id: string) => attachedIds.has(id) || unconfirmedIds.has(id)
  const canSubmit = data?.canAttach === true && !recovery?.pending
  const noWrite =
    attempt &&
    !attempt.checked &&
    attempt.result.attachmentStatus === 'failed' &&
    (attempt.writeStatus === 'not-written' || attempt.writeStatus === undefined)
  const checkAttempt = attempt && !noWrite ? attempt : undefined
  // Check the current attachments, not the entire historical selection. If
  // there's no current list yet, a read-only check can still verify the attempt.
  const knownFiles = data ? existingFiles : driveAttachments(checkAttempt?.result.attachments ?? [])
  const fallbackFiles =
    data || checkAttempt?.result.attachmentsVerified
      ? unconfirmedFiles.slice(0, ATTACHMENT_LIMIT)
      : (checkAttempt?.files ?? [])
  const filesToCheck = knownFiles.length > 0 ? knownFiles : fallbackFiles
  const revisable = noWrite ? attempt.files.filter(({ id }) => !unavailable(id)) : []
  const confirm = async (files: DriveFileChoice[]) => {
    if (
      !canStart() ||
      !canSubmit ||
      files.length === 0 ||
      files.length > ATTACHMENT_LIMIT ||
      files.length > slots ||
      files.some(({ id }) => unavailable(id))
    )
      return
    saveRecovery({ attempt, unconfirmedFiles, pending: 'submit', checkError: null })
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
        calendarWriteStatus: 'unknown',
        attachmentsVerified: false,
        sharing: [],
        message: messageOf(error, 'Google did not return an attachment result.'),
        reconnect: attachmentConsentNeeded(error),
      }
    }
    setDialog(null)
    saveRecovery({
      attempt: { files, ...reconcileAccess(result), writeStatus: result.calendarWriteStatus },
      // A fresh list cannot attribute an attachment to a lost write. Keep
      // this guard per file across unrelated adds and read-only checks.
      unconfirmedFiles:
        result.calendarWriteStatus === 'unknown'
          ? [...unconfirmedFiles, ...files]
          : unconfirmedFiles,
      checkError: null,
    })
  }

  const check = async (files: DriveFileChoice[], previous?: Attempt) => {
    if (!files.length || !currentAccount || !canStart()) return
    saveRecovery({ attempt, unconfirmedFiles, pending: 'check', checkError })
    try {
      const result = await googleCap.checkEventFileAccess(remote, {
        ...target,
        fileIds: files.map(({ id }) => id),
      })
      saveRecovery({
        attempt: {
          files,
          ...reconcileAccess(result, previous),
          writeStatus: previous?.writeStatus,
          checked: true,
        },
        unconfirmedFiles,
        checkError: null,
      })
    } catch (error) {
      // A Drive refusal leaves Calendar readable. Refresh its list even when
      // the access call could not return a Calendar snapshot at all.
      saveRecovery({ attempt, unconfirmedFiles, checkError: { cause: error, files, previous } })
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
        {!checkAttempt && !checkError && filesToCheck.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || checking}
            onClick={() => void check(filesToCheck)}
          >
            Check guest access
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
          {attachmentConsentNeeded(readError.error) && (
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
      {checking && (
        <p role="status" className="text-muted-foreground text-sm">
          Checking guest access without sharing or emailing guests…
        </p>
      )}
      {checkError && (
        <Alert variant="destructive">
          <AlertTitle>Could not check guest access</AlertTitle>
          <AlertDescription>
            <p>{messageOf(checkError.cause, 'Google did not return the guest access result.')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!currentAccount || checking}
                onClick={() => void check(checkError.files, checkError.previous)}
              >
                Retry check
              </Button>
              {attachmentConsentNeeded(checkError.cause) && (
                <Button type="button" variant="outline" size="sm" onClick={onOpenConnections}>
                  Open Connections
                </Button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}
      {attempt && !checkError && (
        <AttachmentOutcome
          files={attempt.files}
          result={attempt.result}
          priorSharing={attempt.priorSharing}
          writeStatus={attempt.writeStatus}
          checked={attempt.checked}
          data={data}
          canCheck={currentAccount && !recovery?.pending}
          onCheck={
            checkAttempt && filesToCheck.length > 0
              ? () => void check(filesToCheck, checkAttempt)
              : undefined
          }
          onRevise={
            canSubmit && slots > 0 && revisable.length > 0
              ? (button) => {
                  trigger.current = button
                  setDialog('revise')
                }
              : undefined
          }
          onOpenConnections={onOpenConnections}
        />
      )}
      {dialog && data && (
        <DriveFilesDialog
          remote={remote}
          target={target}
          eventTitle={eventTitle}
          attachedIds={attachedIds}
          unconfirmedIds={unconfirmedIds}
          slots={slots}
          initialFiles={dialog === 'revise' ? revisable : undefined}
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
