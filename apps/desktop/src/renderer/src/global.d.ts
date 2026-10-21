import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../main/vault/active-vault'
import type { HeldBackFile } from '../../main/vault/large-files'
import type { PluginEvent } from '../../main/plugin-host/events'
import type { UpdateStatus } from '../../main/updates/state'
import type { SkillsUpdated } from '../../main/capabilities/vault-caps'
import type { TrpcEnvelope, TrpcOpWire } from './lib/ipc-link'

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
        /** What the skills update the vault ran on open changed. */
        onSkillsUpdated(cb: (notice: SkillsUpdated & { remote: string }) => void): () => void
        /**
         * Main is quitting and wants the buffer on disk before it commits.
         * Write every dirty buffer, then call `flushDone()`.
         *
         * The only push that expects a reply. Main waits one second and then
         * quits regardless.
         */
        onFlushRequest(cb: () => void): () => void
        flushDone(): void
        /** Main asks for a vault path in a tab: a clicked reminder's task,
         *  `holi docs open`, a Holi link (with a heading to scroll to). Fans to
         *  a vault switch (if the path lives elsewhere) + `openPathAtom`.
         *  `focus: false` (`holi docs screenshot`) leaves the caret where it
         *  is. Returns its unsubscribe. */
        onOpen(
          cb: (payload: {
            remote: string
            path: string
            heading?: string
            focus?: boolean
          }) => void,
        ): () => void
        /** This window has landed its vault: main may send the opens it held. */
        openReady(): void
        /** Main asks where a path's tab is drawn, for `holi docs screenshot`,
         *  once it has settled. Answer with `located`, by the same id: the
         *  tab's rect in CSS pixels, or why there is none. */
        onLocate(cb: (request: { id: string; path: string }) => void): () => void
        located(
          answer:
            | { id: string; rect: { x: number; y: number; width: number; height: number } }
            | { id: string; error: string },
        ): void
      }
      /** Plugin events (docs/architecture.md, Plugins). Main sends on
       *  `plugin:<id>` only for a vault that runs the plugin; the renderer's
       *  messages are dropped unless they are about the open vault. */
      plugin: {
        /** Returns its unsubscribe. */
        on(id: string, cb: (event: PluginEvent) => void): () => void
        /** Ordered and fire-and-forget: a terminal's keystrokes ride it. */
        send(id: string, event: PluginEvent): void
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
      /** Updating Holi itself: the updater's status, whole, on every change.
       *  Returns its unsubscribe. */
      updates: {
        onStatus(cb: (status: UpdateStatus) => void): () => void
      }
      /** A plugin's own window (`main/page-windows.ts`), such as the agent's
       *  quick panel: what main tells this page, and what it answers. Main
       *  hears a message only from the window it opened. Present in every
       *  window; only a page window is ever told anything. */
      page: {
        /** Returns its unsubscribe. */
        on(cb: (event: { name: string; payload: unknown }) => void): () => void
        send(name: string, payload: unknown): void
      }
      openExternal(url: string): Promise<void>
      /** Reveal a local path — a vault's clone folder — in the system file
       *  manager (Finder on macOS), selected in its parent. */
      openPath(path: string): Promise<void>
      /** The absolute path of a `File` the user dropped on the window. */
      pathForFile(file: File): string
      /** Hand these absolute paths to the OS as a native file drag. */
      startDrag(paths: string[]): void
      /** Native "save as" for something made from the vault file `path`.
       *  Presents a save sheet beside it, named after it with `extension`
       *  (Downloads when `path` is not in the vault); resolves to the chosen
       *  absolute path, or null if the user cancelled. */
      showSaveDialog(input: {
        remote: string
        path: string
        extension: string
        filterName: string
      }): Promise<string | null>
      /** Pick a folder on disk: the destination for Copy/Move to Folder…. */
      chooseFolder(): Promise<string | null>
    }
  }
}

export {}
