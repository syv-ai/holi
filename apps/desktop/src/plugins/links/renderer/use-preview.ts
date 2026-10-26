/**
 * A page's preview, as the cards read it: asked of main (`links.preview`),
 * which fetches and caches it, and remembered here for the session so a card
 * shown twice draws at once the second time.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, capClient } from '@/plugin-api'
import type { linkCapabilities } from '../main/capabilities'
import type { LinkPreview } from '../shared/preview'

export const linksCap = capClient<ReturnType<typeof linkCapabilities>>('links')

/** Per vault and address: what a card asked, or is asking. */
const asked = new Map<string, Promise<LinkPreview>>()

/** `url`'s preview, asked once per session; the address alone if main
 *  cannot be asked. */
function previewOf(remote: string | null, url: string): Promise<LinkPreview> {
  const key = `${remote}\n${url}`
  const known = asked.get(key)
  if (known !== undefined) return known
  const next: Promise<LinkPreview> =
    remote === null
      ? Promise.resolve({ url })
      : linksCap.preview(remote, { url }).catch((): LinkPreview => ({ url }))
  asked.set(key, next)
  // A page that said nothing is asked again next time: main keeps what will
  // not change, and asks the page again for what might.
  void next.then((p) => {
    if (p.title === undefined && asked.get(key) === next) asked.delete(key)
  })
  return next
}

/** `url`'s preview, null while it is on its way. */
export function usePreview(url: string): LinkPreview | null {
  const remote = useAtomValue(activeRemoteAtom)
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  useEffect(() => {
    let live = true
    setPreview(null)
    void previewOf(remote, url).then((p) => {
      if (live) setPreview(p)
    })
    return () => {
      live = false
    }
  }, [remote, url])
  return preview
}
