import { watch, type FSWatcher } from 'chokidar'
import { readFile, writeFile } from 'node:fs/promises'
import * as Y from 'yjs'
import { applyAgentTurn, BRIDGE_ORIGIN } from './merge'

interface BridgeOpts {
  /** Quiet period after the last file event before the turn ends. */
  turnIdleMs: number
  /** Debounce for CRDT→file re-materialization on remote updates. */
  materializeDebounceMs: number
}

/**
 * D25 turn protocol:
 * - base = { text, Yjs state } captured at every materialization
 * - first watcher event where disk ≠ base ⇒ turn starts (soft lock:
 *   re-materialization paused, base frozen)
 * - idle debounce ⇒ turn ends: applyAgentTurn(live, base.state, fileText),
 *   new base = merge result, re-materialize, release
 */
export class BridgeClient {
  readonly doc = new Y.Doc()
  turns = 0

  private base: { text: string; state: Uint8Array } = { text: '', state: new Uint8Array() }
  private turnActive = false
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private materializeTimer: ReturnType<typeof setTimeout> | null = null
  private watcher: FSWatcher | null = null
  private readonly opts: BridgeOpts

  constructor(
    private readonly filePath: string,
    opts: Partial<BridgeOpts> = {},
  ) {
    this.opts = { turnIdleMs: 250, materializeDebounceMs: 50, ...opts }
  }

  get text(): Y.Text {
    return this.doc.getText('content')
  }

  get isTurnActive(): boolean {
    return this.turnActive
  }

  get baseText(): string {
    return this.base.text
  }

  async start(): Promise<void> {
    await this.materialize()
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== BRIDGE_ORIGIN) this.scheduleMaterialize()
    })
    this.watcher = watch(this.filePath, { ignoreInitial: true })
    this.watcher.on('change', () => void this.onFileEvent())
    this.watcher.on('add', () => void this.onFileEvent())
  }

  async stop(): Promise<void> {
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    await this.watcher?.close()
  }

  private scheduleMaterialize(): void {
    if (this.turnActive) return // soft lock: paused during agent turn
    if (this.materializeTimer) clearTimeout(this.materializeTimer)
    this.materializeTimer = setTimeout(
      () => void this.materialize(),
      this.opts.materializeDebounceMs,
    )
  }

  /** CRDT → file. Captures the new base (text + state) atomically with the write. */
  private async materialize(): Promise<void> {
    if (this.turnActive) return
    const onDisk = await readFile(this.filePath, 'utf8').catch(() => null)
    if (onDisk !== null && onDisk !== this.base.text) {
      // Disk already diverged from base: an agent turn is underway that the
      // watcher hasn't delivered yet. Don't clobber — treat as a turn event.
      void this.onFileEvent()
      return
    }
    const text = this.text.toString()
    this.base = { text, state: Y.encodeStateAsUpdate(this.doc) }
    if (onDisk !== text) await writeFile(this.filePath, text, 'utf8')
  }

  private async onFileEvent(): Promise<void> {
    const content = await readFile(this.filePath, 'utf8').catch(() => null)
    if (content === null) return
    if (content === this.base.text) return // echo of our own materialization / no-op
    if (!this.turnActive) this.turnActive = true // soft lock engaged
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = setTimeout(() => void this.endTurn(), this.opts.turnIdleMs)
  }

  private async endTurn(): Promise<void> {
    const fileText = await readFile(this.filePath, 'utf8')
    const { agentState } = applyAgentTurn(this.doc, this.base.state, fileText)
    this.turns += 1

    const onDisk = await readFile(this.filePath, 'utf8').catch(() => null)
    if (onDisk === fileText) {
      // Turn really over: new base = merge result; re-materialize; release.
      const merged = this.text.toString()
      this.base = { text: merged, state: Y.encodeStateAsUpdate(this.doc) }
      if (merged !== fileText) await writeFile(this.filePath, merged, 'utf8')
      this.turnActive = false
    } else {
      // The agent wrote again while we merged. Its new content is derived from
      // fileText (its lineage), NOT from the merge result — so the next diff
      // must run against the agent lineage: base = fileText + agent ops.
      this.base = { text: fileText, state: agentState }
      if (this.turnTimer) clearTimeout(this.turnTimer)
      this.turnTimer = setTimeout(() => void this.endTurn(), this.opts.turnIdleMs)
    }
  }
}
