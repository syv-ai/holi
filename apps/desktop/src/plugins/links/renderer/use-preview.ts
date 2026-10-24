/**
 * A page's preview, as the cards read it: asked of main (`links.preview`),
 * which fetches and caches it, and remembered here for the session so a card
 * shown twice draws at once the second time.
 *
 * Plain React state, no store: the editor's cards are mounted into
 * CodeMirror's tooltips with a root of their own, outside the app's
 * providers.
 */
import { useEffect, useState } from 'react'
import { capClient } from '@/plugin-api'
import type { linkCapabilities } from '../main/capabilities'
import type { LinkPreview } from '../shared/preview'

export const linksCap = capClient<ReturnType<typeof linkCapabilities>>('links')

/** The vault the plugin runs in now, which every ask names. Set by the
 *  plugin's `vault` hook, so a card in a CodeMirror tooltip can ask. */
let remote: string | null = null

export function setLinksRemote(next: string | null): void {
  remote = next
  asked.clear()
}

const asked = new Map<string, Promise<LinkPreview>>()

/** `url`'s preview, asked once per session; the address alone if main
 *  cannot be asked. */
export function previewOf(url: string): Promise<LinkPreview> {
  const known = asked.get(url)
  if (known !== undefined) return known
  const next: Promise<LinkPreview> =
    remote === null
      ? Promise.resolve({ url })
      : linksCap.preview(remote, { url }).catch((): LinkPreview => ({ url }))
  asked.set(url, next)
  // A page that said nothing is asked again next time: main keeps what will
  // not change, and asks the page again for what might.
  void next.then((p) => {
    if (p.title === undefined && asked.get(url) === next) asked.delete(url)
  })
  return next
}

/** `url`'s preview, null while it is on its way. */
export function usePreview(url: string): LinkPreview | null {
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  useEffect(() => {
    let live = true
    setPreview(null)
    void previewOf(url).then((p) => {
      if (live) setPreview(p)
    })
    return () => {
      live = false
    }
  }, [url])
  return preview
}
