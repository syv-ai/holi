import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../main/vault/active-vault'
import type { HeldBackFile } from '../../main/vault/large-files'
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'
import type { AgentSession } from './state/agent'

declare global {
  interface Window {
    /**
     * The one seam. Most of what used to hang off here — `collab.*`,
     * `docs.onEvent`, `tasks.onEvent`/`onPresence`, `vaults.onEvent`,
     * `stream.onResync`, `reminders.onOpen`, `auth.*` — is gone: those rode an
     * SSE connection to a server that no longer exists, and auth moved into the
     * tRPC router when GitHub became identity. `agent.*` is back, but as a PTY
     * byte stream rather than the old MCP op surface (see below).
     */
    holi: {
      trpc(op: TrpcOpWire): Promise<TrpcEnvelope>
      vault: {
        /** Each returns its unsubscribe closure. */
        onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void
        onSyncState(cb: (state: SyncState) => void): () => void
        /** The large-file gate's held-back set; empty clears the callout. */
        onHeldBack(cb: (files: HeldBackFile[]) => void): () => void
        /**
         * Main is quitting and wants the buffer on disk before it commits.
         * Write every dirty buffer, then call `flushDone()`.
         *
         * The only question main asks the renderer, and the only push that
         * expects a reply. Main waits one second and then quits regardless, so
         * a slow answer costs the newest words, not the quit.
         */
        onFlushRequest(cb: () => void): () => void
        flushDone(): void
      }
      /** A fired reminder's notification was clicked. Fans to a vault switch
       *  (if the task lives elsewhere) + `openTaskAtom`. Back as a local push
       *  channel, not the old SSE surface. Returns its unsubscribe. */
      reminders: {
        onOpen(cb: (payload: { remote: string; path: string }) => void): () => void
      }
      /** The agent ran `holi app open <id>`. Nothing else opens an app tab by
       *  itself: apps sync, so opening on *appearance* would put a teammate in
       *  charge of your screen. Returns its unsubscribe. */
      apps: {
        onOpen(cb: (appId: string) => void): () => void
      }
      /** The Developer menu, dev builds only — main installs no such menu in a
       *  packaged app, so nothing here ever fires there. Returns its
       *  unsubscribe. */
      dev: {
        onTestOnboarding(cb: () => void): () => void
      }
      /** The application menu ran an item: the id of a row in the command
       *  table (`state/commands.ts`). ⌘W is a menu accelerator, which fires
       *  before any keydown reaches the page, so Close Tab arrives here rather
       *  than as a key. Returns its unsubscribe. */
      menu: {
        onCommand(cb: (id: string) => void): () => void
      }
      openExternal(url: string): Promise<void>
      /** Reveal a local path — a vault's clone folder — in the system file
       *  manager (Finder on macOS), selected in its parent. */
      openPath(path: string): Promise<void>
      /** The absolute path of a `File` the user dropped on the window. */
      pathForFile(file: File): string
      /** Hand these absolute paths to the OS as a native file drag. */
      startDrag(paths: string[]): void
      /** Native "save as" for the Convert-to-PDF output. Presents a save sheet
       *  defaulting to `defaultName` under Downloads; resolves to the chosen
       *  absolute path, or null if the user cancelled. */
      showSaveDialog(defaultName: string): Promise<string | null>
      /** Pick a folder on disk — the destination for Copy/Move to Folder… (FR-13). */
      chooseFolder(): Promise<string | null>
      /**
       * The vault agent — the vault's live Claude Code sessions, an ordinary
       * tab each (D100, D101). A byte stream, not tRPC: PTY output and the session list
       * are pushed (`onData`/`onExit`/`onSessions`, each returning its
       * unsubscribe), keystrokes/resize/focus are fire-and-forget, and
       * start/kill/attach/sessions are request/response.
       *
       * **Every route but `setFocus` names a session.** A vault runs several, so
       * "write to the agent" is not an address. Focus is the exception because
       * the focus file is the vault's, one path in the clone, read by whichever
       * session takes the next turn.
       */
      agent: {
        onData(cb: (e: { id: string; data: Uint8Array | string }) => void): () => void
        onExit(cb: (e: { id: string; code: number }) => void): () => void
        /** The whole list, whenever any derived field changes. */
        onSessions(cb: (sessions: AgentSession[]) => void): () => void
        sessions(): Promise<AgentSession[]>
        /** Replayable terminal state for one session, and open its data tap. */
        attach(id: string): Promise<string>
        start(args: {
          vaultId: string
          /** Claude Code's own `--name`, so the tab is named from the moment it
           *  exists. Normalised in main: first line, collapsed, capped. */
          name?: string
          resume?: boolean
          /** Spawn the PTY at this geometry — the last size a visible terminal
           *  fitted to — so Claude's TUI fills the pane from the first paint. */
          cols?: number
          rows?: number
          /** Seed the interactive session's first turn (the reconcile flow). */
          prompt?: string
          /** Put this in its input box, unsent, once it is up. Main holds it
           *  until Claude Code's TUI is reading; written at spawn it would go
           *  nowhere. */
          paste?: string
        }): Promise<{ ok: boolean; id?: string; message?: string }>
        /** Put text in a live session's input box, unsent. Refused if that
         *  session ended between picking it and sending. */
        paste(id: string, text: string): Promise<{ ok: boolean; message?: string }>
        /** Fork this session's conversation into a new one (`--fork-session`).
         *  Main resolves Claude Code's own session id; the renderer never holds
         *  one. Refused when the listing cannot say what to fork. */
        duplicate(id: string): Promise<{ ok: boolean; id?: string; message?: string }>
        /** End this session and start a new one under its name, at this
         *  geometry. Main decides which names are real; a placeholder is not
         *  carried over. */
        restart(
          id: string,
          geometry?: { cols?: number; rows?: number },
        ): Promise<{ ok: boolean; id?: string; message?: string }>
        /** End one session and drop it from the list. */
        kill(id: string): Promise<{ ok: true }>
        write(id: string, data: string): void
        resize(id: string, cols: number, rows: number): void
        setFocus(focus: { focusedPath: string | null; openPaths: string[] }): void
      }
    }
  }
}

export {}
