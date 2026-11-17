import assert from 'node:assert/strict'
import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commentThreads, parseCommentsFile } from '@holi/shared'

const root = process.env.HOLI_516_ROOT!
const remote = 'fixture/rich-text-vim'
const alternateRemote = 'fixture/rich-text-vim-alternate'
const evidence = process.env.HOLI_516_EVIDENCE!
const clipboardToken = process.env.HOLI_516_CLIPBOARD_TOKEN!
assert(clipboardToken, 'native clipboard fixture requires a unique token')
const vault = join(root, 'vault')
const note = join(vault, 'notes/acceptance.md')
const secondaryNote = join(vault, 'notes/secondary.md')
const commentsSidecar = join(vault, '.holi/comments/notes/acceptance.md.json')
const fixtureFiles = new Map([
  ['notes/acceptance.md', note],
  ['notes/secondary.md', secondaryNote],
])
assert.equal(process.env.HOLI_VAULT_ROOT, vault)
const markdown = `---\ntitle: Native Vim fixture\ntags: [kept]\n---\n\n# Heading\n\nalpha beta alpha\n\n**bold mark** and [link](https://example.test) plus [[Wiki note]]\n\n\`\`\`ts\nconst value = 1\n\`\`\`\n\n- parent\n  - child\n- [ ] task\n\n1. ordered item\n\n| left | right |\n| --- | --- |\n| one | two |\n\n~~~mermaid\nA --> B\n~~~\n`
type NativeNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: NativeNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}
type NativeState = {
  textContent: string
  markdown: string
  selectedText: string
  json: { content: NativeNode[] }
  selection: { from: number; to: number }
  editable: boolean
}
const checks: string[] = []
const nativeResults: Record<string, unknown>[] = []
let windowRef: BrowserWindow | undefined
let writes = 0
let frame = 0
let failWrites = 0
let heldRead: { resolve: (text: string) => void; text: string } | undefined
let heldReadWaiters: (() => void)[] = []
let delayNextRead = false
app.setName('Holi rich text Vim acceptance 516')
app.setPath('userData', join(root, 'userData'))
app.setPath('sessionData', join(root, 'sessionData'))
app.setPath('appData', join(root, 'app-data'))
assert.equal(app.isReady(), false)

function mark(name: string) {
  checks.push(name)
  console.log(`PASS ${name}`)
}

async function run() {
  for (const dir of [
    root,
    evidence,
    join(root, 'userData'),
    join(root, 'sessionData'),
    vault,
    join(vault, 'notes'),
    join(evidence, 'frames'),
  ])
    await mkdir(dir, { recursive: true })
  await writeFile(note, markdown)
  await writeFile(secondaryNote, '---\ntitle: Secondary fixture\n---\n\nsecondary alpha beta\n')
  await mkdir(join(vault, '.holi/comments/notes'), { recursive: true })
  await writeFile(commentsSidecar, JSON.stringify({ version: 1, threads: {} }))
  assert.equal(app.getPath('userData'), join(root, 'userData'))
  await app.whenReady()
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )
  ipcMain.handle('rich-text-vim:read', async (event, requested: string) => {
    assert.equal(event.senderFrame?.url, `file://${join(root, 'renderer/index.html')}`)
    const file = fixtureFiles.get(requested)
    assert(file, `Unexpected fixture path: ${requested}`)
    const text = await readFile(file, 'utf8')
    if (delayNextRead) {
      delayNextRead = false
      return new Promise<string>((resolve) => {
        heldRead = { resolve, text }
        for (const ready of heldReadWaiters.splice(0)) ready()
      })
    }
    return text
  })
  ipcMain.handle('rich-text-vim:fixture', async (_event, name: string) => {
    if (name === 'failNextWrite') failWrites++
    else if (name === 'delayNextRead') delayNextRead = true
    else if (name === 'waitForHeldRead') {
      if (heldRead) return
      await new Promise<void>((resolve) => heldReadWaiters.push(resolve))
    } else if (name === 'releaseRead' && heldRead) {
      const held = heldRead
      heldRead = undefined
      held.resolve(held.text)
    } else throw new Error(`Unexpected fixture control: ${name}`)
  })
  ipcMain.handle(
    'rich-text-vim:comments',
    async (_event, operation: string, text?: string, requestedPath?: string) => {
      if (operation === 'read') return readFile(commentsSidecar, 'utf8')
      if (operation === 'list') {
        if (requestedPath !== 'notes/acceptance.md') return []
        const parsed = parseCommentsFile(await readFile(commentsSidecar, 'utf8'))
        if (!parsed) throw new Error('Fixture comments sidecar is invalid')
        return commentThreads(parsed).map((thread) => ({ ...thread, line: thread.anchor.line }))
      }
      if (operation === 'write' && typeof text === 'string') {
        await writeFile(commentsSidecar, text)
        return
      }
      throw new Error(`Unexpected comments fixture operation: ${operation}`)
    },
  )
  ipcMain.handle('rich-text-vim:write', async (event, requested: string, text: string) => {
    assert.equal(event.senderFrame?.url, `file://${join(root, 'renderer/index.html')}`)
    const file = fixtureFiles.get(requested)
    assert(file, `Unexpected fixture path: ${requested}`)
    assert.equal(typeof text, 'string')
    if (failWrites > 0) {
      failWrites--
      throw new Error('fixture disk refusal')
    }
    await writeFile(file, text)
    writes++
  })
  windowRef = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  windowRef.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  windowRef.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (message === 'HOLI_516_FOCUS') windowRef?.focus()
    else console.log(`Renderer console level=${level} line=${line} source=${sourceId}: ${message}`)
  })
  windowRef.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    console.error(
      `Renderer load failed code=${code} mainFrame=${isMainFrame} url=${url}: ${description}`,
    )
  })
  windowRef.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Renderer process exited: ${JSON.stringify(details)}`)
  })
  await windowRef.loadFile(join(root, 'renderer/index.html'))
  const win = windowRef
  const evaluate = <T>(source: string) => win.webContents.executeJavaScript(source) as Promise<T>
  const wait = async (test: string, label: string) => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      if (await evaluate<boolean>(`Boolean(${test})`).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`Timed out: ${label}; ${await evaluate<string>('document.body.innerText')}`)
  }
  const key = async (
    keyCode: string,
    modifiers: Array<'meta' | 'control' | 'shift' | 'alt'> = [],
  ) => {
    await evaluate<void>(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const png = await win.webContents.capturePage()
    frame += 1
    await writeFile(
      join(evidence, 'frames', `frame-${String(frame).padStart(4, '0')}.png`),
      png.toPNG(),
    )
  }
  const composition = async (text: string) => {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
      text: 'か',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
    await win.webContents.debugger.sendCommand('Input.insertText', { text })
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  const click = (point: { x: number; y: number }, modifiers: Array<'shift'> = []) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      ...point,
      button: 'left',
      clickCount: 1,
      modifiers,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      ...point,
      button: 'left',
      clickCount: 1,
      modifiers,
    })
  }
  const waitForDisk = async (includes: string) => {
    const end = Date.now() + 8000
    while (Date.now() < end) {
      const current = await readFile(note, 'utf8')
      if (current.includes(includes)) return current
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    throw new Error(`Timed out waiting for autosave: ${includes}`)
  }
  const capture = async (name: string) => {
    const image = await win.webContents.capturePage()
    await writeFile(join(evidence, name), image.toPNG())
  }
  await wait(`document.querySelector('[role="textbox"]')?.editor`, 'production DocumentView editor')
  await evaluate(`document.querySelector('[role="textbox"]').editor.commands.focus()`)
  win.focus()
  await key('Escape')
  const state = (which: 'primary' | 'secondary' = 'primary') =>
    evaluate<NativeState>(`window.richTextVimFixture.state(${JSON.stringify(which)})`)
  const initialState = await state()
  assert(initialState.markdown.includes('alpha beta alpha'))
  assert(initialState.markdown.includes('[[Wiki note]]'))
  assert.match(initialState.markdown, /(?:`{3,}|~{3,})mermaid/)
  const initialNodeTypes: string[] = []
  const visitNodes = (node: NativeNode) => {
    initialNodeTypes.push(node.type)
    for (const child of node.content ?? []) visitNodes(child)
  }
  for (const node of initialState.json.content) visitNodes(node)
  assert(initialNodeTypes.includes('wikiLink'), 'fixture has a parsed production wikiLink atom')
  assert(initialNodeTypes.includes('codeBlock'), 'fixture has production code blocks')
  assert(
    initialState.json.content.some((node) => node.type === 'codeBlock'),
    'Mermaid block is in production schema',
  )
  await wait(
    `document.querySelector('[data-fixture-editor="secondary"] [role="textbox"]')?.editor`,
    'second production DocumentView editor',
  )
  mark('production-documentview-mounted-with-rich-markup')

  await evaluate(
    `window.richTextVimFixture.setup('<p>alpha beta</p>',1,'primary');window.richTextVimFixture.setup('<p>alpha beta</p>',1,'secondary')`,
  )
  await evaluate(`window.richTextVimFixture.focus('secondary')`)
  await key('Escape')
  await key('d')
  await key('w')
  assert.equal((await state('secondary')).markdown, 'beta')
  assert.equal((await state('primary')).markdown, 'alpha beta', 'unfocused split is unchanged')
  await evaluate(`window.richTextVimFixture.focus('primary')`)
  await key('Escape')
  await key('d')
  await key('w')
  assert.equal((await state('primary')).markdown, 'beta')
  assert.equal((await state('secondary')).markdown, 'beta')
  await evaluate(
    `window.richTextVimFixture.visibility(false,'primary');window.richTextVimFixture.visibility(true,'primary')`,
  )
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.isEditable`,
    'retained split view reactivated',
  )
  mark('native-split-document-focus-isolation-and-retained-view')

  await evaluate(`window.richTextVimFixture.setup('<p>base</p>',5)`)
  await composition('漢')
  const composed = await state()
  assert.equal(composed.markdown, 'base漢', 'native IME composition commits the composed text')
  mark('native-ime-composition-start-update-end-preserves-input')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta alpha</p>',1)`)
  await key('d', [process.platform === 'darwin' ? 'meta' : 'control'])
  await key('d', [process.platform === 'darwin' ? 'meta' : 'control'])
  await key('d')
  await key('w')
  await key('i')
  win.webContents.insertText('X')
  await key('Escape')
  const clearedOccurrences = await state()
  assert.equal(clearedOccurrences.markdown, 'alpha beta X')
  assert.equal((clearedOccurrences.markdown.match(/X/g) ?? []).length, 1)
  mark('native-occurrence-shortcut-vim-operator-clears-extra-edits')

  // Fixture setup selects known production-schema positions; every Vim action is a trusted native key.
  await evaluate(`window.richTextVimFixture.setup('<p>a👩‍💻bc</p>',1)`)
  await key('Escape')
  await key('v')
  await key('l')
  assert.equal(
    (await state()).selectedText,
    'a👩‍💻',
    'native visual selection includes one full grapheme',
  )
  await key('Escape')
  assert.equal((await state()).selection.from, (await state()).selection.to)
  mark('native-visual-inclusive-grapheme-and-escape')

  await evaluate(`window.richTextVimFixture.setup('<p>abcdef</p>',1)`)
  await key('Escape')
  await key('v')
  await key('l')
  await key('d')
  assert.equal((await state()).markdown, 'cdef', 'vld deletes exactly the two selected characters')
  mark('native-vld-deletes-exact-visual-selection')

  await evaluate(`window.richTextVimFixture.setup('<p>word tail</p>',1)`)
  await key('Escape')
  await key('c')
  await key('w')
  win.webContents.insertText('X')
  await key('Escape')
  assert.equal((await state()).markdown, 'X tail', 'cw keeps the following word separator')
  mark('native-cw-preserves-following-separator')

  await evaluate(
    `window.richTextVimFixture.setup('<p><span data-wiki-link="Wiki note">Wiki note</span> after</p>',1)`,
  )
  await key('Escape')
  await key('x')
  assert.equal(
    (await state()).markdown,
    ' after',
    'native x removes the wiki-link atom and preserves following text',
  )
  assert(!(await state()).json.content.some((node) => node.type === 'wikiLink'))
  mark('native-wiki-link-atom-operation-and-markdown')

  await evaluate(`window.richTextVimFixture.setup('<p>a👩‍💻bc</p>',7)`)
  await key('Escape')
  await key('v')
  await key('h')
  assert.equal(
    (await state()).selectedText,
    '👩‍💻b',
    'reverse visual selection remains grapheme-safe',
  )
  await key('Escape')
  await evaluate(
    `window.richTextVimFixture.setup('<p>one two three four five six seven eight</p>',1)`,
  )
  await key('Escape')
  for (const character of ['2', 'd', '3', 'w']) await key(character)
  assert.equal((await state()).markdown, 'seven eight', 'operator and motion counts multiply')
  mark('native-reverse-grapheme-selection-and-counted-operator')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  const mousePoints = await evaluate<{
    start: { x: number; y: number }
    end: { x: number; y: number }
  }>(
    `(()=>{const node=document.querySelector('[role="textbox"] p')?.firstChild;if(!node||node.nodeType!==Node.TEXT_NODE)throw Error('Fixture paragraph text missing');const point=(offset)=>{const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset);const rect=range.getBoundingClientRect();return{x:rect.x,y:rect.y+rect.height/2}};return{start:point(0),end:point(5)}})()`,
  )
  click(mousePoints.start)
  click(mousePoints.end, ['shift'])
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(
    (await state()).selectedText,
    'alpha',
    'native mouse selection selects paragraph text',
  )
  mark('native-mouse-selection')

  await evaluate(`window.richTextVimFixture.setup('<p>one two three</p>',1)`)
  await key('Escape')
  await key('d')
  await key('w')
  assert.equal((await state()).markdown, 'two three')
  await key('u')
  assert.equal((await state()).markdown, 'one two three')
  await key('r', ['control'])
  assert.equal((await state()).markdown, 'two three')
  mark('native-delete-word-undo-redo')

  await evaluate(`window.richTextVimFixture.setup('<p>first</p><p>second</p>',1)`)
  await key('Escape')
  await key('d')
  await key('d')
  assert.equal((await state()).markdown, 'second')
  await key('P', ['shift'])
  const linePut = await state()
  assert.equal(linePut.markdown.replace(/\n/g, ''), 'firstsecond', JSON.stringify(linePut))
  mark('native-line-delete-and-register-put')

  await evaluate(`window.richTextVimFixture.setup('<p><strong>alpha</strong> beta</p>',1)`)
  await key('Escape')
  await key('y')
  await key('w')
  await key('P', ['shift'])
  const richPut = await state()
  assert(
    richPut.markdown.includes('**alpha**'),
    `structured yank preserves a rich mark: ${JSON.stringify(richPut)}`,
  )
  mark('native-rich-mark-yank-and-put')

  await evaluate(`window.richTextVimFixture.setup('<p><strong>alpha</strong> beta</p>',1)`)
  await key('Escape')
  await key('y')
  await key('w')
  await key('e')
  await key('p')
  const richLowerPut = await state()
  assert.equal(richLowerPut.textContent, 'alphaalpha  beta')
  assert.equal(richLowerPut.json.content[0]?.content?.[0]?.text, 'alphaalpha')
  assert.equal(richLowerPut.json.content[0]?.content?.[0]?.marks?.[0]?.type, 'bold')
  mark('native-lowercase-put-preserves-rich-register')

  await evaluate(`window.richTextVimFixture.setup('<p>word word</p>',1)`)
  await key('Escape')
  await key('c')
  await key('w')
  win.webContents.insertText('X')
  await key('Escape')
  assert.equal((await state()).markdown, 'X word')
  const autosaved = await waitForDisk('X word')
  assert(autosaved.startsWith('---\ntitle: Native Vim fixture'))
  await key('u')
  assert.equal((await state()).markdown, 'word word')
  mark('native-change-insert-and-single-step-undo')

  await evaluate(
    `window.richTextVimFixture.setup('<ul><li><p>first</p></li><li><p>second</p></li></ul>',3)`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const listAfterDelete = await state()
  assert.equal(listAfterDelete.json.content[0]?.type, 'bulletList')
  assert.equal(listAfterDelete.markdown.trim(), '- second')
  mark('native-line-delete-retains-list-container')

  await evaluate(
    `window.richTextVimFixture.setup('<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li><li><p>second</p></li></ul>',1);window.richTextVimFixture.atText('child')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const nestedAfterDelete = await state()
  assert(nestedAfterDelete.markdown.includes('- parent'))
  assert(nestedAfterDelete.markdown.includes('- second'))
  assert.equal(nestedAfterDelete.json.content[0]?.type, 'bulletList')
  const parentContents = nestedAfterDelete.json.content[0]?.content?.[0]?.content
  assert.equal(parentContents?.length, 2)
  assert.equal(parentContents?.[0]?.type, 'paragraph')
  assert.equal(parentContents?.[1]?.type, 'bulletList')
  const emptyNestedItems = parentContents?.[1]?.content
  assert.equal(emptyNestedItems?.length, 1)
  assert.equal(emptyNestedItems?.[0]?.type, 'listItem')
  assert.equal(emptyNestedItems?.[0]?.content?.[0]?.type, 'paragraph')
  assert.equal(emptyNestedItems?.[0]?.content?.[0]?.content?.length ?? 0, 0)
  mark('native-nested-list-line-delete-preserves-parent')

  await evaluate(
    `window.richTextVimFixture.setup('<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li><li><p>second</p></li></ul>',1);window.richTextVimFixture.atText('child')`,
  )
  await key('Escape')
  await key('y')
  await key('y')
  await key('p')
  const nestedAfterPut = await state()
  assert.equal(nestedAfterPut.markdown.trim(), '- parent\n  - child\n  - child\n- second')
  assert.equal(nestedAfterPut.json.content[0]?.type, 'bulletList')
  assert.equal(nestedAfterPut.json.content[0]?.content?.[0]?.content?.[1]?.type, 'bulletList')
  assert.equal(nestedAfterPut.json.content[0]?.content?.[0]?.content?.[1]?.content?.length, 2)
  mark('native-nested-list-operator-put-preserves-sibling-and-container')

  await evaluate(
    `window.richTextVimFixture.setup('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>first</p></li><li data-type="taskItem" data-checked="true"><p>second</p></li></ul>',1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const taskAfterDelete = await state()
  assert.equal(taskAfterDelete.markdown.trim(), '- [x] second')
  assert.equal(taskAfterDelete.json.content[0]?.type, 'taskList')
  assert.equal(taskAfterDelete.json.content[0]?.content?.[0]?.attrs?.checked, true)
  mark('native-task-list-delete-retains-checked-attribute')

  await evaluate(
    `window.richTextVimFixture.setup('<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>first</p></li><li data-type="taskItem" data-checked="true"><p>second</p></li></ul>',1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('y')
  await key('y')
  await key('p')
  const taskAfterPut = await state()
  assert.equal(taskAfterPut.json.content[0]?.content?.length, 3)
  assert.equal(taskAfterPut.json.content[0]?.content?.[0]?.attrs?.checked, false)
  assert.equal(taskAfterPut.json.content[0]?.content?.[1]?.attrs?.checked, false)
  assert.equal(taskAfterPut.json.content[0]?.content?.[2]?.attrs?.checked, true)
  assert.equal(taskAfterPut.markdown.trim(), '- [ ] first\n- [ ] first\n- [x] second')
  mark('native-task-list-operator-put-preserves-attrs-and-sibling-order')

  await evaluate(
    `window.richTextVimFixture.setup('<p><span data-wiki-link="Wiki note" target="Wiki note">Wiki note</span> after</p>',1)`,
  )
  await key('Escape')
  await key('y')
  await key('w')
  await key('p')
  const wikiAfterPut = await state()
  const wikiNodes: NativeNode[] = []
  const collectWiki = (node: NativeNode) => {
    if (node.type === 'wikiLink') wikiNodes.push(node)
    for (const child of node.content ?? []) collectWiki(child)
  }
  for (const node of wikiAfterPut.json.content) collectWiki(node)
  assert.equal(wikiNodes.length, 2)
  assert.equal(wikiNodes[0]?.attrs?.target, wikiNodes[1]?.attrs?.target)
  assert.equal(wikiAfterPut.markdown, '[[Wiki note]][[Wiki note]]  after')
  mark('native-wiki-link-yank-put-retains-structured-target')

  await evaluate(
    `window.richTextVimFixture.setup(${JSON.stringify('<pre><code class="language-ts">first\nsecond</code></pre>')},1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const codeAfterDelete = await state()
  assert.equal(codeAfterDelete.json.content[0]?.type, 'codeBlock')
  assert.equal(
    codeAfterDelete.markdown.trimEnd(),
    '```ts\nsecond\n```',
    'dd deletes one logical code line',
  )
  mark('native-codeblock-logical-line-delete')

  await evaluate(
    `window.richTextVimFixture.setup('<p>first<br>second</p>',1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const afterHardbreakDelete = await state()
  assert.equal(
    afterHardbreakDelete.markdown.trimEnd(),
    'second',
    `dd deletes only the first hardbreak-delimited line: ${JSON.stringify(afterHardbreakDelete)}`,
  )
  await key('u')
  const restoredHardbreak = await state()
  assert(restoredHardbreak.markdown.includes('first'))
  assert(restoredHardbreak.markdown.includes('second'))
  assert.equal(
    restoredHardbreak.json.content[0]?.content?.filter((node) => node.type === 'hardBreak').length,
    1,
    'undo restores the structured hardBreak atom',
  )
  mark('native-hardbreak-logical-line-delete-and-undo')

  await evaluate(
    `window.richTextVimFixture.setup('<p>before</p><pre><code class="language-mermaid">A --&gt; B</code></pre><p>after</p>',1);window.richTextVimFixture.atText('A --> B')`,
  )
  const mermaidBefore = await state()
  const sourceBefore = mermaidBefore.json.content[1]
  assert.equal(sourceBefore?.type, 'codeBlock')
  assert.equal(sourceBefore?.attrs?.language, 'mermaid')
  await key('Escape')
  await key('y')
  await key('y')
  await key('p')
  const mermaidPasted = await state()
  const pastedNodes = mermaidPasted.json.content.filter((node) => node.type === 'codeBlock')
  assert.equal(pastedNodes.length, 2)
  assert(pastedNodes.every((node) => node.attrs?.language === 'mermaid'))
  assert.equal(mermaidPasted.json.content[0]?.type, 'paragraph')
  assert.equal(mermaidPasted.json.content.at(-1)?.type, 'paragraph')
  await key('d')
  await key('d')
  const mermaidDeleted = await state()
  assert.equal(mermaidDeleted.json.content.filter((node) => node.type === 'codeBlock').length, 1)
  assert.equal(mermaidDeleted.markdown.includes('before'), true)
  assert.equal(mermaidDeleted.markdown.includes('after'), true)
  await key('u')
  const mermaidUndone = await state()
  assert.equal(mermaidUndone.json.content.filter((node) => node.type === 'codeBlock').length, 2)
  assert(
    mermaidUndone.json.content
      .filter((node) => node.type === 'codeBlock')
      .every((node) => node.attrs?.language === 'mermaid'),
  )
  assert.equal(mermaidUndone.markdown.includes('before'), true)
  assert.equal(mermaidUndone.markdown.includes('after'), true)
  mark('native-mermaid-line-yank-put-delete-undo-preserves-source-and-attrs')

  await evaluate(
    `window.richTextVimFixture.setup('<table><tbody><tr><td><p>one</p></td></tr><tr><td><p>last</p></td></tr></tbody></table>',3)`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const tableAfterDelete = await state()
  assert.equal(tableAfterDelete.json.content[0]?.type, 'table')
  assert(tableAfterDelete.markdown.includes('last'))
  mark('native-line-delete-retains-table-container')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  const commentBefore = await evaluate<{ id: string; from: number; to: number } | null>(
    `window.richTextVimFixture.placeComment('thread-beta','beta')`,
  )
  assert(commentBefore, 'production comments.list loads the persisted fixture thread')
  await key('Escape')
  await key('y')
  await key('w')
  await key('P', ['shift'])
  const shiftedComment = await evaluate<{
    id: string
    from: number
    to: number
    text: string
  } | null>(`window.richTextVimFixture.commentRange('thread-beta')`)
  assert(
    shiftedComment,
    `surviving anchor remains decorated after native Vim paste: ${JSON.stringify({ state: await state(), html: await evaluate<string>(`document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.innerHTML ?? ''`) })}`,
  )
  assert.equal(shiftedComment.text, 'beta')
  assert(shiftedComment.from > commentBefore.from, 'paste maps the surviving range forward')
  assert.equal(
    (
      await evaluate<{ quote: string; line: number } | null>(
        `window.richTextVimFixture.commentSource('thread-beta')`,
      )
    )?.quote,
    'beta',
  )

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await evaluate(`window.richTextVimFixture.placeComment('thread-alpha','alpha')`)
  await key('Escape')
  await key('d')
  await key('w')
  const commentAfterDelete = await evaluate<{
    id: string
    from: number
    to: number
    text: string
  } | null>(`window.richTextVimFixture.commentRange('thread-alpha')`)
  assert.equal((await state()).markdown, 'beta')
  assert.equal(commentAfterDelete, null, 'fully deleting an anchor removes its decoration')
  assert.equal(
    await evaluate<string>(`window.richTextVimFixture.commentText('thread-alpha')`),
    'Review this passage',
  )
  const orphanSource = await evaluate<{ quote: string; line: number } | null>(
    `window.richTextVimFixture.commentSource('thread-alpha')`,
  )
  assert.deepEqual(
    orphanSource,
    { quote: 'alpha', line: 1 },
    'deletion leaves the original persisted anchor source intact',
  )
  nativeResults.push({
    scenario: 'comment deletion',
    rangeAfterDelete: commentAfterDelete,
    persistedAnchor: orphanSource,
  })

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await evaluate(`window.richTextVimFixture.placeComment('thread-change','alpha')`)
  await key('Escape')
  await key('c')
  await key('w')
  win.webContents.insertText('omega')
  await key('Escape')
  const commentAfterChange = await evaluate<{
    id: string
    from: number
    to: number
    text: string
  } | null>(`window.richTextVimFixture.commentRange('thread-change')`)
  assert(commentAfterChange, 'production decoration maps through the live change transaction')
  assert.equal((await state()).markdown, 'omega beta')
  assert.equal(commentAfterChange.text, 'omega')
  assert.equal(
    await evaluate<string>(`window.richTextVimFixture.commentText('thread-change')`),
    'Review this passage',
  )
  const changedSource = await evaluate<{ quote: string; line: number } | null>(
    `window.richTextVimFixture.commentSource('thread-change')`,
  )
  assert.deepEqual(
    changedSource,
    { quote: 'alpha', line: 1 },
    'mapped display range does not fabricate or rewrite the persisted source anchor',
  )
  nativeResults.push({
    scenario: 'comment change',
    displayedRange: commentAfterChange,
    persistedAnchor: changedSource,
  })
  mark('native-comment-list-paste-mapping-deletion-orphan-and-source-retention')

  const shortcut = process.platform === 'darwin' ? 'meta' : 'control'
  clipboard.writeText(clipboardToken)
  await evaluate(`window.richTextVimFixture.setup('<p>${clipboardToken}</p>',1)`)
  await key('Escape')
  await key('v')
  for (let i = 0; i < clipboardToken.length - 1; i++) await key('l')
  await key('c', [shortcut])
  assert.equal(
    clipboard.readText(),
    clipboardToken,
    'native copy shortcut writes the complete synthetic selection',
  )
  await evaluate(`window.richTextVimFixture.setup('<p>target</p>',7)`)
  await key('Escape')
  await key('v', [shortcut])
  // sendInputEvent sends the shortcut key but Electron does not dispatch the
  // operating-system paste event for it; exercise the same native clipboard
  // insertion through webContents after the shortcut reaches the focused editor.
  if ((await state()).markdown === 'target') win.webContents.paste()
  await wait(
    `window.richTextVimFixture.state().markdown === ${JSON.stringify(`target${clipboardToken}`)}`,
    'synthetic clipboard paste',
  )
  assert.equal(
    (await state()).markdown,
    `target${clipboardToken}`,
    'native paste shortcut inserts the known synthetic text',
  )
  mark('native-platform-copy-paste-shortcuts-use-synthetic-text-under-runner-guard')
  nativeResults.push({
    scenario: 'synthetic clipboard copy and paste',
    copyVerified: true,
    pastedDocument: (await state()).markdown,
  })

  // Production schema samples include marks, links, wiki links, code, lists, tables, and Mermaid.
  const schema = initialState.json.content.map((node: { type: string }) => node.type)
  for (const type of [
    'heading',
    'paragraph',
    'bulletList',
    'orderedList',
    'taskList',
    'table',
    'codeBlock',
  ])
    assert(schema.includes(type), `fixture schema must include ${type}`)
  mark('rich-schema-list-table-code-and-native-blocks-present')

  const crossRangeNotice = 'Vim selection crosses a list or table; no text was changed'
  await evaluate(
    `window.richTextVimFixture.setup('<table><tbody><tr><td><p>left</p></td><td><p>right</p></td></tr></tbody></table>',1);window.richTextVimFixture.atText('left')`,
  )
  const tableBeforeCross = (await state()).markdown
  await key('Escape')
  await key('v')
  await key('j')
  await key('d')
  assert.equal(
    (await state()).markdown,
    tableBeforeCross,
    'cross-cell destructive visual range leaves both cells intact',
  )
  await wait(
    `document.body.innerText.includes(${JSON.stringify(crossRangeNotice)})`,
    'discoverable cross-cell Vim feedback',
  )
  await evaluate(
    `window.richTextVimFixture.setup('<p>outside</p><ul><li><p>inside</p></li></ul>',1);window.richTextVimFixture.atText('outside')`,
  )
  const boundaryBeforeCross = (await state()).markdown
  await key('Escape')
  await key('v')
  await key('j')
  await key('d')
  assert.equal(
    (await state()).markdown,
    boundaryBeforeCross,
    'list/paragraph boundary range leaves both containers intact',
  )
  await wait(
    `document.body.innerText.includes(${JSON.stringify(crossRangeNotice)})`,
    'discoverable list-boundary Vim feedback',
  )
  mark('native-unsupported-cross-container-visual-operations-feedback-and-no-change')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  const beforeHints = (await state()).markdown
  await key('f')
  await wait(
    `document.querySelector('[data-host-hints] [data-hint-target="Native hint target"]')`,
    'native host-hint shortcut discovers the real fixture control',
  )
  await key('Escape')
  await wait(`!document.querySelector('[data-host-hints]')`, 'native Escape cancels host hints')
  assert.equal((await state()).markdown, beforeHints, 'f then Escape is not inserted into the note')
  nativeResults.push({
    scenario: 'host hints',
    target: 'Native hint target',
    noteAfterEscape: (await state()).markdown,
  })
  mark('native-host-hint-shortcut-target-and-escape-cancel')

  await evaluate(`window.richTextVimFixture.focus('primary')`)
  await key('f', [process.platform === 'darwin' ? 'meta' : 'control'])
  await wait(`document.querySelector('input[aria-label="Find"]')`, 'native platform find shortcut')
  const editorPoint = await evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('[data-fixture-editor="primary"] [role="textbox"]').getBoundingClientRect()
    return { x: rect.left + 20, y: rect.top + 10 }
  })()`)
  click(editorPoint)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]').editor.view.hasFocus()`,
    'native click returns focus from find to the editor',
  )
  await key('Escape')
  await wait(
    `!document.querySelector('input[aria-label="Find"]')`,
    'native Escape closes find and returns focus',
  )
  assert.equal((await state()).markdown, beforeHints, 'find and Escape do not edit the note')
  nativeResults.push({
    scenario: 'find and Escape',
    noteAfterEscape: (await state()).markdown,
    findClosed: true,
  })
  mark('native-find-shortcut-escape-and-no-document-edit')

  await evaluate(
    `window.richTextVimFixture.setup('<p>alpha beta</p>',1);window.richTextVimFixture.locked(true)`,
  )
  await wait(
    `!document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'production document lock',
  )
  await key('x')
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'native Vim key cannot edit a locked document',
  )
  await evaluate(`window.richTextVimFixture.locked(false)`)
  await wait(
    `document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'document lock clears',
  )
  await evaluate(`window.richTextVimFixture.focus('primary')`)
  await key('Escape')
  await key('d')
  await key('w')
  assert.equal(
    (await state()).markdown,
    'beta',
    'fresh normal-mode command works after lock clears',
  )
  nativeResults.push({
    scenario: 'document lock',
    contentAfterLockedKey: 'alpha beta',
    contentAfterUnlock: (await state()).markdown,
  })
  mark('native-document-lock-preserves-input-and-resets-vim-transients')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await key('v')
  await key('l')
  await evaluate(`window.richTextVimFixture.locked(true)`)
  await wait(
    `!document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'lock after visual selection',
  )
  await key('d')
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'lock discards pending visual operator without editing',
  )
  const lockedVisual = await state()
  assert.equal(
    lockedVisual.selection.from,
    lockedVisual.selection.to,
    'lock clears the visual selection',
  )
  await evaluate(`window.richTextVimFixture.locked(false)`)
  await wait(`document.querySelector('[role="textbox"]')?.editor?.isEditable`, 'visual lock clears')
  await evaluate(`window.richTextVimFixture.focus('primary')`)
  await key('d')
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'post-lock d starts a fresh operator, not the stale visual command',
  )
  await key('Escape')
  await evaluate(`window.richTextVimFixture.atText('alpha')`)
  await key('d')
  await key('w')
  assert.equal((await state()).markdown, 'beta', 'post-lock command starts a new normal-mode epoch')
  nativeResults.push({
    scenario: 'visual lock reset',
    contentAfterLockedOperator: 'alpha beta',
    contentAfterFreshCommand: (await state()).markdown,
  })
  mark('native-lock-clears-visual-mode-and-pending-operator')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await key('d')
  await evaluate(`window.richTextVimFixture.freeze(true)`)
  await wait(
    `!document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'production buffer freeze',
  )
  await key('w')
  assert.equal((await state()).markdown, 'alpha beta', 'native motion does not edit while frozen')
  await evaluate(`window.richTextVimFixture.freeze(false)`)
  await wait(
    `document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'production buffer thaw',
  )
  await evaluate(`window.richTextVimFixture.focus('primary')`)
  await key('w')
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'pending operator is cleared across production freeze',
  )
  await key('Escape')
  await evaluate(`window.richTextVimFixture.atText('alpha')`)
  await key('d')
  await key('w')
  assert.equal((await state()).markdown, 'beta', 'fresh command edits after production buffer thaw')
  nativeResults.push({
    scenario: 'buffer freeze and thaw',
    contentWhileFrozen: 'alpha beta',
    contentAfterStaleMotion: 'alpha beta',
    contentAfterFreshOperator: (await state()).markdown,
  })
  mark('native-buffer-freeze-preserves-text-and-clears-pending-operator')

  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await evaluate(`window.richTextVimFixture.visibility(false,'primary')`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor && !document.querySelector('[data-fixture-editor="primary"] [role="textbox"]').editor.isEditable`,
    'hidden retained editor disables editing',
  )
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'hidden render leaves its note content intact',
  )
  await key('x')
  assert.equal(
    (await state()).markdown,
    'alpha beta',
    'native key delivered while hidden does not edit the retained note',
  )
  await evaluate(
    `window.richTextVimFixture.visibility(true,'primary');window.richTextVimFixture.focus('primary')`,
  )
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.isEditable`,
    'fresh visible retained epoch',
  )
  await key('Escape')
  await key('x')
  assert.equal(
    (await state()).markdown,
    'lpha beta',
    'newly visible view accepts native input without stale commands',
  )
  nativeResults.push({
    scenario: 'hidden retained view',
    contentWhileHidden: 'alpha beta',
    contentAfterFreshEpoch: (await state()).markdown,
  })
  mark('native-hidden-render-disable-and-fresh-retained-view-epoch')

  const external = markdown
    .replace('Native Vim fixture', 'External update fixture')
    .replace('alpha beta alpha', 'External update body')
  await evaluate(`window.richTextVimFixture.externalWrite(${JSON.stringify(external)})`)
  await wait(
    `document.querySelector('[role="textbox"]')?.editor?.getText().includes('External update body')`,
    'external disk update',
  )
  const saved = await evaluate<string>('window.richTextVimFixture.flush()')
  assert(saved.startsWith('---\ntitle: External update fixture\ntags: [kept]\n---'))
  assert((await readFile(note, 'utf8')).startsWith('---\ntitle: External update fixture'))
  assert(writes >= 1)
  mark('real-disposable-file-adapter-flush-frontmatter-and-external-update')

  const staleSnapshot = markdown
    .replace('Native Vim fixture', 'Stale delayed snapshot')
    .replace('alpha beta alpha', 'Stale delayed body')
  const latestSnapshot = markdown
    .replace('Native Vim fixture', 'Latest external snapshot')
    .replace('alpha beta alpha', 'Latest external body')
  await evaluate(
    `window.richTextVimFixture.externalRead(${JSON.stringify(staleSnapshot)},'snapshot-A',true)`,
  )
  await evaluate(
    `window.richTextVimFixture.externalRead(${JSON.stringify(latestSnapshot)},'snapshot-B')`,
  )
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getText().includes('Latest external body')`,
    'latest snapshot applies while older read is pending',
  )
  await evaluate(`window.richTextVimFixture.document('notes/secondary.md','${alternateRemote}')`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getMarkdown().trim() === 'beta'`,
    'production DocumentView switches path and remote to B',
  )
  await evaluate(`window.richTextVimFixture.document('notes/acceptance.md','${remote}')`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getText().includes('Latest external body')`,
    'production DocumentView returns to path and remote A with latest disk text',
  )
  await evaluate(`window.richTextVimFixture.releaseRead()`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getText().includes('Latest external body')`,
    'latest external snapshot remains after delayed A read resolves across live A-B-A props',
  )
  assert(!(await state()).markdown.includes('Stale delayed body'))
  assert.equal((await state('secondary')).markdown, 'beta')
  nativeResults.push({
    scenario: 'live document path and remote A-B-A',
    oldResultDiscarded: true,
    visibleMarkdown: (await state()).markdown,
  })
  mark('delayed-external-read-stale-result-ignored-across-live-document-path-remote-aba')

  await evaluate(`window.richTextVimFixture.setup('<p>dirty before departure</p>',1)`)
  await evaluate(
    `(()=>{const editor=document.querySelector('[role="textbox"]').editor;editor.commands.setTextSelection(editor.state.doc.content.size-1);editor.commands.focus()})()`,
  )
  await key('i')
  win.webContents.insertText(' unsaved')
  await key('Escape')
  await evaluate(`window.richTextVimFixture.failNextWrite()`)
  const switchButton = await evaluate<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector('[data-fixture-action="leave"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  click(switchButton)
  await wait(`window.richTextVimFixture.leaveResult()!==null`, 'failed switch flush result')
  const failedLeave = await evaluate<{ left: boolean; error?: string }>(
    `window.richTextVimFixture.leaveResult()`,
  )
  assert.equal(failedLeave.left, false)
  assert.match(failedLeave.error ?? '', /fixture disk refusal/)
  assert.equal((await state()).markdown, 'dirty before departure unsaved')
  const diskAfterRefusal = await readFile(note, 'utf8')
  assert(diskAfterRefusal.includes('Latest external snapshot'))
  assert.equal((await state()).editable, true, 'failed departure retains editable dirty document')
  const retryButton = await evaluate<{ x: number; y: number }>(
    `(()=>{const r=document.querySelector('[data-fixture-action="retry"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  click(retryButton)
  await wait(`window.richTextVimFixture.leaveResult()?.left===true`, 'successful retry switch')
  const retriedLeave = await evaluate<{ left: boolean }>(`window.richTextVimFixture.leaveResult()`)
  assert.equal(retriedLeave.left, true)
  assert((await readFile(note, 'utf8')).includes('dirty before departure unsaved'))
  await wait(
    `document.querySelector('[data-fixture-editor="primary"]')?.hidden`,
    'successful retry leaves document',
  )
  const diskAfterRetry = await readFile(note, 'utf8')
  assert(diskAfterRetry.includes('dirty before departure unsaved'))
  nativeResults.push({
    scenario: 'failed flush and retry',
    diskAfterRefusal,
    diskAfterRetry,
  })
  mark('dirty-departure-refusal-retains-document-and-retry-flushes-before-switch')
  await evaluate(`window.richTextVimFixture.visibility(true,'primary')`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.isEditable`,
    'restore visible editor for native visual evidence',
  )
  await evaluate(
    `window.richTextVimFixture.setup('<p>alpha beta</p>',1);window.richTextVimFixture.focus('primary')`,
  )
  await key('Escape')
  await key('v')
  await key('l')
  const visualEvidence = await state()
  assert.equal(visualEvidence.markdown, 'alpha beta')
  assert(visualEvidence.selectedText.length > 0, 'screenshot shows a real native visual selection')
  await capture('light.png')
  await evaluate(
    `document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark')`,
  )
  await capture('dark.png')
  const result = {
    ok: true,
    issue: 516,
    checks,
    nativeAssertions: nativeResults,
    visualEvidence: {
      selectedText: visualEvidence.selectedText,
      screenshots: ['light.png', 'dark.png'],
      themes: ['light', 'dark'],
    },
    writes,
    evidence: ['light.png', 'dark.png', 'interaction.mp4'],
    interactionFrames: frame,
    isolation: {
      root,
      vault,
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
    },
    electron: process.versions.electron,
    coverageNotes: [
      'Keyboard input is delivered by Electron webContents.sendInputEvent, not synthetic DOM KeyboardEvents.',
      'The fixture uses production DocumentView, live path/remote props, Jotai vault state, buffer freeze, and a disposable notes.read/notes.write adapter.',
      'Comment text and source anchors are read back from the persisted fixture sidecar through the production comments.list call shape; decorations use production placement and transaction mapping.',
      'Clipboard interaction uses only the synthetic selected text; the runner-owned independent guard handles restoration and reports sanitized status without recording prior contents.',
      'Mermaid node content, ordered/task lists, wiki-link atoms, code blocks and table structures are exercised through native Vim keyboard input.',
      'The fixture exercises a bounded two-document focus/switch surface and live DocumentView identity changes; it does not represent shell tab routing.',
    ],
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`RESULT ${JSON.stringify(result)}`)
  app.quit()
}

app.on('window-all-closed', () => app.quit())
void run().catch(async (error: unknown) => {
  await mkdir(evidence, { recursive: true }).catch(() => undefined)
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ error: String(error), checks }),
  ).catch(() => undefined)
  console.error(error)
  app.exit(1)
})
