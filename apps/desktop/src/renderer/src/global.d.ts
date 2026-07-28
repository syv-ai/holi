import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../main/vault/active-vault'
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'
import type { AgentStatus } from './state/agent'

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
      openExternal(url: string): Promise<void>
      /** Reveal a local path — a vault's clone folder — in the system file
       *  manager (Finder on macOS), selected in its parent. */
      openPath(path: string): Promise<void>
      /** Native "save as" for the Convert-to-PDF output. Presents a save sheet
       *  defaulting to `defaultName` under Downloads; resolves to the chosen
       *  absolute path, or null if the user cancelled. */
      showSaveDialog(defaultName: string): Promise<string | null>
      /**
       * The vault agent — a live Claude Code session in the drawer. A byte
       * stream, not tRPC: PTY output and status are pushed (`onData`/`onExit`/
       * `onStatus`, each returning its unsubscribe), keystrokes/resize/focus are
       * fire-and-forget, and start/kill/attach/status are request/response.
       */
      agent: {
        onData(cb: (data: Uint8Array | string) => void): () => void
        onExit(cb: (e: { code: number }) => void): () => void
        onStatus(cb: (status: AgentStatus) => void): () => void
        attach(): Promise<string>
        status(): Promise<AgentStatus>
        start(args: {
          vaultId: string
          resume?: boolean
          /** Spawn the PTY at this geometry — the drawer's fitted size — so
           *  Claude's TUI fills the pane from the first paint. */
          cols?: number
          rows?: number
          /** Seed the interactive session's first turn (the reconcile flow). */
          prompt?: string
        }): Promise<{ ok: boolean; message?: string }>
        kill(): Promise<{ ok: true }>
        write(data: string): void
        resize(cols: number, rows: number): void
        setFocus(focus: { focusedPath: string | null; openPaths: string[] }): void
      }
    }
  }
}

export {}
