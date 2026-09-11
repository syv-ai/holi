/**
 * Draws every open frontmatter block, wherever its editor happens to be.
 *
 * Mounted once, in the app shell. Each CodeMirror frontmatter widget publishes
 * an empty container to `frontmatter-portals`; this renders into all of them
 * through `createPortal`, so the controls are part of the app's single React
 * tree — same root, same providers, same context — while living inside a
 * widget's DOM.
 *
 * One host rather than one per editor: a widget does not know which pane it is
 * in, and every editor in the app wants the same treatment anyway.
 */
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  frontmatterPortals,
  subscribeFrontmatterPortals,
} from '@/editor/frontmatter-portals'
import { FrontmatterFields } from './FrontmatterFields'

export function FrontmatterFieldsHost(): React.JSX.Element {
  const portals = useSyncExternalStore(subscribeFrontmatterPortals, frontmatterPortals)
  return (
    <>
      {portals.map((portal) =>
        createPortal(
          <FrontmatterFields path={portal.path} yaml={portal.yaml} onWrite={portal.write} />,
          portal.el,
          String(portal.id),
        ),
      )}
    </>
  )
}
