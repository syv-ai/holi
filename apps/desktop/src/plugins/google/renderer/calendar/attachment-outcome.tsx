import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { AttachEventFilesResult } from '../../shared/event-attachments'
import type { DriveFileChoice } from './drive-files-dialog'

export function AttachmentOutcome({
  files,
  result,
  priorSharing,
  writeStatus,
  checked,
  currentDriveIds,
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
  currentDriveIds: ReadonlySet<string> | null
  canCheck: boolean
  onCheck?: () => void
  onRevise?: (button: HTMLButtonElement) => void
  onOpenConnections: () => void
}) {
  const { attachmentStatus, message, sharing, reconnect } = result
  const observed = new Set(result.attachments.map(({ fileId }) => fileId))
  // Only the fresh Calendar list determines current presence. It says nothing
  // about which request attached the files or whether guests have access.
  const missingFromCalendar =
    currentDriveIds !== null && files.some(({ id }) => !currentDriveIds.has(id))
  const stillAttached = currentDriveIds !== null && !missingFromCalendar
  const current = sharing.filter(({ fileId }) => !currentDriveIds || currentDriveIds.has(fileId))
  const issues = current.filter(
    ({ status }) => status === 'failed' || status === 'unknown' || status === 'blocked',
  )
  const accessRows = [
    ...issues.map((row) => ({ row, prior: result.attachmentsVerified === false })),
    ...priorSharing
      .filter(
        ({ fileId }) =>
          !currentDriveIds || (result.guestsChecked === undefined && currentDriveIds.has(fileId)),
      )
      .map((row) => ({ row, prior: true })),
  ]
  const accessible = current.filter(
    ({ fileId, status }) =>
      result.attachmentsVerified !== false &&
      observed.has(fileId) &&
      currentDriveIds?.has(fileId) &&
      (status === 'granted' || status === 'already-accessible'),
  )
  const noWrite =
    !checked &&
    attachmentStatus === 'failed' &&
    (writeStatus === 'not-written' || writeStatus === undefined)
  const incomplete =
    noWrite ||
    result.attachmentsVerified === false ||
    result.sharingComplete === false ||
    accessRows.length > 0 ||
    reconnect ||
    message
  const title = stillAttached
    ? incomplete
      ? 'Guest access incomplete'
      : checked
        ? 'Guest access checked'
        : writeStatus === 'not-written'
          ? 'Files already on the event'
          : 'Files attached'
    : noWrite
      ? 'Attachment failed'
      : writeStatus === 'confirmed'
        ? 'Current attachments not confirmed'
        : 'Attachment not confirmed'
  return (
    <Alert
      variant={
        stillAttached ? (incomplete ? 'warning' : 'success') : noWrite ? 'destructive' : 'warning'
      }
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {stillAttached && incomplete && <p>The selected files are on the event.</p>}
        {writeStatus === 'confirmed' && (!stillAttached || attachmentStatus !== 'attached') && (
          <p>Google confirmed the earlier Calendar update.</p>
        )}
        {stillAttached && writeStatus === 'unknown' && (
          <p>Google did not confirm the earlier Calendar update.</p>
        )}
        {stillAttached && incomplete && !checked && (noWrite || writeStatus === 'not-written') && (
          <p>This request did not update Calendar.</p>
        )}
        {missingFromCalendar && !noWrite && <p>One or more selected files aren’t on the event.</p>}
        {message && (
          <p>
            {stillAttached && attachmentStatus !== 'attached' && 'Earlier result: '}
            {message}
          </p>
        )}
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
        {incomplete && files.some(({ id }) => currentDriveIds?.has(id)) && (
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
