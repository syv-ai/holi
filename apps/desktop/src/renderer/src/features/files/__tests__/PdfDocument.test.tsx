/**
 * `PdfDocument` with embedpdf replaced by a fake that behaves the way the real
 * viewer does at the seams this component relies on: it renders whatever `src`
 * it was given, hands `onReady` a registry, and binds a keydown listener on
 * `document` from an effect. What a PDF looks like is the library's business.
 */
import { Provider, createStore } from 'jotai'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { emptyVaultSnapshot } from '@holi/shared'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { shortcutOf } from '@/lib/pdf-viewer-config'

const REMOTE = 'syv-ai/vault'
const PATH = 'docs/case.pdf'
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46])

const seam = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  /** Shortcuts the fake viewer's `document` listener saw. */
  seen: [] as string[],
  annotationCb: null as (() => void) | null,
  setTheme: vi.fn(),
  saveAsCopy: vi.fn(),
  /** The viewer's shadow root, as the real container has one. */
  shadow: null as ShadowRoot | null,
}))

vi.mock('@/lib/trpc', () => ({
  trpc: {
    files: {
      read: { query: (input: unknown) => seam.read(input) },
      write: { mutate: (input: unknown) => seam.write(input) },
    },
  },
}))

vi.mock('@embedpdf/pdfium/pdfium.wasm?url', () => ({ default: '/assets/pdfium.wasm' }))

vi.mock('@embedpdf/react-pdf-viewer', () => {
  const plugins: Record<string, unknown> = {
    annotation: {
      onAnnotationEvent: (cb: () => void) => {
        seam.annotationCb = cb
        return () => {}
      },
    },
    export: { saveAsCopy: () => seam.saveAsCopy() },
    commands: {
      getCommandByShortcut: (s: string) =>
        s === 'h' || s === 'meta+f' || s === 'meta+p' ? { id: s } : undefined,
      // ⌘P is print, which Holi disables by category; a disabled command must
      // not be claimed, or the palette never opens while a PDF is on screen.
      resolve: (id: string) => ({ disabled: id === 'meta+p', visible: true }),
    },
  }
  const registry = {
    getPlugin: (id: string) => (id in plugins ? { provides: () => plugins[id] } : null),
  }
  const PDFViewer = forwardRef(function FakeViewer(
    {
      config,
      className,
      onInit,
      onReady,
    }: {
      config: { src: string }
      className?: string
      onInit?: (c: HTMLElement) => void
      onReady?: (r: unknown) => void
    },
    ref,
  ) {
    // The real container is a custom element with an open shadow root, which
    // is where the viewer's UI and its page images live.
    const [container] = useState(() => {
      const el = document.createElement('embedpdf-container')
      seam.shadow = el.attachShadow({ mode: 'open' })
      return Object.assign(el, { setTheme: seam.setTheme })
    })
    useImperativeHandle(ref, () => ({ container, registry: null }))
    useEffect(() => {
      const listener = (e: KeyboardEvent) => {
        const s = shortcutOf(e)
        if (s !== null) seam.seen.push(s)
      }
      document.addEventListener('keydown', listener)
      onInit?.(container)
      onReady?.(registry)
      return () => document.removeEventListener('keydown', listener)
      // Mounted once per src, like the real wrapper.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div data-testid="pdf" data-pdf-src={config.src} className={className} />
  })
  return { PDFViewer }
})

import { PdfDocument } from '../PdfDocument'

let store: ReturnType<typeof createStore>
let urlCounter = 0

function snapshotWith(updatedAt: string) {
  return { ...emptyVaultSnapshot(), files: [{ path: PATH, updatedAt }] }
}

beforeEach(() => {
  seam.read.mockReset().mockResolvedValue(BYTES)
  seam.write.mockReset().mockResolvedValue({ updatedAt: 'T2' })
  seam.saveAsCopy.mockReset().mockReturnValue({
    toPromise: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
  })
  seam.setTheme.mockReset()
  seam.seen.length = 0
  seam.annotationCb = null
  urlCounter = 0
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => `blob:holi/${++urlCounter}`)
  URL.revokeObjectURL = vi.fn()
  store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(snapshotAtom, snapshotWith('T1'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mount({ revealAfterMs }: { revealAfterMs?: number } = {}) {
  return render(
    <Provider store={store}>
      <PdfDocument path={PATH} quietMs={0} revealAfterMs={revealAfterMs} />
    </Provider>,
  )
}

test('fetches the bytes over the seam and hands the viewer a blob URL', async () => {
  mount()
  const viewer = await screen.findByTestId('pdf')
  expect(viewer).toHaveAttribute('data-pdf-src', 'blob:holi/1')
  expect(seam.read).toHaveBeenCalledWith({ remote: REMOTE, path: PATH })
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob
  expect(blob.type).toBe('application/pdf')
  expect(blob.size).toBe(BYTES.byteLength)
})

test('themes the viewer through setTheme with Holi tokens', async () => {
  mount()
  await screen.findByTestId('pdf')
  await waitFor(() => expect(seam.setTheme).toHaveBeenCalled())
  const theme = seam.setTheme.mock.calls[0]![0] as { dark: { background: { app: string } } }
  expect(theme.dark.background.app).toBe('var(--background)')
})

test("covers the viewer's white page placeholder from inside its shadow root", async () => {
  mount()
  await screen.findByTestId('pdf')
  const css = [...seam.shadow!.querySelectorAll('style')].map((el) => el.textContent).join('\n')
  expect(css).toMatch(/background-color: rgb\(255, 255, 255\).*var\(--muted\)/)
})

test('stays invisible through its own loading states and arrives with the first page', async () => {
  mount()
  const viewer = await screen.findByTestId('pdf')
  // Engine and plugin spinners, then a toolbar, then pages: none of it shows.
  expect(viewer).toHaveClass('opacity-0')
  expect(viewer).not.toHaveClass('motion-in-fade')

  // Page images live in the shadow root; `load` does not bubble, so this is
  // exactly what a capture listener on that root has to catch.
  const page = document.createElement('img')
  seam.shadow!.append(page)
  act(() => {
    page.dispatchEvent(new Event('load'))
  })
  expect(viewer).toHaveClass('motion-in-fade')
  expect(viewer).not.toHaveClass('opacity-0')
})

test('arrives anyway when no page ever paints, so an error is never invisible', async () => {
  mount({ revealAfterMs: 10 })
  const viewer = await screen.findByTestId('pdf')
  expect(viewer).toHaveClass('opacity-0')
  await waitFor(() => expect(viewer).toHaveClass('motion-in-fade'))
})

test('writes the exported document back after a mark, and not before', async () => {
  mount()
  await screen.findByTestId('pdf')
  expect(seam.write).not.toHaveBeenCalled()
  expect(seam.annotationCb).not.toBeNull()

  act(() => seam.annotationCb!())
  await waitFor(() => expect(seam.write).toHaveBeenCalledTimes(1))
  const input = seam.write.mock.calls[0]![0] as { remote: string; path: string; bytes: Uint8Array }
  expect(input.remote).toBe(REMOTE)
  expect(input.path).toBe(PATH)
  expect(Array.from(input.bytes)).toEqual([1, 2, 3, 4])
})

test('its own write is not a reason to reload; a foreign change is', async () => {
  mount()
  await screen.findByTestId('pdf')
  act(() => seam.annotationCb!())
  await waitFor(() => expect(seam.write).toHaveBeenCalledTimes(1))

  // The snapshot tick our write causes carries the mtime the write returned.
  act(() => store.set(snapshotAtom, snapshotWith('T2')))
  await new Promise((r) => setTimeout(r, 0))
  expect(seam.read).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('pdf')).toHaveAttribute('data-pdf-src', 'blob:holi/1')

  // A pull or a re-export: different mtime, fetch again, fresh viewer.
  act(() => store.set(snapshotAtom, snapshotWith('T3')))
  await waitFor(() => expect(seam.read).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(screen.getByTestId('pdf')).toHaveAttribute('data-pdf-src', 'blob:holi/2'),
  )
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:holi/1')
})

test('a key the viewer would claim reaches it only from inside the viewer', async () => {
  mount()
  const viewer = await screen.findByTestId('pdf')

  // From the body (the file tree, say): stopped before the viewer's listener.
  fireEvent.keyDown(document.body, { key: 'h' })
  expect(seam.seen).not.toContain('h')

  // From inside the viewer: through.
  fireEvent.keyDown(viewer, { key: 'h' })
  expect(seam.seen).toContain('h')

  // A key the viewer does not bind is never touched.
  fireEvent.keyDown(document.body, { key: 'j', metaKey: true })
  expect(seam.seen).toContain('j+meta')
})

test('a disabled viewer command is not claimed, so ⌘P still reaches Holi', async () => {
  mount()
  await screen.findByTestId('pdf')
  const palette = vi.fn()
  window.addEventListener('keydown', palette)
  fireEvent.keyDown(document.body, { key: 'p', metaKey: true })
  window.removeEventListener('keydown', palette)
  expect(palette).toHaveBeenCalledTimes(1)
})

test('unmounting revokes the object URL', async () => {
  const { unmount } = mount()
  await screen.findByTestId('pdf')
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:holi/1')
})
