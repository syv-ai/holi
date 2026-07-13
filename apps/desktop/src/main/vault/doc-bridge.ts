/**
 * Per-doc turn protocol (spec §Bridge; spike BridgeClient productionized).
 * - base = { text, yjsState } captured atomically at every materialization,
 *   PERSISTED at every advancement (crash recovery).
 * - foreign disk≠base ⇒ turn opens (soft lock: re-materialization paused,
 *   base frozen, onTurnState(true) → presence + pre-agent-write snapshot).
 * - idle debounce (or signalTurnEnd, the slice-2 Stop-hook seam) ends it:
 *   applyAgentTurn, base advances BEFORE release; agent-lineage base when the
 *   agent wrote again mid-merge (spike finding 2).
 * - Watcher events are advisory: one-shot disk-recheck after every write we
 *   make or ignore (spike finding 3).
 * The vault-level watcher feeds onFileEvent; this class owns no chokidar.
 */
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN, YDOC_TEXT_KEY } from '@holi/shared'
import type { DocBase } from './base-store'

export interface DocBridgeDeps {
  doc: Y.Doc
  readFile(): Promise<string | null>
  writeFile(text: string): Promise<void>
  loadBase(): Promise<DocBase | null>
  saveBase(base: DocBase): Promise<void>
  onTurnState(active: boolean): void
  turnIdleMs?: number
  materializeDebounceMs?: number
}

const RECHECK_MS = 100

export class DocBridge {
  turns = 0

  private base: DocBase = { text: '', state: new Uint8Array() }
  private turnActive = false
  private stopped = false
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private materializeTimer: ReturnType<typeof setTimeout> | null = null
  private recheckTimer: ReturnType<typeof setTimeout> | null = null
  private readonly turnIdleMs: number
  private readonly materializeDebounceMs: number
  private readonly onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin !== BRIDGE_ORIGIN) this.scheduleMaterialize()
  }

  constructor(private readonly deps: DocBridgeDeps) {
    this.turnIdleMs = deps.turnIdleMs ?? 800
    this.materializeDebounceMs = deps.materializeDebounceMs ?? 50
  }

  get isTurnActive(): boolean {
    return this.turnActive
  }

  get baseText(): string {
    return this.base.text
  }

  async start(): Promise<void> {
    const persisted = await this.deps.loadBase()
    this.deps.doc.on('update', this.onUpdate)
    if (persisted) {
      this.base = persisted
      const onDisk = await this.deps.readFile()
      if (onDisk !== null && onDisk !== persisted.text) {
        // crash-time agent divergence — reconcile through a normal turn merge
        await this.onFileEvent()
        return
      }
    }
    // no base (fresh doc): server truth wins — we cannot diff without a base
    await this.materialize()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.deps.doc.off('update', this.onUpdate)
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
  }

  /** Fed by the vault-level watcher (and the disk-recheck defense). */
  async onFileEvent(): Promise<void> {
    if (this.stopped) return
    const content = await this.deps.readFile()
    if (content === null) return // deletion is the mirror's business
    if (content === this.base.text) {
      // echo of our own materialization — but fsevents may have coalesced a
      // foreign write into this very event; verify shortly (spike finding 3)
      this.scheduleDiskRecheck()
      return
    }
    if (!this.turnActive) {
      this.turnActive = true // soft lock engaged
      this.deps.onTurnState(true)
    }
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => void this.endTurn(), this.turnIdleMs)
  }

  /** PreToolUse-hook seam: engage the soft lock BEFORE the agent's write lands,
   * so the pre-write snapshot and presence marker precede the edit. Idle still
   * closes it if the write never arrives (or the Stop hook is lost). */
  signalTurnOpen(): void {
    if (this.stopped || this.turnActive) return
    this.turnActive = true
    this.deps.onTurnState(true)
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => void this.endTurn(), this.turnIdleMs)
  }

  /** Slice-2 Stop-hook seam: end the open turn now instead of waiting for idle. */
  signalTurnEnd(): void {
    if (!this.turnActive) return
    if (this.turnTimer) clearTimeout(this.turnTimer)
    void this.endTurn()
  }

  private scheduleDiskRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer)
    this.recheckTimer = setTimeout(() => {
      void (async () => {
        if (this.stopped || this.turnActive) return // turn timer owns the file
        const onDisk = await this.deps.readFile()
        if (onDisk !== null && onDisk !== this.base.text) void this.onFileEvent()
      })()
    }, RECHECK_MS)
  }

  private scheduleMaterialize(): void {
    if (this.turnActive) return // soft lock: paused during agent turn
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    this.materializeTimer = setTimeout(() => void this.materialize(), this.materializeDebounceMs)
  }

  /** CRDT → file. Captures + persists the new base atomically with the write. */
  private async materialize(): Promise<void> {
    if (this.stopped || this.turnActive) return
    const onDisk = await this.deps.readFile()
    if (onDisk !== null && onDisk !== this.base.text && this.base.state.length > 0) {
      // disk already diverged from a real base: an agent turn is underway that
      // the watcher hasn't delivered yet — don't clobber, treat as turn event
      void this.onFileEvent()
      return
    }
    const text = this.deps.doc.getText(YDOC_TEXT_KEY).toString()
    this.base = { text, state: Y.encodeStateAsUpdate(this.deps.doc) }
    await this.deps.saveBase(this.base)
    if (onDisk !== text) await this.deps.writeFile(text)
    this.scheduleDiskRecheck()
  }

  private async endTurn(): Promise<void> {
    if (this.stopped) return
    const fileText = await this.deps.readFile()
    if (fileText === null) {
      // file vanished mid-turn (agent rm) — release; the mirror handles deletes
      this.turnActive = false
      this.deps.onTurnState(false)
      return
    }
    const { agentState } = applyAgentTurn(this.deps.doc, this.base.state, fileText)
    this.turns += 1

    const onDisk = await this.deps.readFile()
    if (onDisk === fileText) {
      // turn really over: base = merge result BEFORE release (spike invariant)
      const merged = this.deps.doc.getText(YDOC_TEXT_KEY).toString()
      this.base = { text: merged, state: Y.encodeStateAsUpdate(this.deps.doc) }
      await this.deps.saveBase(this.base)
      if (merged !== fileText) await this.deps.writeFile(merged)
      this.turnActive = false
      this.deps.onTurnState(false)
      this.scheduleDiskRecheck()
    } else {
      // the agent wrote again while we merged: continue on the agent lineage
      // (frozen file text + shadow ops), NOT the merge result (spike finding 2)
      this.base = { text: fileText, state: agentState }
      await this.deps.saveBase(this.base)
      if (this.turnTimer) clearTimeout(this.turnTimer)
      this.turnTimer = setTimeout(() => void this.endTurn(), this.turnIdleMs)
    }
  }
}
