import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export function MailPartialAlert({
  busy,
  retrying,
  onRetry,
}: {
  busy: boolean
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div className="shrink-0 px-3 py-2">
      <Alert variant="warning">
        <AlertDescription>
          Some threads couldn’t be loaded.
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRetry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
