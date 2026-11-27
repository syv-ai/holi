import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { AttachEventFilesResult } from '../../shared/event-attachments'
import type { DriveFileChoice } from './drive-files-dialog'

type AttachmentObservation<Result> = Readonly<{
  files: readonly DriveFileChoice[]
  result: Readonly<Result>
}>

export type AttachmentSubmission = AttachmentObservation<AttachEventFilesResult>

export type AttachmentAccessCheck = AttachmentObservation<
  Omit<AttachEventFilesResult, 'calendarWriteStatus'>
> & { readonly priorSharing: AttachEventFilesResult['sharing'] }

export function AttachmentOutcome({
  submission,
  accessCheck,
  checkFailed,
  calendar,
  canCheck,
  onCheck,
  onRevise,
  onOpenConnections,
}: {
  submission: AttachmentSubmission | null
  accessCheck: AttachmentAccessCheck | null
  checkFailed: boolean
  calendar: { driveIds: ReadonlySet<string>; live: boolean; hasUnidentifiedLinks: boolean } | null
  canCheck: boolean
  onCheck?: () => void
  onRevise?: (button: HTMLButtonElement) => void
  onOpenConnections: () => void
}) {
  const active = checkFailed ? null : (accessCheck ?? submission)
  const { files = [], result } = active ?? {}
  const { attachmentStatus, sharing = [], reconnect, message } = result ?? {}
  const writeStatus = submission?.result.calendarWriteStatus
  const checked = active !== null && active === accessCheck
  const showHistory = submission !== null && active !== submission
  const refused = submission?.result.attachmentStatus === 'failed'
  const noWrite = active !== null && active === submission && refused
  const driveIds = calendar?.driveIds
  // A verified access response can disprove presence before the list refresh
  // returns; only the fresh list can promote presence or re-enable submission.
  const missingFromCalendar = driveIds && files.some(({ id }) => !driveIds.has(id))
  const stillAttached = !!calendar?.live && !missingFromCalendar
  const observed = new Set(result?.attachments.map(({ fileId }) => fileId))
  const guests = result?.guestsChecked && new Set(result.guestsChecked)
  const earlierOnly =
    result?.attachmentsVerified === false ||
    (result?.attachmentsVerified === true && guests === undefined)
  const relevant = ({ fileId, guest }: AttachEventFilesResult['sharing'][number]) =>
    (!driveIds || driveIds.has(fileId)) && (!guests || guests.has(guest))
  const accessible = (status: AttachEventFilesResult['sharing'][number]['status']) =>
    status === 'granted' || status === 'already-accessible'
  const rows = sharing.filter(relevant)
  const accessRows = [
    ...rows
      .filter(
        ({ fileId, status }) =>
          !accessible(status) || earlierOnly || !calendar?.live || !observed.has(fileId),
      )
      .map((row) => ({
        row,
        label: earlierOnly || accessible(row.status) ? 'Earlier Drive observation: ' : '',
      })),
    ...(checked && accessCheck ? accessCheck.priorSharing : [])
      .filter((row) => !guests && relevant(row))
      .map((row) => ({ row, label: 'Prior result: ' })),
  ]
  // A fresh Calendar list can confirm which files are attached, not who can open them.
  const confirmed =
    !earlierOnly && calendar?.live
      ? rows.filter(({ fileId, status }) => observed.has(fileId) && accessible(status)).length
      : 0
  const incomplete =
    noWrite ||
    earlierOnly ||
    result?.sharingComplete === false ||
    accessRows.length > 0 ||
    reconnect ||
    message
  const unresolvedIdentity = missingFromCalendar && calendar?.hasUnidentifiedLinks
  const submittedMissing = driveIds && submission?.files.filter(({ id }) => !driveIds.has(id))
  const title = !active
    ? 'Earlier attachment submission'
    : noWrite
      ? 'Attachment update refused'
      : stillAttached
        ? incomplete
          ? 'At last check: Guest access incomplete'
          : checked
            ? 'Guest access checked'
            : writeStatus === 'not-written'
              ? 'Files already on the event'
              : writeStatus === 'unknown'
                ? 'Files on the event'
                : 'Files attached'
        : unresolvedIdentity
          ? 'Drive attachment identity not confirmed'
          : !checked && writeStatus === 'confirmed'
            ? 'Current attachments not confirmed'
            : 'Attachment not confirmed'
  return (
    <Alert
      variant={
        noWrite
          ? 'destructive'
          : active && stillAttached && !incomplete && !submittedMissing?.length
            ? 'success'
            : 'warning'
      }
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {checked && <p>Checked files: {files.map(({ name }) => name).join(', ')}.</p>}
        {active && stillAttached && incomplete && <p>The selected files are on the event.</p>}
        {!checked &&
          !showHistory &&
          writeStatus === 'confirmed' &&
          (!stillAttached || attachmentStatus !== 'attached') && (
            <p>Google confirmed the earlier Calendar update.</p>
          )}
        {!checked && !showHistory && writeStatus === 'unknown' && stillAttached && (
          <p>Google did not confirm the earlier Calendar update.</p>
        )}
        {!checked && !showHistory && (noWrite || writeStatus === 'not-written') && (
          <p>This request did not update Calendar.</p>
        )}
        {noWrite && <p>Guest access was not checked.</p>}
        {missingFromCalendar &&
          !noWrite &&
          (unresolvedIdentity ? (
            <p>
              Holi can’t verify the selected files against attachment links without a Drive file ID.
            </p>
          ) : (
            <p>One or more selected files aren’t on the event.</p>
          ))}
        {message && (
          <p>
            {!noWrite &&
              (stillAttached && attachmentStatus !== 'attached'
                ? 'Earlier result: '
                : 'At last check: ')}
            {message}
          </p>
        )}
        {confirmed > 0 && (
          <p className="tabular-nums">
            {`At last check: Guest access confirmed for ${confirmed} file–guest ${confirmed === 1 ? 'pair' : 'pairs'}.`}
          </p>
        )}{' '}
        {accessRows.map(({ row: { fileId, guest, status, message }, label }) => (
          <p key={JSON.stringify([fileId, guest])} className="wrap-anywhere">
            {label || 'At last check: '}
            {status === 'granted'
              ? 'Viewer access granted'
              : status === 'already-accessible'
                ? 'Guest already had access'
                : status === 'blocked'
                  ? 'Sharing blocked'
                  : status === 'unknown'
                    ? 'Sharing not confirmed'
                    : 'Guest access incomplete'}
            :{' '}
            {files.find(({ id }) => id === fileId)?.name ??
              submission?.files.find(({ id }) => id === fileId)?.name ??
              fileId}{' '}
            · {guest}
            {message ? ` — ${message}` : ''}
          </p>
        ))}
        {accessRows.some(({ row, label }) => !label && row.status === 'blocked') && (
          <p>Holi won’t share this file again while a previous sharing request is unconfirmed.</p>
        )}
        {incomplete && files.some(({ id }) => driveIds?.has(id)) && (
          <p>
            Holi can check access but can’t grant it for files already on the event. Open the
            attached file to manage access in Google Drive if you can share it.
          </p>
        )}
        {!stillAttached && noWrite && reconnect && (
          <p>
            Reconnect Google before confirming again. No files were attached or shared by this
            request.
          </p>
        )}
        {showHistory && (
          <div className="flex flex-col gap-1">
            <p>Previously submitted: {submission.files.map(({ name }) => name).join(', ')}.</p>
            {writeStatus === 'confirmed' && <p>Google confirmed the earlier Calendar update.</p>}
            {writeStatus === 'unknown' && (
              <p>Google did not confirm the earlier Calendar update.</p>
            )}
            {(writeStatus === 'not-written' || refused) && (
              <p>The earlier request did not update Calendar.</p>
            )}
            {refused && submission.result.message && <p>{submission.result.message}</p>}
            {!refused && submittedMissing && submittedMissing.length > 0 && (
              <p>
                {calendar?.hasUnidentifiedLinks
                  ? 'Earlier files not identified by Drive file ID on the event: '
                  : 'Earlier files not on the event: '}
                {submittedMissing.map(({ name }) => name).join(', ')}.
              </p>
            )}
          </div>
        )}
        {onCheck && <p>Checking access does not share files or notify guests.</p>}
        <div className="flex flex-wrap gap-2">
          {reconnect && (
            <Button type="button" variant="outline" size="sm" onClick={onOpenConnections}>
              Open Connections
            </Button>
          )}
          {onCheck && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canCheck}
              onClick={onCheck}
            >
              Check guest access
            </Button>
          )}
          {onRevise && (
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
