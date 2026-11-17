import { Provider, createStore } from 'jotai'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { emptyVaultSnapshot } from '@holi/shared'
import { FileView } from '@/features/files/file-view'
import { activeRemoteAtom, openedRemoteAtom, snapshotAtom } from '@/state/vaults'
import { sessionAtom } from '@/state/session'
import { colorSchemeAtom } from '@/state/color-scheme'
import '../src/renderer/src/index.css'

const remote = 'fixture/isolated-mdx'
const path = 'notes/fixture.mdx'
const store = createStore()
store.set(activeRemoteAtom, remote)
store.set(openedRemoteAtom, remote)
store.set(sessionAtom, { login: 'fixture-user' })
store.set(snapshotAtom, {
  ...emptyVaultSnapshot(),
  files: [{ path, updatedAt: '1' }],
})

const errors: string[] = []
window.addEventListener('error', (event) => errors.push(event.message))
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)))

function Fixture() {
  useEffect(() => {
    Object.assign(window, {
      __mdxSmoke: {
        errors,
        editor() {
          const element = document.querySelector('.cm-editor') as HTMLElement | null
          const view = element ? EditorView.findFromDOM(element) : null
          if (!view) throw new Error('Production FileView CodeMirror is not mounted')
          return view
        },
        state() {
          return document.querySelector('[data-testid="diagnostic-state"]')?.textContent
        },
        source() {
          return this.editor().state.doc.toString()
        },
        setSource(text: string) {
          const view = this.editor()
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
        },
        theme(mode: 'light' | 'dark') {
          document.documentElement.dataset.theme = mode
          document.documentElement.classList.toggle('dark', mode === 'dark')
          store.set(colorSchemeAtom, mode)
        },
      },
    })
  }, [])
  return (
    <Provider store={store}>
      <FileView path={path} visible focused />
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)

declare global {
  interface Window {
    __mdxSmoke: {
      errors: string[]
      editor(): EditorView
      state(): string | null
      source(): string
      setSource(text: string): void
      theme(mode: 'light' | 'dark'): void
    }
  }
}
