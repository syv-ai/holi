import type { MailComposerHandle } from './mail-composer'

/** One composition's identity and its mounted persistence seam. Identity is never derived from a resettable counter. */
export interface ComposeSession {
  readonly identity: object
  readonly handle: MailComposerHandle | null
}

/** Shared navigation gate used by the Mail tab and sidebar surface. */
export class ComposeSessionGate {
  private active: ComposeSession | null = null
  private generation = 0

  current(): ComposeSession | null {
    return this.active
  }

  begin(handle: MailComposerHandle | null = null): ComposeSession {
    const session = { identity: {}, handle }
    this.generation += 1
    this.active = session
    return session
  }

  attach(identity: object, handle: MailComposerHandle | null): void {
    if (this.active?.identity === identity) this.active = { identity, handle }
  }

  async leave(action: () => void): Promise<boolean> {
    const session = this.active
    const generation = this.generation
    if (session?.handle !== null && session?.handle !== undefined) {
      if (!(await session.handle.prepareToLeave())) return false
    }
    if (this.generation !== generation || this.active?.identity !== session?.identity) return false
    this.active = null
    action()
    return true
  }

  invalidate(): void {
    this.generation += 1
    this.active = null
  }
}
