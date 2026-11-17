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
      state(which?: 'primary' | 'secondary'): {
        markdown: string
        selectedText: string
        json: { content: { type: string }[] }
        selection: { from: number; to: number }
        editable: boolean
        mode: string
      }
      setup(html: string, position: number, which?: 'primary' | 'secondary'): void
      atText(text: string, which?: 'primary' | 'secondary'): void
      flush(): Promise<string>
      reload(): Promise<void>
      externalWrite(text: string): Promise<void>
      focus(which?: 'primary' | 'secondary'): void
      mode(enabled: boolean): void
      visibility(value: boolean): void
      focusOwnership(value: boolean): void
    }
  }
}

const remote = 'fixture/rich-text-vim'
const path = 'notes/acceptance.md'
const secondaryPath = 'notes/secondary.md'
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
  docs: [
    { path, kind: 'note', updatedAt: 'fixture' },
    { path: secondaryPath, kind: 'note', updatedAt: 'fixture' },
  ],
})

function editor(which: 'primary' | 'secondary' = 'primary'): Editor {
  const wrapper = document.querySelector(`[data-fixture-editor="${which}"]`)
  const element = wrapper?.querySelector('[role="textbox"]') as HTMLElement | null
  const value = element && (element as HTMLElement & { editor?: Editor }).editor
  if (!value) throw new Error('Production document editor is not mounted')
  return value
}

function App() {
  const [visible, setVisible] = useState({ primary: true, secondary: true })
  const [focused, setFocused] = useState<'primary' | 'secondary'>('primary')
  useEffect(() => {
    Object.assign(window, {
      richTextVimFixture: {
        initial,
        state(which: 'primary' | 'secondary' = 'primary') {
          const current = editor(which)
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
        setup(html: string, position: number, which: 'primary' | 'secondary' = 'primary') {
          const current = editor(which)
          current.commands.setContent(html)
          current.commands.setTextSelection(position)
          current.commands.focus()
        },
        atText(text: string, which: 'primary' | 'secondary' = 'primary') {
          const current = editor(which)
          let position: number | undefined
          current.state.doc.descendants((node, pos) => {
            if (position === undefined && node.isText) {
              const offset = node.text?.indexOf(text) ?? -1
              if (offset >= 0) position = pos + offset
            }
          })
          if (position === undefined) throw new Error(`Fixture text not found: ${text}`)
          current.commands.setTextSelection(position)
          current.commands.focus()
        },
        async flush() {
          await flushAllBuffers()
          return window.richTextVimIO.read(path)
        },
        async reload() {
          store.set(snapshotAtom, (snapshot) => ({
            ...snapshot,
            docs: snapshot.docs.map((doc) =>
              doc.path === path || doc.path === secondaryPath
                ? { ...doc, updatedAt: `${Date.now()}` }
                : doc,
            ),
          }))
        },
        async externalWrite(text: string) {
          await flushAllBuffers()
          await window.richTextVimIO.write(path, text)
          await window.richTextVimFixture.reload()
        },
        focus(which: 'primary' | 'secondary' = 'primary') {
          editor(which).commands.focus()
        },
        mode(enabled: boolean) {
          store.set(vimCodeEditingAtom, enabled)
        },
        visibility(value: boolean, which: 'primary' | 'secondary' = 'primary') {
          setVisible((current) => ({ ...current, [which]: value }))
        },
        focusOwnership(value: boolean, which: 'primary' | 'secondary' = 'primary') {
          setFocused(value ? which : which === 'primary' ? 'secondary' : 'primary')
        },
      },
    })
  })
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main className="flex h-screen flex-col gap-2 bg-background p-4 text-foreground">
          <header className="text-sm">Production DocumentView · disposable fixture</header>
          <section className="grid min-h-0 flex-1 grid-cols-2 gap-2">
            <section data-fixture-editor="primary" hidden={!visible.primary} className="min-h-0">
              <DocumentView
                path={path}
                onOpen={() => undefined}
                visible={visible.primary}
                focused={focused === 'primary'}
              />
            </section>
            <section
              data-fixture-editor="secondary"
              hidden={!visible.secondary}
              className="min-h-0"
            >
              <DocumentView
                path={secondaryPath}
                onOpen={() => undefined}
                visible={visible.secondary}
                focused={focused === 'secondary'}
              />
            </section>
          </section>
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
