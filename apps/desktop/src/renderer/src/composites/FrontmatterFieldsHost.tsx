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
 * One block, and the reason it opens rather than appearing.
 *
 * CodeMirror builds the widget's container in `toDOM` and paints it, and React
 * fills it on a later tick — the two cannot be the same frame, because `toDOM`
 * runs inside CodeMirror's own DOM update and a store notification schedules a
 * render after it. So switching between two task files collapsed the block to
 * nothing for a frame and then snapped it back to full height once the rows
 * mounted, which is the blink.
 *
 * `motion-in-row` covers that gap by construction: the layout effect runs after
 * the rows are in the DOM but BEFORE the browser paints, so the block opens from
 * zero to whatever height it turned out to be instead of jumping there. The
 * keyframe has no `to`, so the height comes from the element itself and no
 * number is stated; `backwards` means it goes back to being sized by its own
 * content as soon as the animation is done.
 *
 * A component per portal rather than a loop body, because this needs a hook.
 */
function FrontmatterBlock({ portal }: { portal: FrontmatterPortal }): React.JSX.Element {
  useLayoutEffect(() => playOnce(portal.el, 'motion-in-row'), [portal.el])

  return createPortal(
    <FrontmatterFields path={portal.path} yaml={portal.yaml} onWrite={portal.write} />,
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
