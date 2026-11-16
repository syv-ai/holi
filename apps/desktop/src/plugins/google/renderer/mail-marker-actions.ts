import type { MailMarker } from '../shared/mail-markers'

export interface MailMarkerState {
  marker: MailMarker | null
  starred: boolean
}

export interface MailMarkerActionsDeps {
  write: (owner: string, id: string, marker: MailMarker | null) => Promise<void>
  reconcile: (owner: string, id: string, readActualStar: boolean) => Promise<MailMarkerState>
  changed: (id: string, state: MailMarkerState, error: boolean) => void
  settled?: (id: string) => void
  failed?: (cause: unknown) => void
  now?: () => number
}

interface Intent {
  owner: string
  generation: number
  id: string
  marker: MailMarker | null
  starred: boolean
  sequence: number
}

/** Coalesces writes independently per thread and ignores work from retired owners. */
export class MailMarkerActions {
  private owner = ''
  private generation = 0
  private enabledOrder: readonly MailMarker[] = ['yellow-star']
  private lastActivation: { id: string; at: number } | null = null
  private intended = new Map<string, MailMarker | null>()
  private queued = new Map<string, Intent>()
  private running = new Set<string>()
  private sequences = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: MailMarkerActionsDeps) {
    this.now = deps.now ?? Date.now
  }

  setOwner(owner: string, enabledOrder: readonly MailMarker[]): void {
    if (owner === this.owner) {
      this.enabledOrder = enabledOrder.length > 0 ? enabledOrder : ['yellow-star']
      return
    }
    this.owner = owner
    this.generation++
    this.enabledOrder = enabledOrder.length > 0 ? enabledOrder : ['yellow-star']
    this.lastActivation = null
    this.intended.clear()
    this.sequences.clear()
    this.queued.clear()
  }

  activate(id: string, starred: boolean, current: MailMarker | null): void {
    if (!this.owner) return
    const at = this.now()
    const hasIntended = this.intended.has(id)
    const base = hasIntended ? this.intended.get(id)! : current
    const effectiveStarred = hasIntended ? base !== null : starred
    const burst = this.lastActivation?.id === id && at - this.lastActivation.at <= 500
    let marker: MailMarker | null
    if (!effectiveStarred) marker = this.enabledOrder[0] ?? 'yellow-star'
    else if (burst && this.enabledOrder.length > 1) {
      const index = base === null ? -1 : this.enabledOrder.indexOf(base)
      marker = this.enabledOrder[(index + 1) % this.enabledOrder.length] ?? 'yellow-star'
    } else marker = null

    this.lastActivation = { id, at }
    this.intended.set(id, marker)
    const intent: Intent = {
      owner: this.owner,
      generation: this.generation,
      id,
      marker,
      starred: marker !== null,
      sequence: (this.sequences.get(id) ?? 0) + 1,
    }
    this.sequences.set(id, intent.sequence)
    this.queued.set(id, intent)
    this.deps.changed(id, { marker, starred: marker !== null }, false)
    void this.flush(id)
  }

  /** Invalidates all pending work when a mounted surface is disposed. */
  dispose(): void {
    this.generation++
    this.queued.clear()
    this.intended.clear()
    this.sequences.clear()
    this.lastActivation = null
  }

  resetBurst(): void {
    this.lastActivation = null
  }

  /** Forget optimistic state when another mail write owns the resulting value. */
  invalidate(id: string): void {
    this.intended.delete(id)
    this.sequences.set(id, (this.sequences.get(id) ?? 0) + 1)
    this.queued.delete(id)
  }

  /** Retry a failed state read without replaying the potentially refused write. */
  async retry(id: string): Promise<void> {
    const owner = this.owner
    const generation = this.generation
    if (!owner) return
    const sequence = (this.sequences.get(id) ?? 0) + 1
    this.sequences.set(id, sequence)
    const latest = () =>
      generation === this.generation && owner === this.owner && sequence === this.sequences.get(id)
    try {
      const actual = await this.deps.reconcile(owner, id, true)
      if (!latest()) return
      this.intended.delete(id)
      this.deps.changed(id, actual, false)
      this.deps.settled?.(id)
    } catch (cause) {
      if (latest()) this.deps.failed?.(cause)
    }
  }

  private async flush(id: string): Promise<void> {
    if (this.running.has(id)) return
    this.running.add(id)
    try {
      while (this.queued.has(id)) {
        const intent = this.queued.get(id)!
        this.queued.delete(id)
        if (!this.isCurrent(intent)) continue
        try {
          await this.deps.write(intent.owner, id, intent.marker)
          if (!this.isCurrent(intent)) continue
          if (this.latest(intent)) {
            try {
              const actual = await this.deps.reconcile(intent.owner, id, false)
              if (!this.isCurrent(intent) || !this.latest(intent)) continue
              this.intended.delete(id)
              this.deps.changed(id, actual, false)
              this.deps.settled?.(id)
            } catch {
              if (this.isCurrent(intent) && this.latest(intent)) {
                this.deps.changed(id, { marker: intent.marker, starred: intent.starred }, true)
              }
            }
          }
        } catch (cause) {
          if (!this.isCurrent(intent)) continue
          if (this.latest(intent)) {
            this.deps.failed?.(cause)
            try {
              const actual = await this.deps.reconcile(intent.owner, id, true)
              if (!this.isCurrent(intent) || !this.latest(intent)) continue
              this.intended.delete(id)
              this.deps.changed(id, actual, false)
              this.deps.settled?.(id)
              this.lastActivation = null
            } catch {
              if (this.isCurrent(intent) && this.latest(intent)) {
                this.deps.changed(id, { marker: intent.marker, starred: intent.starred }, true)
                this.lastActivation = null
              }
            }
          }
        }
      }
    } finally {
      this.running.delete(id)
      if (this.queued.has(id)) void this.flush(id)
    }
  }

  private isCurrent(intent: Intent): boolean {
    return intent.generation === this.generation && intent.owner === this.owner
  }

  private latest(intent: Intent): boolean {
    return (
      this.queued.get(intent.id) === undefined && intent.sequence === this.sequences.get(intent.id)
    )
  }
}
