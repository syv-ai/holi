/**
 * `PdfDocument` with embedpdf replaced by a fake that behaves the way the real
 * viewer does at the seams this component relies on: it renders whatever `src`
 * it was given, hands `onReady` a registry, and binds a keydown listener on
 * `document` from an effect. What a PDF looks like is the library's business.
 */
import { Provider, createStore } from 'jotai'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { emptyVaultSnapshot } from '@holi/shared'
import { act, fireEvent, render, screen, waitFor } from '@/test/render'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { sessionAtom } from '@/state/session'
import { PDF_FONTS, PDF_SIGNATURE_NOTE, shortcutOf } from '@/lib/pdf-viewer-config'

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
  /** The zoom plugin's listener, and what was asked of it. */
  zoomCb: null as
    ((e: { documentId: string; level: string | number; newZoom: number }) => void) | null,
  requestZoom: vi.fn(),
  sidebarCb: null as ((e: { sidebarId: string }) => void) | null,
  mergeSchema: vi.fn(),
  registerCommand: vi.fn(),
  updateAnnotation: vi.fn(),
  execute: vi.fn(),
  loadEntries: vi.fn(),
  entriesCb: null as ((entries: unknown[]) => void) | null,
  savedSignatures: vi.fn(),
  saveSignatures: vi.fn(),
  config: null as {
    zoom?: { defaultZoomLevel?: unknown }
    annotations?: { annotationAuthor?: string }
    signature?: { mode?: string }
    fonts?: unknown
    stamp?: { manifests?: unknown }
    icons?: Record<string, unknown>
  } | null,
  /** The viewer's shadow root, as the real container has one. */
  shadow: null as ShadowRoot | null,
  /** What the viewer's store holds, for a read at send time. */
  store: {} as unknown,
  /** The agent seam: an ask handed to `sendToAgentAtom`. */
  send: vi.fn(),
}))

vi.mock('@/state/agent-send', async () => {
  const { atom } = await import('jotai')
  return {
    sendToAgentAtom: atom(null, (_get, _set, args: { text: string; target: string }) =>
      seam.send(args),
    ),
  }
})

vi.mock('@/lib/trpc', () => ({
  trpc: {
    files: {
      read: { query: (input: unknown) => seam.read(input) },
      write: { mutate: (input: unknown) => seam.write(input) },
    },
    pdf: {
      signatures: { query: () => seam.savedSignatures() },
      saveSignatures: { mutate: (input: unknown) => seam.saveSignatures(input) },
    },
  },
}))

vi.mock('@embedpdf/pdfium/pdfium.wasm?url', () => ({ default: '/assets/pdfium.wasm' }))

vi.mock('@embedpdf/react-pdf-viewer', () => {
  const plugins: Record<string, unknown> = {
    annotation: {
      updateAnnotation: (pageIndex: number, id: string, patch: unknown) =>
        seam.updateAnnotation(pageIndex, id, patch),
      onAnnotationEvent: (cb: () => void) => {
        seam.annotationCb = cb
        return () => {}
      },
      getTools: () => [],
      setToolDefaults: () => {},
      getColorPresets: () => [],
      addColorPreset: () => {},
    },
    export: { saveAsCopy: () => seam.saveAsCopy() },
    signature: {
      loadEntries: (entries: unknown[]) => seam.loadEntries(entries),
      onEntriesChange: (cb: NonNullable<typeof seam.entriesCb>) => {
        seam.entriesCb = cb
        return () => {}
      },
    },
    ui: {
      getSchema: () => ({
        toolbars: {
          'main-toolbar': {
            id: 'main-toolbar',
            items: [
              {
                type: 'group',
                id: 'right-group',
                items: [{ type: 'command-button', id: 'search-button' }],
              },
            ],
          },
          'annotation-toolbar': {
            id: 'annotation-toolbar',
            items: [
              {
                type: 'group',
                id: 'annotation-tools',
                items: [
                  { type: 'command-button', id: 'add-highlight' },
                  { type: 'command-button', id: 'add-comment' },
                ],
              },
            ],
          },
        },
      }),
      mergeSchema: (partial: unknown) => seam.mergeSchema(partial),
      onSidebarChanged: (cb: NonNullable<typeof seam.sidebarCb>) => {
        seam.sidebarCb = cb
        return () => {}
      },
    },
    zoom: {
      onZoomChange: (cb: NonNullable<typeof seam.zoomCb>) => {
        seam.zoomCb = cb
        return () => {}
      },
      forDocument: (id: string) => ({
        requestZoom: (level: unknown) => seam.requestZoom(id, level),
      }),
    },
    commands: {
      getCommandByShortcut: (s: string) =>
        s === 'h' || s === 'meta+f' || s === 'meta+p' ? { id: s } : undefined,
      // ⌘P is print, which Holi disables by category; a disabled command must
      // not be claimed, or the palette never opens while a PDF is on screen.
      resolve: (id: string) => ({ disabled: id === 'meta+p', visible: true }),
      execute: (id: string, documentId?: string) =>
        documentId === undefined ? seam.execute(id) : seam.execute(id, documentId),
      registerCommand: (command: unknown) => seam.registerCommand(command),
    },
  }
  const registry = {
    getPlugin: (id: string) => (id in plugins ? { provides: () => plugins[id] } : null),
    getStore: () => ({ getState: () => seam.store }),
    // No glyphs: the ask falls back to what the store has.
    getEngine: () => null,
  }
  const PDFViewer = forwardRef(function FakeViewer(
    {
      config,
      className,
      onInit,
      onReady,
    }: {
      config: {
        src: string
        zoom?: { defaultZoomLevel?: unknown }
        annotations?: { annotationAuthor?: string }
        signature?: { mode?: string }
        fonts?: unknown
        stamp?: { manifests?: unknown }
        icons?: Record<string, unknown>
      }
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
    // Appended into its own div, as the real wrapper does.
    const divRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
      const listener = (e: KeyboardEvent) => {
        const s = shortcutOf(e)
        if (s !== null) seam.seen.push(s)
      }
      document.addEventListener('keydown', listener)
      seam.config = config
      divRef.current?.append(container)
      onInit?.(container)
      onReady?.(registry)
      return () => document.removeEventListener('keydown', listener)
      // Mounted once per src, like the real wrapper.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div ref={divRef} data-testid="pdf" data-pdf-src={config.src} className={className} />
  })
  return {
    PDFViewer,
    ZoomMode: { FitWidth: 'fit-width' },
    SignatureMode: { SignatureOnly: 'signature-only' },
    // The library's own (de)serializers, tagged so the test can see they ran.
    serializeEntries: (entries: unknown[]) => entries.map((e) => ({ serialized: e })),
    deserializeEntries: (entries: unknown[]) => entries.map((e) => ({ deserialized: e })),
  }
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
  seam.zoomCb = null
  seam.sidebarCb = null
  seam.mergeSchema.mockReset()
  seam.registerCommand.mockReset()
  seam.updateAnnotation.mockReset()
  seam.execute.mockReset()
  seam.loadEntries.mockReset()
  seam.entriesCb = null
  seam.savedSignatures.mockReset().mockResolvedValue('[]')
  seam.saveSignatures.mockReset().mockResolvedValue({ ok: true })
  seam.requestZoom.mockReset()
  seam.store = {}
  seam.send.mockReset().mockResolvedValue({ ok: true })
  urlCounter = 0
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => `blob:holi/${++urlCounter}`)
  URL.revokeObjectURL = vi.fn()
  store = createStore()
  store.set(activeRemoteAtom, REMOTE)
  store.set(snapshotAtom, snapshotWith('T1'))
  store.set(sessionAtom, { login: 'ada-holm', name: 'Ada Holm' })
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

test('opens at fit-width, held to 150% where that would overshoot, once', async () => {
  mount()
  await screen.findByTestId('pdf')
  expect(seam.config?.zoom?.defaultZoomLevel).toBe('fit-width')

  // A narrow pane: fit-width is under 150% and stands.
  act(() => seam.zoomCb!({ documentId: 'narrow', level: 'fit-width', newZoom: 0.75 }))
  expect(seam.requestZoom).not.toHaveBeenCalled()

  // A wide pane: fit-width would be 237%, so the opening is 150%.
  act(() => seam.zoomCb!({ documentId: 'wide', level: 'fit-width', newZoom: 2.37 }))
  expect(seam.requestZoom).toHaveBeenCalledWith('wide', 1.5)

  // Fit Width chosen later from the menu means fit width.
  seam.requestZoom.mockClear()
  act(() => seam.zoomCb!({ documentId: 'wide', level: 'fit-width', newZoom: 2.37 }))
  act(() => seam.zoomCb!({ documentId: 'narrow', level: 'fit-width', newZoom: 2.37 }))
  expect(seam.requestZoom).not.toHaveBeenCalled()
})

test('signs marks and comments with the GitHub login, not "Guest"', async () => {
  mount()
  await screen.findByTestId('pdf')
  expect(seam.config?.annotations?.annotationAuthor).toBe('ada-holm')
})

test("fetches no font: its UI is Holi's and the signature faces are bundled", async () => {
  mount()
  await screen.findByTestId('pdf')
  expect(seam.config?.fonts).toEqual(PDF_FONTS)
})

test('fetches no stamp library from the CDN', async () => {
  mount()
  await screen.findByTestId('pdf')
  // Rubber stamps are disabled, but the stamp plugin still fetched its default
  // manifest and stamps from jsDelivr on every open.
  expect(seam.config?.stamp?.manifests).toEqual([])
})

test('loads the signature faces when the signature panel opens', async () => {
  const load = vi.fn(async () => [])
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
  mount()
  await screen.findByTestId('pdf')
  act(() => seam.sidebarCb!({ sidebarId: 'signature-panel' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(4))
  expect(load).toHaveBeenCalledWith('16px "Dancing Script"')
  // jsdom has no FontFaceSet; do not leave the fake behind for other tests.
  delete (document as { fonts?: unknown }).fonts
})

test('the signature panel says what placing a signature shares, while it is open', async () => {
  mount()
  await screen.findByTestId('pdf')
  // The panel as the viewer renders it: a column inside the tagged sidebar.
  const panel = document.createElement('div')
  panel.dataset.sidebarId = 'signature-panel'
  panel.innerHTML = '<div class="min-h-0"><div class="flex-col"><button>Create</button></div></div>'
  seam.shadow!.append(panel)

  act(() => seam.sidebarCb!({ sidebarId: 'signature-panel' }))
  await waitFor(() => expect(seam.shadow!.querySelector('.holi-signature-note')).not.toBeNull())
  const note = seam.shadow!.querySelector('.flex-col > .holi-signature-note')!
  expect(note.textContent).toBe(PDF_SIGNATURE_NOTE)
  expect(note.textContent!.length).toBeGreaterThan(40)

  panel.remove()
  act(() => seam.sidebarCb!({ sidebarId: '' }))
  await waitFor(() => expect(seam.shadow!.querySelector('.holi-signature-note')).toBeNull())
})

test('puts Signatures on the top bar', async () => {
  mount()
  await screen.findByTestId('pdf')
  expect(seam.mergeSchema).toHaveBeenCalledTimes(1)
  const partial = seam.mergeSchema.mock.calls[0]![0] as {
    toolbars: Record<string, { items: { id: string; items?: { id: string }[] }[] }>
  }
  const right = partial.toolbars['main-toolbar']!.items.find((i) => i.id === 'right-group')!
  expect(right.items!.map((i) => i.id)).toEqual([
    'signature-button',
    'add-comment-button',
    'make-read-only-button',
    'make-editable-button',
    'search-button',
    // After the comments button, which this trimmed toolbar does not have.
    'ask-agent-thread-button',
    'ask-agent-all-button',
  ])
  // The commands those buttons name exist before the toolbar asks for them.
  expect(seam.registerCommand.mock.invocationCallOrder[0]).toBeLessThan(
    seam.mergeSchema.mock.invocationCallOrder[0]!,
  )
  expect(seam.config?.icons).toHaveProperty('holi-lock')
  // The same merge widens the comments panel.
  expect(seam.mergeSchema.mock.calls[0]![0]).toHaveProperty('sidebars.comment-panel.width', '360px')
  // The comment tool moved to the top bar, so the Annotate bar drops it.
  const annotate = partial.toolbars['annotation-toolbar']!.items.find(
    (i) => i.id === 'annotation-tools',
  )!
  expect(annotate.items!.map((i) => i.id)).toEqual(['add-highlight'])
})

test("Add comment on the top bar is the viewer's comment tool, under its own name", async () => {
  mount()
  await screen.findByTestId('pdf')
  type Cmd = {
    id: string
    label: string
    icon: string
    action: (c: unknown) => void
    active: (c: unknown) => boolean
  }
  const add = (seam.registerCommand.mock.calls.map((c) => c[0]) as Cmd[]).find(
    (c) => c.id === 'holi:add-comment',
  )!
  // Not "Comment": that is the comments panel's button, right beside it.
  expect(add.label).toBe('Add comment')
  expect(add.icon).toBe('message')
  add.action({ state: {}, documentId: 'doc' })
  expect(seam.execute).toHaveBeenCalledWith('annotation:add-comment', 'doc')
  const on = { plugins: { annotation: { documents: { doc: { activeToolId: 'textComment' } } } } }
  expect(add.active({ state: on, documentId: 'doc' })).toBe(true)
})

test('makes every mark read-only, then editable again, from the top bar', async () => {
  mount()
  await screen.findByTestId('pdf')
  type Cmd = {
    id: string
    visible: (c: unknown) => boolean
    disabled?: (c: unknown) => boolean
    action: (c: unknown) => void
  }
  const cmd = (id: string) =>
    (seam.registerCommand.mock.calls.map((c) => c[0]) as Cmd[]).find((c) => c.id === id)!
  const ctx = (objects: { id: string; pageIndex: number; type: number; flags: string[] }[]) => ({
    documentId: 'doc',
    state: {
      plugins: {
        annotation: {
          documents: {
            doc: { byUid: Object.fromEntries(objects.map((o) => [o.id, { object: o }])) },
          },
        },
      },
    },
  })
  const makeReadOnly = cmd('holi:make-marks-read-only')
  const makeEditable = cmd('holi:make-marks-editable')

  // A highlight and a signature, plus a link that belongs to the document.
  const open = ctx([
    { id: 'h', pageIndex: 0, type: 9, flags: ['print'] },
    { id: 's', pageIndex: 8, type: 13, flags: ['print'] },
    { id: 'l', pageIndex: 0, type: 2, flags: [] },
  ])
  expect(makeReadOnly.visible(open)).toBe(true)
  expect(makeReadOnly.disabled!(open)).toBe(false)
  expect(makeEditable.visible(open)).toBe(false)
  makeReadOnly.action(open)
  expect(seam.updateAnnotation.mock.calls).toEqual([
    [0, 'h', { flags: ['print', 'readOnly'] }],
    [8, 's', { flags: ['print', 'readOnly'] }],
  ])

  const locked = ctx([
    { id: 'h', pageIndex: 0, type: 9, flags: ['print', 'readOnly'] },
    { id: 'l', pageIndex: 0, type: 2, flags: [] },
  ])
  expect(makeReadOnly.visible(locked)).toBe(false)
  expect(makeEditable.visible(locked)).toBe(true)
  seam.updateAnnotation.mockClear()
  makeEditable.action(locked)
  expect(seam.updateAnnotation.mock.calls).toEqual([[0, 'h', { flags: ['print'] }]])

  // Nothing to protect: the button shows, and does nothing.
  expect(makeReadOnly.disabled!(ctx([{ id: 'l', pageIndex: 0, type: 2, flags: [] }]))).toBe(true)
})

test('asks for a signature alone, never initials as well', async () => {
  mount()
  await screen.findByTestId('pdf')
  // In signature-and-initials mode Save stays disabled until both are filled,
  // with nothing saying so: an uploaded signature looked like it did nothing.
  expect(seam.config?.signature?.mode).toBe('signature-only')
})

test('loads the saved signatures, then saves every change to them', async () => {
  seam.savedSignatures.mockResolvedValue(JSON.stringify([{ id: 's1' }]))
  mount()
  await screen.findByTestId('pdf')
  await waitFor(() => expect(seam.loadEntries).toHaveBeenCalledTimes(1))
  expect(seam.loadEntries).toHaveBeenCalledWith([{ deserialized: { id: 's1' } }])
  // Loading is not a change to save back.
  expect(seam.saveSignatures).not.toHaveBeenCalled()

  await waitFor(() => expect(seam.entriesCb).not.toBeNull())
  act(() => seam.entriesCb!([{ id: 's1' }, { id: 's2' }]))
  expect(seam.saveSignatures).toHaveBeenCalledWith({
    entriesJson: JSON.stringify([{ serialized: { id: 's1' } }, { serialized: { id: 's2' } }]),
  })
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

test('opening a PDF focuses it, so ⌘F reaches its search, like a note focuses its editor', async () => {
  mount()
  const host = (await screen.findByTestId('pdf')).parentElement!
  // Focusable, so a click on a page (not itself focusable) lands here too.
  expect(host).toHaveAttribute('tabindex', '-1')
  await waitFor(() => expect(document.activeElement).toBe(host))

  fireEvent.keyDown(document.activeElement!, { key: 'f', metaKey: true })
  expect(seam.seen).toContain('f+meta')
})

/**
 * A comment row as the viewer renders one: a one-line field whose value is
 * component state fed by its `input` event, and a send button that is
 * disabled while that state is blank and clears it on send.
 */
function commentRow() {
  const panel = document.createElement('div')
  panel.dataset.sidebarId = 'comment-panel'
  const row = document.createElement('div')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Add comment...'
  const send = document.createElement('button')
  send.disabled = true
  const sent: string[] = []
  let state = ''
  input.addEventListener('input', () => {
    state = input.value
    send.disabled = state.trim() === ''
  })
  send.addEventListener('click', () => {
    sent.push(state)
    state = ''
    input.value = ''
    send.disabled = true
  })
  row.append(input, send)
  panel.append(row)
  return { panel, row, input, send, sent }
}

test('a comment is written in a field that wraps, and sent through the viewer', async () => {
  mount()
  await screen.findByTestId('pdf')
  const { panel, row, input, sent } = commentRow()
  seam.shadow!.append(panel)
  const field = await waitFor(() => {
    const el = row.querySelector('textarea')
    expect(el).not.toBeNull()
    return el!
  })
  expect(field.placeholder).toBe('Add comment...')

  // Every keystroke reaches the viewer's own field, so its send button and
  // its idea of the text stay right. Its field is one line, so a line break
  // is a space: the comment would lose it anyway.
  fireEvent.change(field, { target: { value: 'one\ntwo' } })
  expect(input.value).toBe('one two')
  expect(field.value).toBe('one two')

  fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
  expect(sent).toEqual([])
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(sent).toEqual(['one two'])
  await waitFor(() => expect(field.value).toBe(''))

  // Blank, the viewer's button is disabled and Enter sends nothing.
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(sent).toEqual(['one two'])
})

test("focus the viewer gives its comment field goes to Holi's", async () => {
  mount()
  await screen.findByTestId('pdf')
  const { panel, row, input } = commentRow()
  seam.shadow!.append(panel)
  await waitFor(() => expect(row.querySelector('textarea')).not.toBeNull())
  // Selecting a comment focuses the field under it.
  act(() => input.focus())
  expect(seam.shadow!.activeElement).toBe(row.querySelector('textarea'))
})

/** A docked sidebar as the viewer renders one on a wide pane. */
function dockedPanel(id: string, text: string) {
  const panel = document.createElement('div')
  panel.dataset.sidebarId = id
  panel.className = 'border-l bg-bg-surface flex flex-col'
  panel.innerHTML = `<p>${text}</p>`
  return panel
}

test('a closing sidebar slides out: a stand-in plays the leave, then goes', async () => {
  // jsdom runs no animations; the stand-in waits on whatever it is given.
  let finish!: () => void
  const finished = new Promise<void>((resolve) => (finish = resolve))
  Element.prototype.getAnimations = () => [{ finished }] as unknown as Animation[]
  try {
    mount()
    await screen.findByTestId('pdf')
    const panel = dockedPanel('comment-panel', 'Page 9')
    seam.shadow!.append(panel)
    // The viewer unmounts a closing sidebar in the same render.
    panel.remove()
    const stand = await waitFor(() => {
      const el = seam.shadow!.querySelector('.holi-sidebar-leaving')
      expect(el).not.toBeNull()
      return el!
    })
    expect(stand.textContent).toBe('Page 9')
    expect(stand.getAttribute('data-sidebar-id')).toBe('comment-panel')
    // A picture of the panel, not the panel: nothing in it takes input.
    expect(stand.hasAttribute('inert')).toBe(true)

    finish()
    await waitFor(() => expect(seam.shadow!.querySelector('.holi-sidebar-leaving')).toBeNull())
  } finally {
    delete (Element.prototype as { getAnimations?: unknown }).getAnimations
  }
})

test('a sidebar opening where one is still leaving takes its place at once', async () => {
  Element.prototype.getAnimations = () =>
    [{ finished: new Promise(() => {}) }] as unknown as Animation[]
  try {
    mount()
    await screen.findByTestId('pdf')
    const panel = dockedPanel('comment-panel', 'Page 9')
    seam.shadow!.append(panel)
    panel.remove()
    await waitFor(() => expect(seam.shadow!.querySelector('.holi-sidebar-leaving')).not.toBeNull())
    seam.shadow!.append(dockedPanel('search-panel', 'Search'))
    await waitFor(() => expect(seam.shadow!.querySelector('.holi-sidebar-leaving')).toBeNull())
  } finally {
    delete (Element.prototype as { getAnimations?: unknown }).getAnimations
  }
})

test('⌘F puts the caret in the search field, and closing it gives focus back', async () => {
  mount()
  const host = (await screen.findByTestId('pdf')).parentElement!
  // The panel the viewer renders into its shadow root, tagged by the library.
  const panel = document.createElement('div')
  panel.dataset.sidebarId = 'search-panel'
  const field = document.createElement('input')
  field.type = 'text'
  panel.append(field)
  seam.shadow!.append(panel)

  act(() => seam.sidebarCb!({ sidebarId: 'search-panel' }))
  await waitFor(() => expect(seam.shadow!.activeElement).toBe(field))

  // Closed: the field goes, and focus must not fall to <body>, or the next ⌘F
  // would be a key from outside the viewer.
  // Closing reports no sidebar at all, measured in the running viewer.
  panel.remove()
  act(() => seam.sidebarCb!({ sidebarId: '' }))
  await waitFor(() => expect(document.activeElement).toBe(host))
})

test('Escape in the search field closes the search, like a find bar', async () => {
  mount()
  await screen.findByTestId('pdf')
  const panel = document.createElement('div')
  panel.dataset.sidebarId = 'search-panel'
  const field = document.createElement('input')
  field.type = 'text'
  panel.append(field)
  seam.shadow!.append(panel)
  const holi = vi.fn()
  document.addEventListener('keydown', holi)

  fireEvent.keyDown(field, { key: 'Escape' })
  expect(seam.execute).toHaveBeenCalledWith('panel:toggle-search')
  // Consumed: Holi's own Escape handlers do not also act on it.
  expect(holi).not.toHaveBeenCalled()

  // Escape anywhere else in the viewer is not ours to take.
  fireEvent.keyDown(seam.shadow!.host, { key: 'Escape' })
  expect(seam.execute).toHaveBeenCalledTimes(1)
  document.removeEventListener('keydown', holi)
})

test('a reload after a foreign change does not take focus back', async () => {
  mount()
  const host = (await screen.findByTestId('pdf')).parentElement!
  // The opening focus is an effect; let it land before moving focus away, or
  // it can arrive after and look like the reload took focus.
  await waitFor(() => expect(document.activeElement).toBe(host))
  const elsewhere = document.createElement('button')
  document.body.append(elsewhere)
  elsewhere.focus()

  act(() => store.set(snapshotAtom, snapshotWith('T3')))
  await waitFor(() =>
    expect(screen.getByTestId('pdf')).toHaveAttribute('data-pdf-src', 'blob:holi/2'),
  )
  expect(document.activeElement).toBe(elsewhere)
  elsewhere.remove()
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

test('asks the agent about the selected comment, or about all of them, pasting and never submitting', async () => {
  mount()
  await screen.findByTestId('pdf')
  type Cmd = {
    id: string
    label: string
    visible: (c: unknown) => boolean
    disabled?: (c: unknown) => boolean
    action: (c: unknown) => void
  }
  const cmd = (id: string) =>
    (seam.registerCommand.mock.calls.map((c) => c[0]) as Cmd[]).find((c) => c.id === id)!
  const at = (iso: string) => new Date(iso)
  const rect = (y: number) => ({ origin: { x: 10, y }, size: { width: 50, height: 10 } })
  const objects = [
    {
      id: 'h',
      type: 9,
      pageIndex: 3,
      rect: rect(100),
      author: 'Ada Holm',
      created: at('2026-09-22T14:10:00'),
      contents: 'Should be 30 days.',
      custom: { text: 'payment within 60 days' },
    },
    {
      id: 'r',
      type: 1,
      pageIndex: 3,
      rect: rect(100),
      author: 'Bo Lind',
      created: at('2026-09-22T15:02:00'),
      contents: 'Agreed.',
      inReplyToId: 'h',
    },
    {
      id: 'n',
      type: 1,
      pageIndex: 6,
      rect: rect(50),
      author: 'Bo Lind',
      created: at('2026-09-23T09:41:00'),
      contents: 'Is this standard?',
    },
    { id: 'l', type: 2, pageIndex: 0, rect: rect(0) },
  ]
  const stateWith = (selected: string | null, objs = objects) => ({
    plugins: {
      annotation: {
        documents: {
          doc: {
            byUid: Object.fromEntries(objs.map((o) => [`uid-${o.id}`, { object: o }])),
            selectedUids: selected === null ? [] : [`uid-${selected}`],
          },
        },
      },
    },
  })
  const ctx = (state: unknown) => ({ documentId: 'doc', state })
  const thread = cmd('holi:ask-agent-thread')
  const all = cmd('holi:ask-agent-all')
  expect(thread.label).toBe('Ask agent about this comment')
  expect(all.label).toBe('Ask agent about all comments')

  // Nothing selected: the button asks about all, and is off with no comments.
  expect(thread.visible(ctx(stateWith(null)))).toBe(false)
  expect(all.visible(ctx(stateWith(null)))).toBe(true)
  expect(all.disabled!(ctx(stateWith(null)))).toBe(false)
  expect(all.disabled!(ctx(stateWith(null, [objects[3]!])))).toBe(true)
  // A comment selected, or a reply in its thread: this comment.
  expect(thread.visible(ctx(stateWith('h')))).toBe(true)
  expect(all.visible(ctx(stateWith('h')))).toBe(false)
  // A link is not a comment.
  expect(thread.visible(ctx(stateWith('l')))).toBe(false)

  // All: the instruction first, then every thread.
  seam.store = stateWith(null)
  act(() => all.action(ctx(seam.store)))
  const field = await screen.findByLabelText(/Instructions for the agent/)
  fireEvent.change(field, { target: { value: 'Resolve these.' } })
  fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
  await waitFor(() => expect(seam.send).toHaveBeenCalledTimes(1))
  const sent = seam.send.mock.calls[0]![0] as { text: string; target: string }
  expect(sent.target).toBe('new')
  expect(sent.text).toBe(
    [
      'Resolve these.',
      '',
      '[From docs/case.pdf, 2 comments]',
      '',
      'Page 4, highlight on "payment within 60 days"',
      '  Ada Holm, 2026-09-22 14:10',
      '  > Should be 30 days.',
      '  Reply, Bo Lind, 2026-09-22 15:02',
      '  > Agreed.',
      '',
      'Page 7, note',
      '  Bo Lind, 2026-09-23 09:41',
      '  > Is this standard?',
    ].join('\n'),
  )
  await waitFor(() =>
    expect(screen.queryByLabelText(/Instructions for the agent/)).not.toBeInTheDocument(),
  )

  // This comment, with a reply selected: only its thread, and an empty
  // instruction sends the comments alone.
  seam.store = stateWith('r')
  act(() => thread.action(ctx(seam.store)))
  fireEvent.keyDown(await screen.findByLabelText(/Instructions for the agent/), {
    key: 'Enter',
    metaKey: true,
  })
  await waitFor(() => expect(seam.send).toHaveBeenCalledTimes(2))
  expect((seam.send.mock.calls[1]![0] as { text: string }).text).toMatch(
    /^\[From docs\/case\.pdf, 1 comment\]\n\nPage 4, highlight/,
  )
})

test('keeps the text and says why when an ask is refused', async () => {
  mount()
  await screen.findByTestId('pdf')
  const all = (
    seam.registerCommand.mock.calls.map((c) => c[0]) as {
      id: string
      action: (c: unknown) => void
    }[]
  ).find((c) => c.id === 'holi:ask-agent-all')!
  seam.store = {
    plugins: {
      annotation: {
        documents: {
          doc: {
            byUid: {
              u: {
                object: {
                  id: 'n',
                  type: 1,
                  pageIndex: 0,
                  rect: { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
                  contents: 'Hi.',
                },
              },
            },
          },
        },
      },
    },
  }
  seam.send.mockResolvedValue({ ok: false, message: 'That session has ended.' })
  act(() => all.action({ documentId: 'doc', state: seam.store }))
  const field = await screen.findByLabelText(/Instructions for the agent/)
  fireEvent.change(field, { target: { value: 'Look at this' } })
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
  expect(await screen.findByRole('alert')).toHaveTextContent('That session has ended.')
  expect(field).toHaveValue('Look at this')
})
