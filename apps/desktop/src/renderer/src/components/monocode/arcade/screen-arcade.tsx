import { useAtomValue } from "jotai"

import { arcadeCastAtom, gridArcadeAtom } from "@/state/grid-arcade"

import { HoliArcade } from "./HoliArcade"

const NEVER = () => undefined

/**
 * The arcade as a full screen's background (sign-in, adding a vault): it
 * plays on its own under the screen's content and never takes control, so it
 * takes no pointer and no keys. It keeps clear of what the screen marks
 * `data-arcade-keepout`, and follows the same `gridArcade` setting as the New
 * tab (on by default, so before any vault is open it plays).
 */
export function ScreenArcade() {
  const on = useAtomValue(gridArcadeAtom)
  const cast = useAtomValue(arcadeCastAtom)
  if (!on) return null
  return (
    <HoliArcade
      cast={cast}
      playing={false}
      onRelease={NEVER}
      className="max-md:hidden"
    />
  )
}
