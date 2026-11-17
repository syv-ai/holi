import { Provider, createStore } from 'jotai'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { activeRemoteAtom, snapshotAtom } from '../src/renderer/src/state/vaults'
import { vaultSettingsAtom } from '../src/renderer/src/state/settings'
import { emptyVaultSnapshot, resolveVaultSettings } from '@holi/shared'
import { DocumentView } from '../src/renderer/src/features/documents/document-view'
import { flushAllBuffers } from '../src/renderer/src/lib/buffer-registry'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import '../src/renderer/src/index.css'

declare global {
  interface Window {
    richTextVimIO: {
      read(path: string): Promise<string>
      write(path: string, text: string): Promise<void>
      call(name: string, input: { remote?: string; path: string; text?: string }): Promise<unknown>
    }
    richTextVimFixture: {
      initial: string
      state(): {
        markdown: string
        selectedText: string
        json: { content: { type: string }[] }
        selection: { from: number; to: number }
        editable: boolean
        mode: string
      }
      setup(html: string, position: number): void
      flush(): Promise<string>
      reload(): Promise<void>
      externalWrite(text: string): Promise<void>
      focus(): void
      mode(enabled: boolean): void
      visibility(value: boolean): void
      focusOwnership(value: boolean): void
    }
  }
}

const remote = 'fixture/rich-text-vim'
const path = 'notes/acceptance.md'
const initial = `---\ntitle: Native Vim fixture\ntags: [kept]\n---\n\n# Heading\n\nalpha beta alpha\n\n**bold mark** and [link](https://example.test) plus [[Wiki note]]\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n- parent\n  - child\n- [ ] task\n\n1. ordered item\n\n| left | right |\n| --- | --- |\n| one | two |\n\n~~~mermaid\nA --> B\n~~~\n`
const store = createStore()
store.set(vimCodeEditingAtom, true)
store.set(activeRemoteAtom, remote)
store.set(vaultSettingsAtom, {
  remote,
  settings: resolveVaultSettings(
    { app: null, appLocal: null, plugins: null, pluginsLocal: null },
    [],
  ),
})
store.set(snapshotAtom, {
  ...emptyVaultSnapshot(),
  docs: [{ path, kind: 'note', updatedAt: 'fixture' }],
})

function editor(): Editor {
  const element = document.querySelector('[role="textbox"]') as HTMLElement | null
  const value = element && (element as HTMLElement & { editor?: Editor }).editor
  if (!value) throw new Error('Production document editor is not mounted')
  return value
}

function App() {
  const [revision, setRevision] = useState(0)
  const [visible, setVisible] = useState(true)
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    Object.assign(window, {
      richTextVimFixture: {
        initial,
        state() {
          const current = editor()
          return {
            markdown: current.getMarkdown(),
            selectedText: current.state.doc.textBetween(
              current.state.selection.from,
              current.state.selection.to,
            ),
            json: current.state.doc.toJSON(),
            selection: current.state.selection.toJSON(),
            editable: current.isEditable,
            mode: document.body.innerText,
          }
        },
        setup(html: string, position: number) {
          const current = editor()
          current.commands.setContent(html)
          current.commands.setTextSelection(position)
          current.commands.focus()
        },
        async flush() {
          await flushAllBuffers()
          return window.richTextVimIO.read(path)
        },
        async reload() {
          setRevision((value) => value + 1)
        },
        async externalWrite(text: string) {
          await window.richTextVimIO.write(path, text)
          setRevision((value) => value + 1)
        },
        focus() {
          editor().commands.focus()
        },
        mode(enabled: boolean) {
          store.set(vimCodeEditingAtom, enabled)
        },
        visibility(value: boolean) {
          setVisible(value)
        },
        focusOwnership(value: boolean) {
          setFocused(value)
        },
      },
    })
  })
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main className="flex h-screen flex-col gap-2 bg-background p-4 text-foreground">
          <header className="text-sm">Production DocumentView · disposable fixture</header>
          <section data-fixture-document hidden={!visible} className="min-h-0 flex-1">
            <DocumentView
              key={revision}
              path={path}
              onOpen={() => undefined}
              visible={visible}
              focused={focused}
            />
          </section>
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
