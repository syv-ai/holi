import type { WebContents, WebFrameMain } from 'electron'
import {
  createFrameAddressing,
  type FrameAddress,
  type FrameCapture,
} from '../src/plugins/browser/main/frame-addressing'

/** Private fixture owner for one adapter generation and only that generation's leases. */
export class FrameAddressingScenario {
  private adapter: ReturnType<typeof createFrameAddressing>
  private leases = new WeakSet<FrameAddress>()

  constructor(
    private readonly contents: WebContents,
    private readonly current: (capture: FrameCapture) => boolean,
  ) {
    this.adapter = createFrameAddressing(contents, current)
  }

  async resolve(frame: WebFrameMain, capture: FrameCapture): Promise<FrameAddress> {
    const lease = await this.adapter.resolve(frame, capture)
    this.leases.add(lease)
    return lease
  }

  evaluate<T>(lease: FrameAddress, expression: string): Promise<T> {
    this.assertOwned(lease)
    return this.adapter.evaluate<T>(lease, expression)
  }

  verifyOwner(lease: FrameAddress, selector: string): Promise<boolean> {
    this.assertOwned(lease)
    return this.adapter.verifyOwner(lease, selector)
  }

  revoke(capture: FrameCapture): void {
    this.adapter.revoke(capture)
  }

  recreate(): void {
    this.adapter.dispose()
    this.leases = new WeakSet()
    this.adapter = createFrameAddressing(this.contents, this.current)
  }

  dispose(): void {
    this.adapter.dispose()
    this.leases = new WeakSet()
  }

  private assertOwned(lease: FrameAddress): void {
    if (!this.leases.has(lease))
      throw new Error('fixture lease belongs to a disposed adapter generation')
  }
}
