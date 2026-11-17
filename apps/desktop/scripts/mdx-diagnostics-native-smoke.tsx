import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { lintGutter } from '@codemirror/lint'
import { useMdxDiagnostics } from '../src/renderer/src/features/files/use-mdx-diagnostics'
import './mdx-diagnostics-native-smoke.css'

const malformed = '# Café 🪿\n\n<Widget>\n'
const clean = '# Café 🪿\n\nA valid paragraph.\n'
const hostile = "import Evil from 'file:///etc/passwd'\n\n{globalThis.__mdxSmokeExecuted = true}\n"

function Smoke() {
  const host = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<EditorView | null>(null)
  const [source, setSource] = useState(malformed)
  const [trusted, setTrusted] = useState(false)
  const diagnostics = useMdxDiagnostics({
    view,
    remote: 'fixture/isolated-mdx',
    path: 'notes/fixture.mdx',
    context: 'fixture-context-507',
    trusted,
    visible: true,
  })

  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      state: EditorState.create({ doc: source, extensions: [lineNumbers(), lintGutter()] }),
      parent: host.current,
    })
    setView(editor)
    return () => editor.destroy()
    // Initial source is intentionally the initial document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } })
      diagnostics.sourceChanged(view, source)
    }
  }, [diagnostics, source, view])

  useEffect(() => {
    void window.holiSmoke.trust(trusted)
  }, [trusted])

  useEffect(() => {
    window.__mdxSmoke = {
      get source() {
        return view?.state.doc.toString() ?? ''
      },
      get state() {
        return diagnostics.state
      },
      setSource: (next) => setSource(next),
      setTrusted: (next) => setTrusted(next),
      retry: diagnostics.retry,
    }
  }, [diagnostics, view])

  return (
    <main>
      <header>
        <strong>MDX diagnostics native fixture</strong>
        <button onClick={() => setTrusted((value) => !value)}>
          {trusted ? 'Revoke trust' : 'Trust fixture'}
        </button>
        <button onClick={() => setSource(malformed)}>Malformed</button>
        <button onClick={() => setSource(clean)}>Clean</button>
        <button onClick={() => setSource(hostile)}>Hostile valid MDX</button>
      </header>
      <output data-testid="diagnostic-state">{diagnostics.state.kind}</output>
      <div ref={host} className="editor" />
      <pre data-testid="diagnostic-message">
        {diagnostics.state.kind === 'syntax-error'
          ? diagnostics.state.diagnostics.map((d) => d.message).join('\n')
          : ''}
      </pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Smoke />)

declare global {
  interface Window {
    __mdxSmoke?: {
      source: string
      state: unknown
      setSource(value: string): void
      setTrusted(value: boolean): void
      retry(): void
    }
  }
}
