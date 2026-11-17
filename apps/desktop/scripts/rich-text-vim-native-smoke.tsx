import { Provider, createStore } from 'jotai'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { activeRemoteAtom, snapshotAtom } from '../src/renderer/src/state/vaults'
import { vaultSettingsAtom } from '../src/renderer/src/state/settings'
import { emptyVaultSnapshot, resolveVaultSettings } from '@holi/shared'
import { DocumentView } from '../src/renderer/src/features/documents/document-view'
import {
  placeThreads,
  setCommentRanges,
} from '../src/renderer/src/features/documents/document-comments'
import { anchorAt, commentThreads, parseCommentsFile, type CommentThread } from '@holi/shared'
import { flushAllBuffers } from '../src/renderer/src/lib/buffer-registry'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { Toaster } from '../src/renderer/src/components/ui/sonner'
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
      leave(): Promise<{ left: boolean; error?: string }>
      leaveResult(): { left: boolean; error?: string } | null
      failNextWrite(): Promise<void>
      externalRead(text: string, updatedAt: string, hold?: boolean): Promise<void>
      releaseRead(): void
      placeComment(id: string, quote: string): { id: string; from: number; to: number } | null
      commentRange(id: string): { id: string; from: number; to: number; text: string } | null
      commentText(id: string): string | null
    }
  }
}

const remote = 'fixture/rich-text-vim'
const path = 'notes/acceptance.md'
const secondaryPath = 'notes/secondary.md'
const initial = `---\ntitle: Native Vim fixture\ntags: [kept]\n---\n\n# Heading\n\nalpha beta alpha\n\n**bold mark** and [link](https://example.test) plus [[Wiki note]]\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n- parent\n  - child\n- [ ] task\n\n1. ordered item\n\n| left | right |\n| --- | --- |\n| one | two |\n\n~~~mermaid\nA --> B\n~~~\n`
const store = createStore()
let lastLeaveResult: { left: boolean; error?: string } | null = null
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
  const [leaveError, setLeaveError] = useState<string | null>(null)
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
        async leave() {
          lastLeaveResult = null
          try {
            await flushAllBuffers()
            setVisible((current) => ({ ...current, primary: false }))
            setFocused('secondary')
            setLeaveError(null)
            lastLeaveResult = { left: true }
            return lastLeaveResult
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            setLeaveError(message)
            lastLeaveResult = { left: false, error: message }
            return lastLeaveResult
          }
        },
        leaveResult() {
          return lastLeaveResult
        },
        failNextWrite() {
          return window.richTextVimIO.call('fixture.failNextWrite', { path }).then(() => undefined)
        },
        async externalRead(text: string, updatedAt: string, hold = false) {
          await window.richTextVimIO.write(path, text)
          if (hold) await window.richTextVimIO.call('fixture.delayNextRead', { path })
          store.set(snapshotAtom, (snapshot) => ({
            ...snapshot,
            docs: snapshot.docs.map((doc) => (doc.path === path ? { ...doc, updatedAt } : doc)),
          }))
          if (hold) await window.richTextVimIO.call('fixture.waitForHeldRead', { path })
        },
        releaseRead() {
          void window.richTextVimIO.call('fixture.releaseRead', { path })
        },
        async placeComment(id: string, quote: string) {
          const current = editor()
          const markdown = current.getMarkdown()
          const from = markdown.indexOf(quote)
          if (from < 0) throw new Error(`Comment quote missing: ${quote}`)
          // This synthetic sidecar follows the production thread shape; placement and
          // transaction mapping both cross the production comments module.
          const thread: CommentThread = {
            id,
            anchor: anchorAt(markdown, from, from + quote.length),
            comments: [
              {
                id: 'comment-1',
                author: 'fixture',
                body: 'Review this passage',
                at: '2026-01-01T00:00:00.000Z',
              },
            ],
            status: null,
          }
          await window.richTextVimIO.call('comments.write', {
            path,
            text: JSON.stringify({ version: 1, threads: { [id]: thread } }),
          })
          const sidecar = parseCommentsFile(
            (await window.richTextVimIO.call('comments.read', { path })) as string,
          )
          if (!sidecar) throw new Error('Production comments bridge returned invalid sidecar data')
          const [loadedThread] = commentThreads(sidecar)
          if (!loadedThread) throw new Error('Synthetic sidecar thread did not deserialize')
          const [range] = placeThreads(current, '', [loadedThread])
          if (!range) return null
          setCommentRanges(current, { ranges: [range] })
          return range
        },
        commentRange(id: string) {
          const current = editor()
          const element = current.view.dom.querySelector<HTMLElement>(
            `[data-comment-thread="${CSS.escape(id)}"]`,
          )
          if (!element) return null
          const start = current.view.posAtDOM(element, 0)
          const end = current.view.posAtDOM(element, element.childNodes.length)
          return { id, from: start, to: end, text: element.textContent ?? '' }
        },
        commentText(id: string) {
          return id === 'thread-alpha' ? 'Review this passage' : null
        },
      },
    })
  })
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main
          className="flex h-screen flex-col gap-2 bg-background p-4 text-foreground"
          onFocusCapture={(event) => {
            const section = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-fixture-editor]',
            )
            if (
              section?.dataset.fixtureEditor === 'primary' ||
              section?.dataset.fixtureEditor === 'secondary'
            )
              setFocused(section.dataset.fixtureEditor)
          }}
        >
          <header className="text-sm">Production DocumentView · disposable fixture</header>
          <div className="flex gap-2">
            <button
              type="button"
              data-fixture-action="leave"
              onClick={() => void window.richTextVimFixture.leave()}
            >
              Switch away
            </button>
            <button
              type="button"
              data-fixture-action="retry"
              onClick={() => void window.richTextVimFixture.leave()}
            >
              Retry switch
            </button>
            {leaveError ? <span role="alert">{leaveError}</span> : null}
          </div>
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
          <Toaster />
        </main>
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
