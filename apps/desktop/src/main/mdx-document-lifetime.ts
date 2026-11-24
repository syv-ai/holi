import type { WebContents } from 'electron'

/** Track document readiness; the IPC sender must still be authenticated separately. */
export function trackMdxDocument(
  contents: Pick<WebContents, 'on'>,
  retire: (retireDocument: boolean) => void,
): () => boolean {
  let ready = false
  const discard = () => {
    ready = false
    retire(true)
  }
  discard()
  contents.on('did-start-navigation', (event) => {
    // A provisional navigation may be prevented (or fail). Retire the work in
    // flight, but keep the committed document's context so its Retry can acquire
    // a fresh lease without needing to re-read trust status.
    if (event.isMainFrame && !event.isSameDocument) retire(false)
  })
  contents.on('did-navigate', () => {
    // Retire again at commit: the old document may have retried while the
    // navigation was provisional. This also covers a same-URL reload.
    discard()
    ready = true
  })
  contents.on('did-fail-provisional-load', (_event, _code, _description, _url, isMainFrame) => {
    // Electron 43 emits this from DidFinishNavigation only after an error page
    // commits, in place of did-navigate. A prevented or aborted navigation that
    // leaves the old document in place never reaches that committed branch.
    if (isMainFrame) discard()
  })
  contents.on('render-process-gone', discard)
  contents.on('destroyed', discard)
  return () => ready
}
