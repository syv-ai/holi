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
  checked,
  data,
  canCheck,
  onCheck,
  onRevise,
  onOpenConnections,
}: {
  files: DriveFileChoice[]
  result: AttachEventFilesResult
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
  const issues = sharing.filter(
    ({ status }) => status === 'failed' || status === 'unknown' || status === 'blocked',
  )
  const accessible = sharing.filter(
    ({ fileId, status }) =>
      observed.has(fileId) &&
      present.has(fileId) &&
      (status === 'granted' || status === 'already-accessible'),
  )
  const incomplete = result.sharingComplete === false || issues.length > 0 || reconnect || message
  const title = stillAttached
    ? incomplete
      ? 'Guest access incomplete'
      : checked
        ? 'Guest access checked'
        : 'Files attached'
    : attachmentStatus === 'failed' && !checked
      ? 'Attachment failed'
      : 'Attachment not confirmed'
  return (
    <Alert
      variant={
        attachmentStatus === 'failed'
          ? 'destructive'
          : incomplete || !stillAttached
            ? 'warning'
            : 'success'
      }
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {stillAttached && incomplete && !checked && <p>Files attached.</p>}
        {missingFromCalendar && (checked || attachmentStatus === 'attached') && (
          <p>One or more checked files aren’t on the event.</p>
        )}
        {message && <p>{message}</p>}
        {accessible.length > 0 && (
          <p className="tabular-nums">
            {`Guest access confirmed for ${accessible.length} file–guest ${accessible.length === 1 ? 'pair' : 'pairs'}.`}
          </p>
        )}
        {issues.map(({ fileId, guest, status, message }) => (
          <p key={JSON.stringify([fileId, guest])} className="wrap-anywhere">
            {status === 'blocked'
              ? 'Sharing blocked'
              : status === 'unknown'
                ? 'Sharing not confirmed'
                : 'Guest access incomplete'}
            : {files.find(({ id }) => id === fileId)?.name ?? fileId} · {guest}
            {message ? ` — ${message}` : ''}
          </p>
        ))}
        {issues.some(({ status }) => status === 'blocked') && (
          <p>Holi won’t share this file again while a previous sharing request is unconfirmed.</p>
        )}
        {(stillAttached || files.some(({ id }) => present.has(id))) && incomplete && (
          <p>Open the attached file to manage access in Google Drive if you can share it.</p>
        )}
        {attachmentStatus === 'failed' && !checked && reconnect && (
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
