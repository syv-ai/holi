import { Provider, createStore } from 'jotai'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import { emptyVaultSnapshot, resolveVaultSettings } from '@holi/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DocumentView } from '@/features/documents/document-view'
import { selectionAnchor, selectionLines } from '@/features/documents/document-comments'
import { splitDocument } from '@/features/documents/markdown'
import { flushAllBuffers } from '@/lib/buffer-registry'
import { stampPlatform } from '@/lib/platform'
import { trpc } from '@/lib/trpc'
import { colorSchemeAtom } from '@/state/color-scheme'
import { documentRunsAtom } from '@/state/document-runs'
import { vaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'
import { ConvertToPdf } from '../src/plugins/pdf/renderer/convert-to-pdf'
import '../src/renderer/src/index.css'

stampPlatform()
const remote = 'fixture/captions'
const path = 'notes/Code-caption.md'
const other = 'notes/Clipboard.md'
const store = createStore()
store.set(activeRemoteAtom, remote)
store.set(vaultSettingsAtom, {
  remote,
  settings: resolveVaultSettings(
    { app: null, appLocal: null, plugins: null, pluginsLocal: null },
    [],
  ),
})
let generation = 0
function reload() {
  store.set(snapshotAtom, {
    ...emptyVaultSnapshot(),
    docs: [path, other].map((path) => ({
      path,
      kind: 'note' as const,
      updatedAt: String(++generation),
    })),
  })
}
reload()

const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))
const identities = new WeakMap<Editor, number>()
let identity = 0
function editor(which = 'primary'): Editor {
  const element = document.querySelector(`[data-pane="${which}"] [role="textbox"]`) as
    (HTMLElement & { editor?: Editor }) | null
  if (!element?.editor) throw new Error(`Production ${which} editor is not mounted`)
  return element.editor
}
function select(kind: string, which = 'primary', whole = false) {
  const current = editor(which)
  let at = -1
  let size = 0
  current.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === kind) {
      at = pos
      size = node.content.size
    }
  })
  if (at < 0) throw new Error(`Missing ${kind}`)
  if (kind === 'documentFigure' || kind === 'image') current.commands.setNodeSelection(at)
  else
    current.commands.setTextSelection(whole ? { from: at + 1, to: at + 1 + size } : at + 1 + size)
  current.view.focus()
}
function locked(value: boolean) {
  store.set(
    documentRunsAtom,
    value
      ? {
          [path]: {
            kind: 'rewrite',
            label: 'Native read-only fixture',
            agent: 'Fixture',
            provider: 'claude',
            sessionId: null,
            status: 'working',
            seenWorking: false,
          },
        }
      : {},
  )
}

function App() {
  const [revision, setRevision] = useState(0)
  const [mounted, setMounted] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [split, setSplit] = useState(false)
  const [rightFocused, setRightFocused] = useState(false)
  const [pdf, setPdf] = useState(false)
  async function reopen() {
    await flushAllBuffers()
    setMounted(false)
    window.setTimeout(() => {
      setRevision((n) => n + 1)
      setMounted(true)
    }, 20)
  }
  function theme(mode: 'light' | 'dark') {
    document.documentElement.dataset.theme = mode
    document.documentElement.classList.toggle('dark', mode === 'dark')
    store.set(colorSchemeAtom, mode)
  }
  useEffect(() => {
    Object.assign(window, {
      captionFixture: {
        errors,
        select,
        reload,
        flush: flushAllBuffers,
        theme,
        locked,
        reopen,
        hide: setHidden,
        split: setSplit,
        rightFocused: setRightFocused,
        state(which = 'primary') {
          const current = editor(which)
          if (!identities.has(current)) identities.set(current, ++identity)
          return {
            identity: identities.get(current),
            editable: current.isEditable,
            markdown: current.getMarkdown(),
            json: current.state.doc.toJSON(),
            revision,
            html: current.getHTML(),
            selection: current.state.selection.toJSON(),
          }
        },
        async anchor() {
          const { head } = splitDocument(await trpc.notes.read.query({ remote, path }))
          return { anchor: selectionAnchor(editor(), head), lines: selectionLines(editor(), head) }
        },
        htmlSelection() {
          const current = editor()
          const fragment = DOMSerializer.fromSchema(current.schema).serializeFragment(
            current.state.selection.content().content,
          )
          const container = document.createElement('div')
          container.append(fragment)
          return container.innerHTML
        },
      },
    })
  })
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
          <nav
            aria-label="Isolated native acceptance controls"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-sm text-muted-foreground">
              Production document · disposable vault
            </span>
            <Button variant="outline" size="sm" onClick={() => void reopen()}>
              Reopen
            </Button>
            <Button variant="outline" size="sm" onClick={() => setHidden(!hidden)}>
              {hidden ? 'Show retained' : 'Hide retained'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSplit(!split)}>
              Split
            </Button>
            <Button variant="outline" size="sm" onClick={() => theme('light')}>
              Light
            </Button>
            <Button variant="outline" size="sm" onClick={() => theme('dark')}>
              Dark
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPdf(true)}>
              Convert to PDF
            </Button>
          </nav>
          <div className="flex min-h-0 flex-1 gap-4">
            <section
              data-pane="primary"
              hidden={hidden}
              className="min-w-0 flex-1"
              onPointerDown={() => setRightFocused(false)}
            >
              {mounted && (
                <DocumentView
                  key={revision}
                  path={path}
                  onOpen={() => {}}
                  visible={!hidden}
                  focused={!hidden && !rightFocused}
                />
              )}
            </section>
            {split && (
              <section
                data-pane="secondary"
                className="min-w-0 flex-1"
                onPointerDown={() => setRightFocused(true)}
              >
                <DocumentView
                  path={other}
                  onOpen={() => {}}
                  visible
                  focused={rightFocused || hidden}
                />
              </section>
            )}
          </div>
          <Dialog open={pdf} onOpenChange={setPdf}>
            <DialogContent>
              <ConvertToPdf remote={remote} path={path} onClose={() => setPdf(false)} />
            </DialogContent>
          </Dialog>
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
