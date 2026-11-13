import { useEffect } from 'react'
import { toast } from 'sonner'
import { keyTargetOf } from '@/lib/shortcuts'
import { dialogOpen } from '@/lib/dialog-open'
import { trpc } from '@/lib/trpc'

/** Open a copied Holi link pasted onto the page; editable surfaces keep native paste. */
export function useHoliLinkPaste(): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || keyTargetOf(event.target) !== 'page' || dialogOpen()) return
      const text = event.clipboardData?.getData('text/plain')?.trim()
      if (!text || !/^holi:\/\//i.test(text)) return
      event.preventDefault()
      void trpc.holiLinks.openPasted
        .mutate({ url: text })
        .then((result) => {
          if (!result.ok) toast.error(result.message, { description: result.detail })
        })
        .catch(() => toast.error('This link cannot be opened.', { description: 'Try again.' }))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])
}
