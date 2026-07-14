/**
 * Full-vault live mirror (spec §VaultMirror): a Y.Doc + Hocuspocus provider
 * per doc over ONE multiplexed WebSocket; CRDT→disk via DocBridge; doc-list
 * truth from the server (listDocs + SSE docs events + reconcile on reconnect);
 * agent-created/deleted files propagate with git-ingress symmetry.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { watch, type FSWatcher } from 'chokidar'
import WebSocket from 'ws'
import * as Y from 'yjs'
import {
  BRIDGE_ORIGIN,
  YDOC_TEXT_KEY,
  isTaskFilePath,
  vaultRelPath,
  type DocMeta,
  type VaultRelPath,
} from '@holi/shared'
import { BaseStore } from './base-store'
import { DocBridge } from './doc-bridge'
import {
  absPathFor,
  isIgnoredPath,
  listFiles,
  moveDocFile,
  removeDocFile,
  toVaultRel,
  writeAtomic,
} from './vault-files'

/** ws destroyed mid-handshake emits an unlistened 'error' (teardown race) —
 * pre-attach a no-op listener; the provider's own handlers still run. */
class QuietWebSocket extends WebSocket {
  constructor(address: ConstructorParameters<typeof WebSocket>[0], protocols?: string | string[]) {
    super(address, protocols)
    this.on('error', () => {})
  }
}

export interface MirrorApi {
  listDocs(): Promise<DocMeta[]>
  createNote(path: string): Promise<DocMeta>
  deleteNote(docId: string): Promise<void>
  takeSnapshot(docId: string, label: string): Promise<void>
}

/** Mirrors the server bus's DocsEvent shape (apps/server/src/bus.ts). */
export interface DocsEvent {
  type: 'created' | 'renamed' | 'deleted'
  doc: DocMeta
}

export interface VaultMirrorDeps {
  vaultId: string
  workRoot: string
  baseDir: string
  relayUrl: string
  token: string
  api: MirrorApi
  turnIdleMs?: number
  lifecycleDebounceMs?: number
  log?: (msg: string) => void
  /** Agent seams (slice 2): live count of docs with an open turn, and every
   * CRDT→disk write (used to spot synced agent-config changes mid-session). */
  onTurnActivity?(activeTurns: number): void
  onMaterialize?(rel: string): void
  /** Task files are records, not CRDT docs (prd/tasks.md §Task file projection).
   * The mirror sees them but keeps them out of the doc machinery entirely — no
   * adoption, no bridge, no base, no turn, no merge, no snapshot — and hands the
   * disk event to the TaskProjector instead. Without this, a task file becomes a
   * CRDT note and a server-driven rewrite (a recurrence roll landing the instant
   * the agent marks something done) arrives as a foreign write that opens a
   * spurious turn, mid-turn. */
  onTaskFileEvent?(kind: 'add' | 'change' | 'unlink', rel: VaultRelPath): void
}

interface DocEntry {
  docId: string
  rel: VaultRelPath
  doc: Y.Doc
  provider: HocuspocusProvider
  bridge: DocBridge
  started: boolean
}

export class VaultMirror {
  private readonly entries = new Map<string, DocEntry>() // by docId
  private readonly byPath = new Map<string, DocEntry>() // by rel
  private readonly activeTurns = new Set<string>() // docIds mid-turn
  private readonly pendingLifecycle = new Map<string, ReturnType<typeof setTimeout>>() // by rel
  private readonly bases: BaseStore
  private socket: HocuspocusProviderWebsocket | null = null
  private watcher: FSWatcher | null = null
  private stopped = false
  private readonly lifecycleDebounceMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly deps: VaultMirrorDeps) {
    this.bases = new BaseStore(deps.baseDir)
    this.lifecycleDebounceMs = deps.lifecycleDebounceMs ?? 400
    this.log = deps.log ?? ((msg) => console.log(`[mirror:${deps.vaultId}] ${msg}`))
  }

  async start(): Promise<void> {
    await mkdir(this.deps.workRoot, { recursive: true })
    this.socket = new HocuspocusProviderWebsocket({
      url: this.deps.relayUrl,
      WebSocketPolyfill: QuietWebSocket as never,
    })

    // The watcher goes up — and finishes its initial scan — BEFORE anything
    // writes into the working copy. Order is load-bearing, not tidiness:
    //
    // `refresh()` fires `openEntry` off unawaited, so a doc materializes to disk
    // whenever its relay sync happens to land. If that write hits *during*
    // chokidar's initial scan — after it has listed the directory but before the
    // scan completes — chokidar never learns the file exists, and `ignoreInitial`
    // suppresses the `add` that would have told it. chokidar only emits `unlink`
    // for paths it tracks, so from then on the file is invisible to the watcher:
    // deleting it emits nothing, and the agent's `rm` never reaches the server.
    // (This is what made the mirror suite flaky — the event was never late, it
    // was never sent.)
    //
    // Starting the watcher first makes every mirror write land after the scan, so
    // it arrives as a normal `add`. Those are harmless: `openEntry` registers the
    // path in `byPath` synchronously, before its first await, so an `add` for a
    // file we materialized always finds its entry and is treated as an echo —
    // never adopted as a new doc.
    this.watcher = watch(this.deps.workRoot, { ignoreInitial: true })
    this.watcher.on('add', (p) => this.onDiskEvent('add', p))
    this.watcher.on('change', (p) => this.onDiskEvent('change', p))
    this.watcher.on('unlink', (p) => this.onDiskEvent('unlink', p))
    await new Promise<void>((resolve) => this.watcher!.once('ready', resolve))

    await this.refresh()
  }

  /** Working copies stay on disk — persisted bases make the next activate
   * reconcile any divergence instead of clobbering. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.pendingLifecycle.values()) clearTimeout(timer)
    this.pendingLifecycle.clear()
    await this.watcher?.close()
    for (const entry of [...this.entries.values()]) await this.closeEntry(entry, { removeFromDisk: false })
    this.socket?.destroy()
  }

  /** Reconcile against server truth: open/close/move entries per listDocs,
   * then adopt unknown disk files. Runs at start and on SSE reconnect. */
  async refresh(): Promise<void> {
    const docs = await this.deps.api.listDocs()
    const seen = new Set<string>()
    for (const meta of docs) {
      seen.add(meta.id)
      const existing = this.entries.get(meta.id)
      if (!existing) void this.openEntry(meta)
      else if (existing.rel !== meta.path) await this.applyRename(existing, meta.path)
    }
    for (const entry of [...this.entries.values()]) {
      if (!seen.has(entry.docId)) await this.closeEntry(entry, { removeFromDisk: true })
    }
    await this.adoptUnknownFiles()
  }

  docIdForPath(rel: string): string | null {
    return this.byPath.get(rel)?.docId ?? null
  }

  pathForDocId(docId: string): string | null {
    return this.entries.get(docId)?.rel ?? null
  }

  /** Every doc the mirror knows about (server truth + adopted files). */
  knownPaths(): string[] {
    return [...this.byPath.keys()]
  }

  /** Started entries only — a bridge that hasn't synced yet can't take signals. */
  bridgeForPath(rel: string): DocBridge | null {
    const entry = this.byPath.get(rel)
    return entry?.started ? entry.bridge : null
  }

  /** The Stop hook carries no path, so end every open turn. The watcher-idle
   * fallback still closes turns the hook never signals. */
  endOpenTurns(): void {
    for (const entry of this.entries.values()) {
      if (entry.started) entry.bridge.signalTurnEnd()
    }
  }

  handleDocsEvent(event: DocsEvent): void {
    void this.applyDocsEvent(event).catch((err) => this.log(`docs event failed: ${err}`))
  }

  private async applyDocsEvent(event: DocsEvent): Promise<void> {
    if (this.stopped) return
    const existing = this.entries.get(event.doc.id)
    if (event.type === 'created' && !existing) await this.openEntry(event.doc)
    else if (event.type === 'renamed' && existing) await this.applyRename(existing, event.doc.path)
    else if (event.type === 'deleted' && existing) await this.closeEntry(existing, { removeFromDisk: true })
  }

  private async openEntry(meta: DocMeta, seedText?: string): Promise<void> {
    if (this.entries.has(meta.id)) return
    let rel: VaultRelPath
    try {
      rel = vaultRelPath(meta.path)
    } catch (err) {
      this.log(`unsafe doc path skipped: ${meta.path} (${err})`)
      return
    }
    const doc = new Y.Doc()
    let resolveSynced!: () => void
    const synced = new Promise<void>((r) => (resolveSynced = r))
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket!,
      name: meta.id,
      document: doc,
      token: this.deps.token,
      onSynced: () => resolveSynced(),
    })
    const entry: DocEntry = { docId: meta.id, rel, doc, provider, bridge: null as unknown as DocBridge, started: false }
    entry.bridge = new DocBridge({
      doc,
      readFile: () => readFile(absPathFor(this.deps.workRoot, entry.rel), 'utf8').catch(() => null),
      writeFile: async (text) => {
        await writeAtomic(this.deps.workRoot, entry.rel, text)
        this.deps.onMaterialize?.(entry.rel)
      },
      loadBase: () => this.bases.load(entry.docId),
      saveBase: (b) => this.bases.save(entry.docId, b),
      onTurnState: (active) => this.onTurnState(entry, active),
      turnIdleMs: this.deps.turnIdleMs,
    })
    this.entries.set(meta.id, entry)
    this.byPath.set(rel, entry)
    await synced
    if (this.stopped || this.entries.get(meta.id) !== entry) return
    if (seedText !== undefined) {
      doc.transact(() => doc.getText(YDOC_TEXT_KEY).insert(0, seedText), BRIDGE_ORIGIN)
    }
    await entry.bridge.start()
    entry.started = true
  }

  private async closeEntry(entry: DocEntry, opts: { removeFromDisk: boolean }): Promise<void> {
    this.entries.delete(entry.docId)
    this.byPath.delete(entry.rel)
    if (this.activeTurns.delete(entry.docId)) this.deps.onTurnActivity?.(this.activeTurns.size)
    await entry.bridge.stop()
    entry.provider.destroy()
    entry.doc.destroy()
    if (opts.removeFromDisk) await removeDocFile(this.deps.workRoot, entry.rel).catch(() => {})
    await this.bases.remove(entry.docId)
  }

  private async applyRename(entry: DocEntry, newPathRaw: string): Promise<void> {
    let newRel: VaultRelPath
    try {
      newRel = vaultRelPath(newPathRaw)
    } catch (err) {
      this.log(`unsafe rename target skipped: ${newPathRaw} (${err})`)
      return
    }
    if (newRel === entry.rel) return
    this.byPath.delete(entry.rel)
    const oldRel = entry.rel
    entry.rel = newRel // bridge deps close over entry.rel — rebind is automatic
    this.byPath.set(newRel, entry)
    await moveDocFile(this.deps.workRoot, oldRel, newRel).catch(async () => {
      // file wasn't there (e.g. never materialized) — write current doc text
      await writeAtomic(this.deps.workRoot, newRel, entry.doc.getText(YDOC_TEXT_KEY).toString())
    })
  }

  private onTurnState(entry: DocEntry, active: boolean): void {
    entry.provider.setAwarenessField('agentEditing', active ? true : null)
    const changed = active ? !this.activeTurns.has(entry.docId) : this.activeTurns.delete(entry.docId)
    if (active) this.activeTurns.add(entry.docId)
    if (changed) this.deps.onTurnActivity?.(this.activeTurns.size)
    if (active) {
      void this.deps.api
        .takeSnapshot(entry.docId, 'before Claude edited')
        .catch((err) => this.log(`pre-agent-write snapshot failed for ${entry.rel}: ${err}`))
    }
  }

  private onDiskEvent(kind: 'add' | 'change' | 'unlink', absPath: string): void {
    if (this.stopped) return
    const rel = toVaultRel(this.deps.workRoot, absPath)
    if (!rel || isIgnoredPath(rel)) return

    // Task files are not docs. Hand them to the projector and stop — no entry
    // lookup, no bridge, no adoption, no delete propagation. (Same shape as the
    // isLocalOnlyPath exclusion, on a different axis: local-only files are not
    // vault content at all, task files are vault content that is not a CRDT doc.)
    if (isTaskFilePath(rel)) {
      this.deps.onTaskFileEvent?.(kind, rel)
      return
    }

    const entry = this.byPath.get(rel)
    if (kind === 'unlink') {
      if (!entry) {
        const pending = this.pendingLifecycle.get(rel)
        if (pending) clearTimeout(pending) // create raced a delete — drop it
        this.pendingLifecycle.delete(rel)
        return
      }
      // Freeze disk writes NOW, synchronously: a remote update landing before the
      // debounced propagateDelete would re-materialize the file we are about to
      // delete, and propagateDelete would then see it back and bail.
      entry.bridge.suspend()
      this.scheduleLifecycle(rel, () => this.propagateDelete(entry))
    } else {
      if (entry) {
        if (entry.started) void entry.bridge.onFileEvent()
      } else {
        this.scheduleLifecycle(rel, () => this.adoptFile(rel))
      }
    }
  }

  private scheduleLifecycle(rel: string, action: () => Promise<void>): void {
    const pending = this.pendingLifecycle.get(rel)
    if (pending) clearTimeout(pending)
    this.pendingLifecycle.set(
      rel,
      setTimeout(() => {
        this.pendingLifecycle.delete(rel)
        void action().catch((err) => this.log(`lifecycle failed for ${rel}: ${err}`))
      }, this.lifecycleDebounceMs),
    )
  }

  /** Agent rm → doc delete (git-ingress symmetry). On failure the file simply
   * re-materializes from server truth on the next refresh — logged, accepted. */
  private async propagateDelete(entry: DocEntry): Promise<void> {
    const onDisk = await readFile(absPathFor(this.deps.workRoot, entry.rel), 'utf8').catch(() => null)
    if (onDisk !== null) {
      entry.bridge.resume() // file came back (rename/rewrite) — not a delete
      return
    }
    if (this.entries.get(entry.docId) !== entry) return // already closed by a docs event
    await this.closeEntry(entry, { removeFromDisk: false })
    await this.deps.api.deleteNote(entry.docId)
  }

  /** Agent-created file → notes.create + seed the fresh doc with its content. */
  private async adoptFile(rel: VaultRelPath): Promise<void> {
    if (this.stopped || this.byPath.has(rel)) return
    const text = await readFile(absPathFor(this.deps.workRoot, rel), 'utf8').catch(() => null)
    if (text === null) return // vanished again
    if (text.includes('\0')) {
      this.log(`binary content skipped (not adopted): ${rel}`)
      return
    }
    const meta = await this.deps.api.createNote(rel)
    await this.openEntry(meta, text)
  }

  private async adoptUnknownFiles(): Promise<void> {
    for (const rel of await listFiles(this.deps.workRoot)) {
      // task files are the projector's, never adopted as docs
      if (isTaskFilePath(rel)) continue
      if (isIgnoredPath(rel) || this.byPath.has(rel) || this.pendingLifecycle.has(rel)) continue
      let safe: VaultRelPath
      try {
        safe = vaultRelPath(rel)
      } catch {
        continue
      }
      await this.adoptFile(safe).catch((err) => this.log(`adopt failed for ${rel}: ${err}`))
    }
  }
}
