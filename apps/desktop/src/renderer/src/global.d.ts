import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../main/vault/active-vault'
import type { HeldBackFile } from '../../main/vault/large-files'
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'
import type { AgentSession, AgentTerminal } from './state/agent'

type AgentActionResult = { ok: true } | { ok: false; message: string }
type AgentOpenResult = { ok: true; terminalId: string } | { ok: false; message: string }
type AgentStartResult =
  { ok: true; sessionId: string; terminalId: string } | { ok: false; message: string }
/** Mirrors `SkillsUpdate` in main/vault/seed/update.ts; the report stays in main. */
type SkillsUpdateResult =
  { ok: true; summary: string; terminalId?: string } | { ok: false; message: string }

declare global {
  interface Window {
    /** The one preload seam: tRPC plus the pushes and native calls it cannot
     *  carry. */
    holi: {
      trpc(op: TrpcOpWire): Promise<TrpcEnvelope>
      vault: {
        /** Each returns its unsubscribe closure. */
        onSnapshot(cb: (snapshot: VaultSnapshot) => void): () => void
        onSyncState(cb: (state: SyncState) => void): () => void
        /** The large-file gate's held-back set; empty clears the callout. */
        onHeldBack(cb: (files: HeldBackFile[]) => void): () => void
        /** The paths a commit took, or null when a merged pull may have
         *  moved any file's history. */
        onCommitted(cb: (paths: string[] | null) => void): () => void
        /**
         * Main is quitting and wants the buffer on disk before it commits.
         * Write every dirty buffer, then call `flushDone()`.
         *
         * The only push that expects a reply. Main waits one second and then
         * quits regardless.
         */
        onFlushRequest(cb: () => void): () => void
        flushDone(): void
      }
      /** A fired reminder's notification was clicked. Fans to a vault switch
       *  (if the task lives elsewhere) + `openTaskAtom`. Returns its
       *  unsubscribe. */
      reminders: {
        onOpen(cb: (payload: { remote: string; path: string }) => void): () => void
      }
      /** The agent ran `holi apps open <path>`. Nothing else opens an app tab by
       *  itself: apps sync, so opening on *appearance* would put a teammate in
       *  charge of your screen. Returns its unsubscribe. */
      apps: {
        onOpen(cb: (bundle: string) => void): () => void
      }
      /** The Developer menu, dev builds only. Returns its unsubscribe. */
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
      showSaveDialog(input: { remote: string; path: string }): Promise<string | null>
      /** Pick a folder on disk: the destination for Copy/Move to Folder…. */
      chooseFolder(): Promise<string | null>
      /**
       * The vault's assistant. **Sessions** are Claude Code's background
       * sessions, by job id; **terminals** are Holi's windows onto them, by
       * terminal id: `claude agents` (the list) or `claude attach <id>`. A byte
       * stream, not tRPC: output and both lists are pushed, keystrokes/resize/
       * focus are fire-and-forget, the rest request/response.
       */
      agent: {
        onData(cb: (e: { id: string; data: Uint8Array | string }) => void): () => void
        /** A terminal's client exited: its tab closes. */
        onExit(cb: (e: { id: string; code: number }) => void): () => void
        onSessions(cb: (sessions: AgentSession[]) => void): () => void
        onTerminals(cb: (terminals: AgentTerminal[]) => void): () => void
        sessions(): Promise<AgentSession[]>
        terminals(): Promise<AgentTerminal[]>
        /** A terminal on the list, or on one session with `attach`. */
        open(args: { attach?: string; cols?: number; rows?: number }): Promise<AgentOpenResult>
        /** A new background session and a terminal on it. A `prompt` is its
         *  first turn (reconcile); without one it waits for yours. */
        start(args: {
          name?: string
          prompt?: string
          cols?: number
          rows?: number
        }): Promise<AgentStartResult>
        /** Put text in a session's input, unsent: a live one by id, or `'new'`.
         *  Refused when that session ended between picking and sending. */
        send(args: {
          text: string
          target: string
          cols?: number
          rows?: number
        }): Promise<AgentOpenResult>
        stop(id: string): Promise<AgentActionResult>
        /** A fresh process for the same conversation (`claude respawn`). */
        respawn(id: string): Promise<AgentActionResult>
        /** A background copy of the conversation, and a terminal on it. */
        duplicate(
          id: string,
          geometry?: { cols?: number; rows?: number },
        ): Promise<AgentStartResult>
        /** Replayable state for one terminal, and open its data tap. */
        attach(terminalId: string): Promise<string>
        /** This release's skills and hooks, merged into the vault. Main
         *  shows the summary as a notification; a conflict's session opens. */
        updateSkills(): Promise<SkillsUpdateResult>
        /** Detach: ends the window, never the session. */
        close(terminalId: string): Promise<void>
        write(id: string, data: string): void
        resize(id: string, cols: number, rows: number): void
      }
    }
  }
}

export {}
