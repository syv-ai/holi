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
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  frontmatterPortals,
  subscribeFrontmatterPortals,
  type FrontmatterPortal,
} from '@/editor/frontmatter-portals'
import { playOnce } from '@/lib/motion'
import { FrontmatterFields } from './FrontmatterFields'

/**
 * One block, faded in. CodeMirror paints the widget's container in `toDOM` and
 * React fills it on a later tick, so the block would blink empty for a frame.
 * The layout effect runs after the rows mount but before paint, so the block
 * fades up instead. Opening its height too was rejected as too much motion.
 *
 * A component per portal because this needs a hook.
 */
function FrontmatterBlock({ portal }: { portal: FrontmatterPortal }): React.JSX.Element {
  useLayoutEffect(() => playOnce(portal.el, 'motion-in-fade'), [portal.el])

  return createPortal(
    <FrontmatterFields path={portal.path} yaml={portal.yaml} onWrite={portal.write} facts />,
    portal.el,
  )
}

export function FrontmatterFieldsHost(): React.JSX.Element {
  const portals = useSyncExternalStore(subscribeFrontmatterPortals, frontmatterPortals)
  return (
    <>
      {portals.map((portal) => (
        <FrontmatterBlock key={portal.id} portal={portal} />
      ))}
    </>
  )
}
