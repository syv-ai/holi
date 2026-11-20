import type { WebContents } from 'electron'
import { createFrameAddressingRuntime, type FrameCapture } from './frame-context-runtime'

export type { FrameAddress, FrameCapture } from './frame-context-runtime'

/** Main-private seam for resolving and using authenticated frame addresses. */
export function createFrameAddressing(
  contents: WebContents,
  current: (capture: FrameCapture) => boolean,
) {
  return createFrameAddressingRuntime(contents, current)
}
