import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type {
  AttachEventFilesResult,
  EventAttachments as AttachmentList,
} from '../../shared/event-attachments'
import type { DriveFileChoice } from './drive-files-dialog'

export function AttachmentOutcome({
  files,
  result,
  priorSharing,
  writeStatus,
  checked,
  data,
  canCheck,
  onCheck,
  onRevise,
  onOpenConnections,
}: {
  files: DriveFileChoice[]
  result: AttachEventFilesResult
  priorSharing: AttachEventFilesResult['sharing']
  writeStatus?: AttachEventFilesResult['calendarWriteStatus']
  checked?: boolean
  data: AttachmentList | null
  canCheck: boolean
  onCheck?: () => void
  onRevise?: (button: HTMLButtonElement) => void
  onOpenConnections: () => void
}) {
  const { attachmentStatus, message, sharing, reconnect } = result
  const present = new Set(data?.attachments.map(({ fileId }) => fileId))
  const observed = new Set(result.attachments.map(({ fileId }) => fileId))
  // A previous positive result cannot promote a file absent from Calendar.
  const missingFromCalendar = data !== null && files.some(({ id }) => !present.has(id))
  const stillAttached = data !== null && !missingFromCalendar && attachmentStatus === 'attached'
  const current = sharing.filter(({ fileId }) => !data || present.has(fileId))
  const issues = current.filter(
    ({ status }) => status === 'failed' || status === 'unknown' || status === 'blocked',
  )
  const accessRows = [
    ...issues.map((row) => ({ row, prior: result.attachmentsVerified === false })),
    ...priorSharing
      .filter(({ fileId }) => !data || (result.guestsChecked === undefined && present.has(fileId)))
      .map((row) => ({ row, prior: true })),
  ]
  const accessible = current.filter(
    ({ fileId, status }) =>
      result.attachmentsVerified !== false &&
      observed.has(fileId) &&
      present.has(fileId) &&
      (status === 'granted' || status === 'already-accessible'),
  )
  const incomplete =
    result.sharingComplete === false || accessRows.length > 0 || reconnect || message
  const noWrite =
    !checked &&
    attachmentStatus === 'failed' &&
    (writeStatus === 'not-written' || writeStatus === undefined)
  const title = stillAttached
    ? incomplete
      ? 'Guest access incomplete'
      : checked
        ? 'Guest access checked'
        : 'Files attached'
    : noWrite
      ? 'Attachment failed'
      : writeStatus === 'confirmed'
        ? 'Current attachments not confirmed'
        : 'Attachment not confirmed'
  return (
    <Alert variant={noWrite ? 'destructive' : incomplete || !stillAttached ? 'warning' : 'success'}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {stillAttached && incomplete && !checked && <p>Files attached.</p>}
        {!stillAttached && writeStatus === 'confirmed' && (
          <p>
            Google confirmed the earlier Calendar update. It may not reflect what is attached now.
          </p>
        )}
        {missingFromCalendar && (checked || attachmentStatus === 'attached') && (
          <p>One or more checked files aren’t on the event.</p>
        )}
        {message && <p>{message}</p>}
        {accessible.length > 0 && (
          <p className="tabular-nums">
            {`Guest access confirmed for ${accessible.length} file–guest ${accessible.length === 1 ? 'pair' : 'pairs'}.`}
          </p>
        )}
        {accessRows.map(({ row: { fileId, guest, status, message }, prior }) => (
          <p key={JSON.stringify([fileId, guest])} className="wrap-anywhere">
            {prior && 'Prior result: '}
            {status === 'blocked'
              ? 'Sharing blocked'
              : status === 'unknown'
                ? 'Sharing not confirmed'
                : 'Guest access incomplete'}
            : {files.find(({ id }) => id === fileId)?.name ?? fileId} · {guest}
            {message ? ` — ${message}` : ''}
          </p>
        ))}
        {accessRows.some(({ row, prior }) => !prior && row.status === 'blocked') && (
          <p>Holi won’t share this file again while a previous sharing request is unconfirmed.</p>
        )}
        {(stillAttached || files.some(({ id }) => present.has(id))) && incomplete && (
          <p>Open the attached file to manage access in Google Drive if you can share it.</p>
        )}
        {noWrite && reconnect && (
          <p>
            Reconnect Google before confirming again. No files were attached or shared by this
            request.
          </p>
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
