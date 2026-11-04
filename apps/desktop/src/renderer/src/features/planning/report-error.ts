import { toast } from 'sonner'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A rejection handler that tells the person what failed, in the error's words. */
export const reportError = (what: string) => (err: unknown) => {
  toast.error(what, { description: message(err) })
}
