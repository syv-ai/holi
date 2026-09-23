/**
 * A vault PDF in a pane, through embedpdf's ready-made viewer (D103).
 *
 * This module is the one that imports embedpdf, so it is loaded lazily by
 * `PdfViewer` and the main chunk never pays for the viewer, its worker or the
 * 4.6 MB PDFium wasm. What it owns, beyond mounting the viewer:
 *
 * - **Bytes.** `files.read` brings the file over the IPC seam as a `Uint8Array`
 *   and it becomes a blob URL the viewer fetches same-origin. A renderer
 *   `fetch` of `holi-vault://` fails on CORS, and the reason the protocol stays
 *   that way is in `main/router.ts` above `files`.
 * - **Marks are saved into the file.** Every annotation event restarts a quiet
 *   timer; when it fires, the export plugin renders the whole document to bytes
 *   and `files.write` puts them back at the same path. The mtime the write
 *   returns is remembered so the snapshot tick it causes is not mistaken for a
 *   foreign edit.
 * - **The file on disk stays the truth.** A snapshot whose mtime is not ours is
 *   a re-export or a pull, and the bytes are fetched again; the viewer remounts
 *   on the new URL. Skipped while a save is pending, so the most that is ever at
 *   risk is one quiet second of marks.
 * - **Its keys reach it only from itself.** The commands plugin listens on
 *   `document` and would take `h`, the arrows or ⌘= from the file tree. The
 *   guard below is registered in a layout effect, which React runs before any
 *   child's effect, so it sits ahead of the plugin's listener and can
 *   `stopImmediatePropagation` a key the viewer would otherwise claim when the
 *   event did not start inside the viewer. A disabled command (print on ⌘P) is
 *   not claimed, so Holi's palette still opens.
 * - **Theme.** `pdfViewerTheme` speaks in `var(--token)` strings that cross the
 *   shadow boundary; a mode flip goes through `setTheme`, not a remount. The
 *   one colour the palette cannot reach, the white a page shows until it is
 *   painted, is overridden by a `<style>` put into the viewer's shadow root at
 *   init: a sibling of Preact's render, like the viewer's own theme style, so a
 *   re-render leaves it alone.
 * - **It arrives once, whole.** Opening, the viewer shows "Initializing PDF
 *   engine…" and "Initializing plugins…" over a spinner, then its toolbar, then
 *   its pages, spread over some 300 ms and none of it configurable. So it is
 *   laid out invisible and fades in (D98's arrive) when the first page image
 *   loads. A timer reveals it anyway, so a broken file's error or a password
 *   prompt is never left invisible.
 * - **It opens at 150%, or fit-width if that is narrower** (`openingZoomCap`).
 *   The viewer opens at fit-width and the first zoom each document gets is
 *   capped; both happen before the first page paints, so there is no visible
 *   second resize.
 */
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  PDFViewer,
  ZoomMode,
  type PDFViewerRef,
  type PluginRegistry,
} from '@embedpdf/react-pdf-viewer'
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { cn } from '@/lib/cn'
import {
  PDF_DISABLED_CATEGORIES,
  PDF_SHADOW_CSS,
  openingZoomCap,
  pdfViewerTheme,
  shortcutOf,
} from '@/lib/pdf-viewer-config'
import { trpc } from '@/lib/trpc'
import { activeModeAtom } from '@/state/color-scheme'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

/** How long the marks have to be quiet before the file is rewritten. Matches
 *  the feel of autosave without being it: autosave's 3 s is a git commit, this
 *  is a file write the commit then picks up. */
const SAVE_QUIET_MS = 1000

/** How long the viewer may stay invisible waiting for a page. Measured opens
 *  paint the first page in about 300 ms; this only matters when none comes. */
const REVEAL_AFTER_MS = 1500

/**
 * The slices of the viewer's plugins this file touches, typed structurally.
 * The plugin packages are transitive dependencies of the snippet, so their
 * types are not importable here, and these methods are all that is used.
 */
interface Task<T> {
  toPromise(): Promise<T>
}
interface ViewerPlugins {
  annotation: { onAnnotationEvent(cb: () => void): () => void }
  export: { saveAsCopy(): Task<ArrayBuffer> }
  zoom: {
    onZoomChange(
      cb: (event: { documentId: string; level: string | number; newZoom: number }) => void,
    ): () => void
    forDocument(documentId: string): { requestZoom(level: number): void }
  }
  commands: {
    getCommandByShortcut(shortcut: string): { id: string } | undefined
    resolve(id: string): { disabled: boolean; visible: boolean }
  }
}
function provided<K extends keyof ViewerPlugins>(
  registry: PluginRegistry,
  id: K,
): ViewerPlugins[K] | null {
  const plugin = registry.getPlugin(id) as { provides(): ViewerPlugins[K] } | null
  return plugin === null ? null : plugin.provides()
}

export function PdfDocument({
  path,
  quietMs = SAVE_QUIET_MS,
  revealAfterMs = REVEAL_AFTER_MS,
}: {
  path: string
  quietMs?: number
  revealAfterMs?: number
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const mode = useAtomValue(activeModeAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const fileUpdatedAt = snapshot.files.find((f) => f.path === path)?.updatedAt ?? null

  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped to fetch the bytes again; the viewer is keyed on the URL, so a new
  // URL is a fresh viewer over the new document.
  const [generation, setGeneration] = useState(0)
  /** The `src` whose viewer has painted a page (or given up waiting for one).
   *  Keyed on the URL, so a reload after a foreign change arrives again too. */
  const [revealedSrc, setRevealedSrc] = useState<string | null>(null)

  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewerRef>(null)
  const registryRef = useRef<PluginRegistry | null>(null)
  /** The mtime of the last state this viewer knows the file to be in: what the
   *  snapshot said at first sight, then what each of our writes produced. */
  const knownMtimeRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savePendingRef = useRef(false)

  useEffect(() => {
    if (remote === null) return
    let cancelled = false
    let url: string | null = null
    trpc.files.read.query({ remote, path }).then(
      (bytes) => {
        if (cancelled) return
        // tRPC's inferred output for a `Uint8Array` is a JSON-shaped stand-in;
        // structured clone delivered the real thing (see `files.read`).
        const part = bytes as unknown as Uint8Array<ArrayBuffer>
        url = URL.createObjectURL(new Blob([part], { type: 'application/pdf' }))
        setError(null)
        setSrc(url)
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [remote, path, generation])

  // A foreign change to the file on disk. The first sighting is the baseline;
  // our own write's mtime is stored by `save` before the snapshot carrying it
  // can arrive, so it matches and nothing happens.
  useEffect(() => {
    if (fileUpdatedAt === null) return
    if (knownMtimeRef.current === null) {
      knownMtimeRef.current = fileUpdatedAt
      return
    }
    if (fileUpdatedAt === knownMtimeRef.current || savePendingRef.current) return
    knownMtimeRef.current = fileUpdatedAt
    setGeneration((g) => g + 1)
  }, [fileUpdatedAt])

  const save = useCallback(async () => {
    const registry = registryRef.current
    const exporter = registry === null ? null : provided(registry, 'export')
    if (exporter === null || remote === null) {
      savePendingRef.current = false
      return
    }
    try {
      const buffer = await exporter.saveAsCopy().toPromise()
      const { updatedAt } = await trpc.files.write.mutate({
        remote,
        path,
        bytes: new Uint8Array(buffer),
      })
      knownMtimeRef.current = updatedAt
    } catch (err) {
      console.error(`[pdf] could not save marks into ${path}:`, err)
    } finally {
      savePendingRef.current = false
    }
  }, [remote, path])

  const scheduleSave = useCallback(() => {
    savePendingRef.current = true
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void save()
    }, quietMs)
  }, [save, quietMs])

  // A tab closed inside the quiet window still gets its marks written: the
  // timer is dropped and the save runs at once, while the registry is alive.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null) return
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      void save()
    }
  }, [save])

  // Per container, as the wrapper creates it: in development StrictMode builds
  // and discards one before the one that stays, so a ref read from an effect
  // can be the discarded one. `load` does not bubble, but it does travel the
  // capture phase, so one listener on the shadow root hears every page image.
  const onInit = useCallback(
    (container: HTMLElement) => {
      const root = container.shadowRoot
      if (root === null) return
      const style = document.createElement('style')
      style.textContent = PDF_SHADOW_CSS
      root.append(style)
      root.addEventListener(
        'load',
        (event) => {
          if (event.target instanceof HTMLImageElement) setRevealedSrc(src)
        },
        true,
      )
    },
    [src],
  )

  const onReady = useCallback(
    (registry: PluginRegistry) => {
      registryRef.current = registry
      provided(registry, 'annotation')?.onAnnotationEvent(scheduleSave)
      const zoom = provided(registry, 'zoom')
      const opened = new Set<string>()
      zoom?.onZoomChange((event) => {
        if (opened.has(event.documentId)) return
        opened.add(event.documentId)
        const cap = openingZoomCap(event.level, event.newZoom)
        if (cap !== null) zoom.forDocument(event.documentId).requestZoom(cap)
      })
    },
    [scheduleSave],
  )

  useLayoutEffect(() => {
    const guard = (event: KeyboardEvent) => {
      const host = hostRef.current
      if (host === null || event.composedPath().includes(host)) return
      const registry = registryRef.current
      const commands = registry === null ? null : provided(registry, 'commands')
      const shortcut = shortcutOf(event)
      if (commands === null || shortcut === null) return
      const command = commands.getCommandByShortcut(shortcut)
      if (command === undefined) return
      const state = commands.resolve(command.id)
      if (!state.disabled && state.visible) event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', guard)
    return () => document.removeEventListener('keydown', guard)
  }, [])

  useEffect(() => {
    viewerRef.current?.container?.setTheme(pdfViewerTheme(mode))
  }, [mode, src])

  // The fallback: a viewer that never paints a page still arrives.
  useEffect(() => {
    if (src === null) return
    const timer = setTimeout(() => setRevealedSrc(src), revealAfterMs)
    return () => clearTimeout(timer)
  }, [src, revealAfterMs])

  return (
    <div ref={hostRef} className="flex min-h-0 flex-1 flex-col bg-background">
      {error !== null ? (
        <p className="m-auto text-xs text-muted-foreground">{error}</p>
      ) : src === null ? null : (
        <PDFViewer
          key={src}
          ref={viewerRef}
          className={cn('min-h-0 flex-1', revealedSrc === src ? 'motion-in-fade' : 'opacity-0')}
          style={{ height: '100%' }}
          onInit={onInit}
          onReady={onReady}
          config={{
            src,
            // Absolute on purpose: a root-relative URL resolved against the
            // engine worker's `blob:` base is the old Holi's "Loading PDF…" hang.
            wasmUrl: new URL(pdfiumWasmUrl, window.location.href).href,
            worker: true,
            // No CDN fonts: the vault's PDFs embed theirs, and the app is offline-first.
            fontFallback: null,
            tabBar: 'never',
            zoom: { defaultZoomLevel: ZoomMode.FitWidth },
            disabledCategories: [...PDF_DISABLED_CATEGORIES],
            theme: pdfViewerTheme(mode),
          }}
        />
      )}
    </div>
  )
}
