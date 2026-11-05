/**
 * Copying from a menu: the item that copied says Copied for a moment, in
 * place, so the menu stays open and the swap is seen where it was clicked.
 * Only a failure toasts. The document menu and the block menu share it.
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

// Long enough to read the swap, short enough to copy again.
const COPIED_MS = 1600

export function useCopied<TKey extends string>(): {
  /** The item that copied last, while it says so. */
  copied: TKey | null
  /** Copy `value`, unless there is none, and mark `key` copied. */
  copy: (key: TKey, value: string | null | undefined) => Promise<void>
} {
  const [copied, setCopied] = useState<TKey | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy(key: TKey, value: string | null | undefined) {
    if (value === undefined || value === null) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error('Copy failed', {
        description: 'The clipboard could not be written.',
      })
      return
    }
    setCopied(key)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), COPIED_MS)
  }

  return { copied, copy }
}
