import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export function MailPartialAlert({
  busy,
  retrying,
  recoveryError,
  onRetry,
}: {
  busy: boolean
  retrying: boolean
  recoveryError?: string
  onRetry: () => void
}) {
  return (
    <div className="shrink-0 px-3 py-2">
      <Alert variant={recoveryError === undefined ? 'warning' : 'destructive'}>
        <AlertDescription>
          {recoveryError ?? 'Some threads couldn’t be loaded.'}
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRetry}>
            {retrying ? 'Retrying…' : recoveryError === undefined ? 'Retry' : 'Try again'}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
