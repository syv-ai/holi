/**
 * Full-vault live mirror (spec §VaultMirror): a Y.Doc + Hocuspocus provider
 * per doc over ONE multiplexed WebSocket; CRDT→disk via DocBridge; doc-list
 * truth from the server (listDocs + SSE docs events + reconcile on reconnect);
 * agent-created/deleted files propagate with git-ingress symmetry.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { watch, type FSWatcher } from 'chokidar'
import WebSocket from 'ws'
import * as Y from 'yjs'
import {
  BRIDGE_ORIGIN,
  YDOC_TEXT_KEY,
  YjsLink,
  isTaskFilePath,
  vaultRelPath,
  type DocMeta,
  type SyncStatus,
  type VaultRelPath,
  type YjsLinkTransport,
} from '@holi/shared'
import { BaseStore } from './base-store'
import { DocBridge } from './doc-bridge'
import { DocListStore, DocStore } from './doc-store'
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
  /** Where persisted Yjs state lives (D59) — NOT `baseDir`, which holds merge bases. */
  docStateDir: string
  relayUrl: string
  token: string
  api: MirrorApi
  turnIdleMs?: number
  lifecycleDebounceMs?: number
  /** How long a doc may hold an unpersisted edit. Defaults to 400ms; tests drive it fast. */
  persistDebounceMs?: number
  /** Backstop cadence for the periodic disk reconcile that recovers dropped
   * fsevents events (spec: chokidar events are a latency optimization, not
   * correctness). Defaults to 10s; tests drive it fast. */
  reconcileIntervalMs?: number
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
  /** Relay connectivity for one doc (D59). The renderer no longer talks to the relay, so
   * it can no longer see this for itself — main is the only thing that knows, and the
   * sync indicator is only honest if this reaches it. */
  onDocStatus?(docId: string, status: SyncStatus): void
}

interface DocEntry {
  docId: string
  rel: VaultRelPath
  doc: Y.Doc
  provider: HocuspocusProvider
  bridge: DocBridge
  started: boolean
  /** Last relay status pushed for this doc — replayed to a renderer that links after the
   * fact, since the provider only fires these on transition. */
  status: SyncStatus
  /** Pending debounced persist (D59). */
  saveTimer: ReturnType<typeof setTimeout> | null
}

export class VaultMirror {
  private readonly entries = new Map<string, DocEntry>() // by docId
  private readonly byPath = new Map<string, DocEntry>() // by rel
  private readonly activeTurns = new Set<string>() // docIds mid-turn
  private readonly pendingLifecycle = new Map<string, ReturnType<typeof setTimeout>>() // by rel
  private readonly bases: BaseStore
  /** Persisted Yjs state — what makes an offline edit survive a quit (D59). Distinct from
   * `bases`, which holds the frozen merge base and is discarded on close. */
  private readonly docs: DocStore
  /** The vault's doc list, cached so activation survives an unreachable server (D59). */
  private readonly docList: DocListStore
  private socket: HocuspocusProviderWebsocket | null = null
  private watcher: FSWatcher | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly lifecycleDebounceMs: number
  private readonly reconcileIntervalMs: number
  private readonly persistDebounceMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly deps: VaultMirrorDeps) {
    this.bases = new BaseStore(deps.baseDir)
    this.docs = new DocStore(deps.docStateDir)
    this.docList = new DocListStore(join(deps.docStateDir, 'doc-list.json'))
    this.lifecycleDebounceMs = deps.lifecycleDebounceMs ?? 400
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 10_000
    this.persistDebounceMs = deps.persistDebounceMs ?? 400
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

    // Chokidar events are a latency optimization, not correctness. Under
    // cross-process fsevents contention the macOS backend silently drops an
    // `add`/`unlink` (measured: the raw event never fires), which would strand an
    // agent-created file unsynced or leave an agent-deleted doc alive until the
    // next SSE reconnect. This backstop re-reconciles disk↔doc on a timer so a
    // missed event self-heals — the same stance the git ingester takes toward a
    // missed webhook (spec §vault-git-mirror, "webhooks are latency optimization").
    this.reconcileTimer = setInterval(() => {
      void this.reconcileFromDisk().catch((err) => this.log(`periodic reconcile failed: ${err}`))
    }, this.reconcileIntervalMs)
    this.reconcileTimer.unref?.() // never keep the process (or a test) alive for it
  }

  /** Working copies stay on disk — persisted bases make the next activate
   * reconcile any divergence instead of clobbering. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    for (const timer of this.pendingLifecycle.values()) clearTimeout(timer)
    this.pendingLifecycle.clear()
    await this.watcher?.close()
    for (const entry of [...this.entries.values()]) await this.closeEntry(entry, { removeFromDisk: false })
    this.socket?.destroy()
  }

  /**
   * Reconcile against server truth: open/close/move entries per listDocs, then adopt
   * unknown disk files. Runs at start and on SSE reconnect.
   *
   * Offline it falls back to the cached doc list (D59) — without which `listDocs` threw
   * and vault activation failed outright, so there was no offline at all. **The fallback
   * opens docs and stops there.** The close-what-is-missing half below deletes working
   * copies, and a cached list is not evidence that anything was deleted; running it from
   * the cache would destroy the user's notes on every offline launch.
   */
  async refresh(): Promise<void> {
    let docs: DocMeta[]
    let authoritative = true
    try {
      docs = await this.deps.api.listDocs()
      await this.docList.save(docs).catch((err) => this.log(`doc-list cache write failed: ${err}`))
    } catch (err) {
      const cached = await this.docList.load()
      // No server AND no cache: nothing to open, and no basis to guess. Fail as before —
      // a first-ever launch offline genuinely cannot materialize a vault.
      if (!cached) throw err
      this.log(`listDocs failed — opening ${cached.length} docs from cache: ${err}`)
      docs = cached
      authoritative = false
    }
    const seen = new Set<string>()
    for (const meta of docs) {
      seen.add(meta.id)
      const existing = this.entries.get(meta.id)
      if (!existing) void this.openEntry(meta)
      else if (existing.rel !== meta.path) await this.applyRename(existing, meta.path)
    }
    // Everything past here needs the network: closing keyed on server truth we do not
    // have, and adoption calling createNote.
    if (!authoritative) return
    for (const entry of [...this.entries.values()]) {
      if (!seen.has(entry.docId)) await this.closeEntry(entry, { removeFromDisk: true, docDeleted: true })
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

  /**
   * Bind a renderer to a doc this mirror already holds (D59) — the seam that makes main
   * the machine's sync hub. The renderer's edits enter `entry.doc` like any other update,
   * so they reach disk through the DocBridge and the relay through the provider, both
   * already wired. Nothing new has to know about the renderer.
   *
   * **Deliberately not gated on `started`** (unlike `bridgeForPath` above): an entry is
   * registered before `await synced` (see `openEntry`), and the renderer's editor has
   * always opened against an unsynced doc and filled in as updates land. Waiting here
   * would leave the editor blank whenever the relay is slow — and, come slice 2, whenever
   * it is absent, which is the whole point of the change.
   *
   * Returns null for a doc this mirror has no entry for — an unsafe path it skipped, or a
   * docId from another vault. The caller must surface that rather than hand back an empty
   * doc the user can type into and lose.
   */
  linkRenderer(docId: string, transport: YjsLinkTransport): { link: YjsLink; status: SyncStatus } | null {
    const entry = this.entries.get(docId)
    if (!entry) return null
    return {
      link: new YjsLink(entry.doc, entry.provider.awareness ?? null, transport),
      status: entry.status,
    }
  }

  private setDocStatus(docId: string, status: SyncStatus): void {
    const entry = this.entries.get(docId)
    if (entry) entry.status = status
    this.deps.onDocStatus?.(docId, status)
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
    else if (event.type === 'deleted' && existing) await this.closeEntry(existing, { removeFromDisk: true, docDeleted: true })
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
      onSynced: () => {
        resolveSynced()
        this.setDocStatus(meta.id, 'synced')
      },
      // The renderer used to read these off its own provider (collab/provider.ts). It has
      // no provider now, so main reports them — mapped identically, or the indicator's
      // meaning drifts from what shipped.
      onDisconnect: () => this.setDocStatus(meta.id, 'offline'),
      onStatus: ({ status }) => {
        if (status === 'connecting') this.setDocStatus(meta.id, 'syncing')
      },
    })
    const entry: DocEntry = {
      docId: meta.id,
      rel,
      doc,
      provider,
      bridge: null as unknown as DocBridge,
      started: false,
      status: 'syncing',
      saveTimer: null,
    }
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
    // Registered synchronously, before the first await — the invariant this method has
    // always held (an `add` for a file we materialized must find its entry and read as an
    // echo, never get adopted as a new doc). Loading persisted state above this line
    // would put an fs read in front of it and let `adoptUnknownFiles` race in and create
    // a duplicate.
    this.entries.set(meta.id, entry)
    this.byPath.set(rel, entry)
    doc.on('update', () => this.schedulePersist(entry))

    // Local state (D59). Applied after the provider exists, which is harmless — a CRDT
    // does not care what order the two arrive in — but it MUST land before the bridge
    // starts, because that is what decides whether there is anything to materialize.
    const persisted = await this.docs.load(meta.id).catch(() => null)
    if (this.stopped || this.entries.get(meta.id) !== entry) return
    if (persisted) {
      try {
        Y.applyUpdate(doc, persisted)
      } catch (err) {
        // A corrupt cache must degrade to "sync from the relay", never take the vault down.
        this.log(`ignoring unreadable local state for ${meta.path}: ${err}`)
      }
    }

    if (seedText !== undefined) {
      doc.transact(() => doc.getText(YDOC_TEXT_KEY).insert(0, seedText), BRIDGE_ORIGIN)
    }

    // The relay gate, now conditional — and the condition is the whole trick (D59).
    //
    // This used to `await synced` unconditionally, which resolves only from the
    // provider's onSynced: offline, no entry ever started, no bridge ever ran, and
    // nothing was ever materialized. But the gate was also load-bearing for
    // *correctness*, which is not obvious and cost a real bug to learn: DocBridge's
    // start() treats "no persisted base" as **server truth wins** and materializes the
    // doc straight over the working copy. Dropping the gate outright meant it did that
    // with an EMPTY doc — clobbering the file with '', then taking the relay's content
    // as a foreign write, opening a spurious turn, and firing a bogus "before Claude
    // edited" snapshot on every doc at every vault open. (Caught by the awareness
    // assertion in vault-mirror.test.ts: one turn, and its marker never observed.)
    //
    // So: a doc we have local state for starts NOW — it has real content to materialize
    // and real edits to keep, which is the entire point of offline. A doc we have
    // nothing for waits exactly as it always did. That costs nothing offline (a doc
    // with no local state has nothing to show anyway) and keeps "server truth wins"
    // true whenever it is the only truth there is.
    if (!persisted) {
      await synced
      if (this.stopped || this.entries.get(meta.id) !== entry) return
    }
    await entry.bridge.start()
    entry.started = true
  }

  /**
   * @param docDeleted the DOC is gone, not just this entry — forget its local state.
   *   Distinct from `removeFromDisk`, and the two genuinely diverge: `propagateDelete`
   *   deletes the doc when its file is *already* off disk, while `stop()` removes neither
   *   (a vault switch must not throw away an offline edit — that is the whole point).
   */
  private async closeEntry(
    entry: DocEntry,
    opts: { removeFromDisk: boolean; docDeleted?: boolean },
  ): Promise<void> {
    this.entries.delete(entry.docId)
    this.byPath.delete(entry.rel)
    if (this.activeTurns.delete(entry.docId)) this.deps.onTurnActivity?.(this.activeTurns.size)
    if (entry.saveTimer) clearTimeout(entry.saveTimer)
    entry.saveTimer = null
    // Persist before the doc goes, unless it is being deleted outright — an entry can
    // close with edits the debounce never got to (a vault switch, a quit).
    if (!opts.docDeleted) await this.persist(entry)
    await entry.bridge.stop()
    entry.provider.destroy()
    entry.doc.destroy()
    if (opts.removeFromDisk) await removeDocFile(this.deps.workRoot, entry.rel).catch(() => {})
    await this.bases.remove(entry.docId)
    if (opts.docDeleted) await this.docs.remove(entry.docId).catch(() => {})
  }

  /**
   * Trailing-edge debounce: at most one write per window, and the window is not extended
   * by further edits — a doc being typed into continuously must still reach disk.
   *
   * **Never mid-turn.** During a turn the doc is a transient merge-in-progress against a
   * frozen base, and a crash there already recovers through `BaseStore` — so a write here
   * buys nothing. It also costs: the fs work measurably perturbs awareness delivery to
   * remote peers, and a turn is exactly when presence matters ("Claude is editing…").
   * `onTurnState(false)` schedules the write the turn deferred.
   */
  private schedulePersist(entry: DocEntry): void {
    if (entry.saveTimer || this.stopped || this.activeTurns.has(entry.docId)) return
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      void this.persist(entry)
    }, this.persistDebounceMs)
    entry.saveTimer.unref?.()
  }

  private async persist(entry: DocEntry): Promise<void> {
    await this.docs
      .save(entry.docId, Y.encodeStateAsUpdate(entry.doc))
      .catch((err) => this.log(`persist failed for ${entry.rel}: ${err}`))
  }

  /**
   * Write every doc's state now, debounce or no debounce (D59).
   *
   * `before-quit` does not await teardown, so a debounced save is exactly the edit the
   * user just made — the one this whole change exists to keep. Callable independently of
   * `stop()` so quit can flush without racing a full mirror teardown.
   */
  async flushPersist(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) => {
        if (entry.saveTimer) clearTimeout(entry.saveTimer)
        entry.saveTimer = null
        return this.persist(entry)
      }),
    )
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
    } else {
      // The turn deferred every persist it saw (schedulePersist skips mid-turn); its
      // merged result is the state worth keeping, so take it now.
      this.schedulePersist(entry)
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
    // The file is already off disk, but the DOC is going too — forget its local state or
    // the next vault open would resurrect a deleted note from the cache.
    await this.closeEntry(entry, { removeFromDisk: false, docDeleted: true })
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

  /** The dropped-event backstop (see the setInterval in start()). Two halves,
   * mirroring the two events fsevents can drop:
   *
   * - dropped `add`: a file sits on disk that no entry knows about → adopt it,
   *   exactly as a real `add` would have (idempotent: skips known/pending paths).
   * - dropped `unlink`: a started, materialized doc whose file is gone from disk.
   *   `refresh()` cannot recover this — server truth still lists the doc, so a
   *   refresh would re-materialize it (resurrecting a delete the agent meant). We
   *   route it through the same suspend → debounced `propagateDelete` the real
   *   `unlink` uses, whose re-read guard resumes the bridge if the file comes back
   *   (a rename/rewrite, not a delete). Skips paths already mid-lifecycle so a
   *   real event in flight wins the race. */
  private async reconcileFromDisk(): Promise<void> {
    if (this.stopped) return
    await this.adoptUnknownFiles()
    for (const entry of [...this.entries.values()]) {
      if (!entry.started || this.pendingLifecycle.has(entry.rel)) continue
      const onDisk = await readFile(absPathFor(this.deps.workRoot, entry.rel), 'utf8').catch(() => null)
      if (onDisk === null) {
        entry.bridge.suspend()
        this.scheduleLifecycle(entry.rel, () => this.propagateDelete(entry))
      }
    }
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
