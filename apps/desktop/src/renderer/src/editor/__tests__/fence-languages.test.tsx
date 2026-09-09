/**
 * The fence-language table. The interesting part is `fenceLanguageId` — the info
 * string a fence carries in the wild is not just a language name — and the fact
 * that every entry in the table actually resolves to a grammar (a typo in one of
 * the ~30 `legacy-modes` export names is a runtime `undefined`, not a type error,
 * because `StreamLanguage.define` takes anything shaped like a parser).
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { baseEditorExtensions } from '../extensions'
import { fenceLanguage, fenceLanguageId } from '../fence-languages'

let view: EditorView | null = null

/** The notes stack over a document, in a real (jsdom) view — highlighting is a
 *  render-time thing, so the assertion has to be against painted DOM. */
function mount(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: baseEditorExtensions({
        docExists: () => true,
        taskByPath: () => null,
        readNote: async () => null,
        mentionData: () => ({ notes: [], tasks: [] }),
        nav: () => ({ openNote: () => {}, openExternal: () => {} }),
        notePath: 'note.md',
        askAgent: () => {},
      }),
    }),
    parent,
  })
  return view
}

/**
 * Coloured spans inside the fence's **body**. CodeMirror generates its own class
 * names (`ͼ…`) from the HighlightStyle, so the assertion is "there are token
 * spans", not "this token is this colour".
 *
 * The ``` fences themselves are always two spans — markdown tags its own
 * `CodeMark` as `processingInstruction`, which the highlight style now colours
 * (that is the one overlap noted in `extensions.ts`). They are not the code, so
 * they do not count.
 *
 * Nor does `.cm-cell-code`. Markdown tags a fence's body `CodeText` with the same
 * `monospace` it gives inline code, and `markdownHighlightStyle` classes that for
 * TABLE CELLS, which is the only place the class is styled. A span saying
 * "markdown thinks this is code" is not a language token, and a fence with no
 * language still has exactly one of them: its whole body.
 */
function bodyTokenSpans(editor: EditorView): string[] {
  return [...editor.dom.querySelectorAll('.cm-code-line span')]
    .filter((el) => !el.classList.contains('cm-cell-code'))
    .map((el) => el.textContent ?? '')
    .filter((text) => !/^`+$/.test(text))
}

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('fenceLanguageId', () => {
  it('takes the bare name', () => {
    expect(fenceLanguageId('python')).toBe('python')
  })

  it('lowercases', () => {
    expect(fenceLanguageId('Python')).toBe('python')
    expect(fenceLanguageId('JSON')).toBe('json')
  })

  it('drops everything after the first word', () => {
    // The shapes real documents use: a title, a line-highlight range, knitr.
    expect(fenceLanguageId('js title="app.js"')).toBe('js')
    expect(fenceLanguageId('python {1,3}')).toBe('python')
    expect(fenceLanguageId('{r setup}')).toBe('r')
  })

  it('drops a leading dot', () => {
    expect(fenceLanguageId('.ts')).toBe('ts')
  })

  it('is empty for a bare fence', () => {
    expect(fenceLanguageId('')).toBe('')
    expect(fenceLanguageId('   ')).toBe('')
  })
})

describe('fenceLanguage', () => {
  it('is null for a bare fence, so it renders as it always did', () => {
    expect(fenceLanguage('')).toBeNull()
  })

  it('is null for a language we do not carry', () => {
    // Not an error — an unlisted language is the grey block, and adding it is a
    // line in the table.
    expect(fenceLanguage('brainfuck')).toBeNull()
  })

  it('resolves the language the bug was reported against', () => {
    expect(fenceLanguage('python')).not.toBeNull()
  })

  it('resolves through the info-string noise', () => {
    expect(fenceLanguage('js title="app.js"')).toBe(fenceLanguage('javascript'))
  })

  it('returns the same instance for the same language', () => {
    // Cached: a fence lookup runs on every parse of every note, and rebuilding a
    // StreamLanguage each time would also defeat CodeMirror's own parse caching.
    expect(fenceLanguage('python')).toBe(fenceLanguage('py'))
    expect(fenceLanguage('ts')).toBe(fenceLanguage('typescript'))
  })

  it('keeps the dialects apart', () => {
    expect(fenceLanguage('ts')).not.toBe(fenceLanguage('js'))
    expect(fenceLanguage('tsx')).not.toBe(fenceLanguage('ts'))
    expect(fenceLanguage('r')).not.toBe(fenceLanguage('ruby'))
  })

  it('resolves every name in the table', () => {
    // The one test that would catch a misspelled `legacy-modes` export: those are
    // plain objects, so `StreamLanguage.define(undefined)` fails at parse time in
    // a note, not at build time here.
    const names = [
      'javascript', 'js', 'mjs', 'cjs', 'node', 'jsx', 'typescript', 'ts', 'tsx',
      'html', 'htm', 'xml', 'svg', 'css', 'json', 'jsonc', 'json5', 'yaml', 'yml',
      'markdown', 'md', 'python', 'py', 'shell', 'sh', 'bash', 'zsh', 'console',
      'shell-session', 'sql', 'go', 'golang', 'rust', 'rs', 'ruby', 'rb', 'java',
      'c', 'c++', 'cpp', 'c#', 'csharp', 'cs', 'objc', 'kotlin', 'kt', 'scala',
      'swift', 'dart', 'groovy', 'clojure', 'erlang', 'haskell', 'hs', 'julia',
      'lua', 'perl', 'r', 'powershell', 'ps1', 'toml', 'ini', 'conf', 'env',
      'dotenv', 'properties', 'diff', 'patch', 'dockerfile', 'docker', 'cmake',
      'nginx', 'http', 'protobuf', 'proto', 'latex', 'tex',
    ]
    for (const name of names) {
      expect(fenceLanguage(name), name).not.toBeNull()
    }
  })
})

describe('a fence in the notes editor', () => {
  it('highlights the language the bug was reported against', () => {
    // The reported symptom, exactly: ```python rendered as one flat grey block.
    const editor = mount('# Note\n\n```python\ndef f(x):\n    return "hi"\n```\n')

    expect(bodyTokenSpans(editor)).toContain('def')
  })

  it('still has the grey block behind the tokens', () => {
    // The `.cm-code-line` background is what said "this is code" before, and it
    // is not what was wrong — highlighting is added over it, not instead of it.
    const editor = mount('```python\ndef f(): pass\n```\n')

    expect(editor.dom.querySelectorAll('.cm-code-line').length).toBeGreaterThan(0)
  })

  it('leaves a fence with no language alone', () => {
    const editor = mount('```\ndef f(x):\n    return 1\n```\n')

    expect(bodyTokenSpans(editor)).toEqual([])
  })
})
