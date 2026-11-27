import { ErrorState, LoadingRows } from '@/composites/empty-state'

/** Before the first authoritative account answer, neither mail actions nor a
 * disconnected message are valid. Known-account refreshes do not enter here. */
export function MailAccountPending({
  readError,
  onRetry,
  className,
}: {
  readError: boolean
  onRetry: () => void
  className?: string
}) {
  return readError ? (
    <ErrorState
      title="Could not load your Google account"
      onRetry={onRetry}
      className={className}
    />
  ) : (
    <LoadingRows label="Loading Google account" className={className} />
  )
}
