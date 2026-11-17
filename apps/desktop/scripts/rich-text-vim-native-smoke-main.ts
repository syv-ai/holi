import assert from 'node:assert/strict'
import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HOLI_516_ROOT!
const evidence = process.env.HOLI_516_EVIDENCE!
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
type NativeNode = { type: string; attrs?: Record<string, unknown>; content?: NativeNode[] }
type NativeState = {
  markdown: string
  selectedText: string
  json: { content: NativeNode[] }
  selection: { from: number; to: number }
  editable: boolean
}
const checks: string[] = []
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
  ipcMain.handle('rich-text-vim:comments', async (_event, operation: string, text?: string) => {
    if (operation === 'read') return readFile(commentsSidecar, 'utf8')
    if (operation === 'write' && typeof text === 'string') {
      await mkdir(join(vault, '.holi/comments/notes'), { recursive: true })
      await writeFile(commentsSidecar, text)
      return
    }
    throw new Error(`Unexpected comments fixture operation: ${operation}`)
  })
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
  windowRef.webContents.on('console-message', (_event, _level, message) => {
    if (message === 'HOLI_516_FOCUS') windowRef?.focus()
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
  assert(initialState.markdown.includes('~~~mermaid'))
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

  await evaluate(`window.richTextVimFixture.setup('<p>word   tail</p>',1)`)
  await key('Escape')
  await key('c')
  await key('w')
  win.webContents.insertText('X')
  await key('Escape')
  assert.equal((await state()).markdown, 'X   tail', 'cw keeps spaces following the changed word')
  mark('native-cw-preserves-trailing-spaces')

  await evaluate(
    `window.richTextVimFixture.setup('<p><span data-wiki-link="Wiki note">Wiki note</span> after</p>',1)`,
  )
  await key('Escape')
  await key('x')
  assert.equal((await state()).markdown, 'after', 'native x removes a real wiki-link atom')
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
  await key('P')
  assert.equal((await state()).markdown.replace(/\n/g, ''), 'firstsecond')
  mark('native-line-delete-and-register-put')

  await evaluate(`window.richTextVimFixture.setup('<p><strong>alpha</strong> beta</p>',1)`)
  await key('Escape')
  await key('y')
  await key('w')
  await key('P')
  assert((await state()).markdown.includes('**alpha**'), 'structured yank preserves a rich mark')
  mark('native-rich-mark-yank-and-put')

  await evaluate(`window.richTextVimFixture.setup('<p><strong>alpha</strong> beta</p>',1)`)
  await key('Escape')
  await key('y')
  await key('w')
  await key('p')
  assert(
    (await state()).markdown.includes('**alpha**'),
    'lowercase put preserves rich yanked content',
  )
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
  assert.equal(listAfterDelete.markdown, '- second')
  mark('native-line-delete-retains-list-container')

  await evaluate(
    `window.richTextVimFixture.setup('<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li><li><p>second</p></li></ul>',1);window.richTextVimFixture.atText('child')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const nestedAfterDelete = await state()
  assert.equal(nestedAfterDelete.markdown, '- parent\n- second')
  assert.equal(nestedAfterDelete.json.content[0]?.type, 'bulletList')
  assert.equal(nestedAfterDelete.json.content[0]?.content?.[0]?.content?.length, 1)
  mark('native-nested-list-line-delete-preserves-parent')

  await evaluate(
    `window.richTextVimFixture.setup('<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li><li><p>second</p></li></ul>',1);window.richTextVimFixture.atText('child')`,
  )
  await key('Escape')
  await key('y')
  await key('y')
  await key('p')
  const nestedAfterPut = await state()
  assert.equal(nestedAfterPut.markdown, '- parent\n  - child\n  - child\n- second')
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
  assert.equal(taskAfterDelete.markdown, '- [x] second')
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
  assert.equal(taskAfterPut.markdown, '- [ ] first\n- [ ] first\n- [x] second')
  mark('native-task-list-operator-put-preserves-attrs-and-sibling-order')

  await evaluate(
    `window.richTextVimFixture.setup('<p><span data-wiki-link="Wiki note" data-target="notes/Wiki note.md">Wiki note</span> after</p>',1)`,
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
  assert.equal(wikiAfterPut.markdown, '[[Wiki note]] [[Wiki note]] after')
  mark('native-wiki-link-yank-put-retains-structured-target')

  await evaluate(
    `window.richTextVimFixture.setup(${JSON.stringify('<pre><code class="language-ts">first\nsecond</code></pre>')},1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const codeAfterDelete = await state()
  assert.equal(codeAfterDelete.json.content[0]?.type, 'codeBlock')
  assert.equal(codeAfterDelete.markdown, '```ts\nsecond\n```', 'dd deletes one logical code line')
  mark('native-codeblock-logical-line-delete')

  await evaluate(
    `window.richTextVimFixture.setup('<p>first<br>second</p>',1);window.richTextVimFixture.atText('first')`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  assert.equal(
    (await state()).markdown,
    'second',
    'dd deletes only the first hardbreak-delimited line',
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
    `window.richTextVimFixture.setup('<p>before</p><pre><code class="language-mermaid">A --&gt; B</code></pre><p>after</p>',1);window.richTextVimFixture.atText('A --&gt; B')`,
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
    `window.richTextVimFixture.placeComment('thread-alpha','alpha')`,
  )
  assert(commentBefore, 'production comment bridge places the synthetic sidecar anchor')
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
  assert.equal(commentAfterDelete, null, 'deleting anchored text marks its thread orphaned')
  assert.equal(
    await evaluate<string>(`window.richTextVimFixture.commentText('thread-alpha')`),
    'Review this passage',
    'orphaning retains sidecar comment text',
  )
  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await evaluate(`window.richTextVimFixture.placeComment('thread-alpha','alpha')`)
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
  } | null>(`window.richTextVimFixture.commentRange('thread-alpha')`)
  assert(commentAfterChange, 'changed anchor maps through the production comment decoration')
  assert.equal((await state()).markdown, 'omega beta')
  assert.equal(commentAfterChange.to - commentAfterChange.from, 5)
  assert.equal(
    commentAfterChange.text,
    'omega',
    'comment range follows the changed passage through ProseMirror mapping',
  )
  assert.equal(
    await evaluate<string>(`window.richTextVimFixture.commentText('thread-alpha')`),
    'Review this passage',
  )
  mark('native-comment-sidecar-anchor-maps-through-delete-and-change')

  const shortcut = process.platform === 'darwin' ? 'meta' : 'control'
  await evaluate(`window.richTextVimFixture.setup('<p>alpha beta</p>',1)`)
  await key('Escape')
  await key('v')
  for (let i = 0; i < 5; i++) await key('l')
  await key('c', [shortcut])
  assert(clipboard.readText() === 'alpha', 'native copy shortcut writes the synthetic selection')
  await evaluate(`window.richTextVimFixture.setup('<p>target</p>',7)`)
  await key('Escape')
  await key('v', [shortcut])
  assert.equal(
    (await state()).markdown,
    'targetalpha',
    'native paste shortcut inserts the known synthetic text',
  )
  mark('native-platform-copy-paste-shortcuts-preserve-existing-clipboard')

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

  await evaluate(`window.richTextVimFixture.mode(false)`)
  await key('a')
  await evaluate(`window.richTextVimFixture.mode(true)`)
  await evaluate(`window.richTextVimFixture.visibility(false)`)
  await evaluate(
    `window.richTextVimFixture.visibility(true); window.richTextVimFixture.focus('primary')`,
  )
  await wait(
    `document.querySelector('[role="textbox"]')?.editor?.isEditable`,
    'editor returns after retain transitions',
  )
  mark('mode-off-and-retained-view-focus-transitions')

  const external = markdown.replace('Native Vim fixture', 'External update fixture')
  await evaluate(
    `await window.richTextVimFixture.externalWrite(${JSON.stringify(external)}); await window.richTextVimFixture.reload()`,
  )
  await wait(
    `document.querySelector('[role="textbox"]')?.editor?.getText().includes('External update fixture')`,
    'external disk update',
  )
  const saved = await evaluate<string>('await window.richTextVimFixture.flush()')
  assert(saved.startsWith('---\ntitle: External update fixture\ntags: [kept]\n---'))
  assert((await readFile(note, 'utf8')).startsWith('---\ntitle: External update fixture'))
  assert(writes >= 1)
  mark('real-disposable-file-adapter-flush-frontmatter-and-external-update')

  const staleSnapshot = markdown.replace('Native Vim fixture', 'Stale delayed snapshot')
  const latestSnapshot = markdown.replace('Native Vim fixture', 'Latest external snapshot')
  await evaluate(
    `window.richTextVimFixture.externalRead(${JSON.stringify(staleSnapshot)},'snapshot-A',true)`,
  )
  await evaluate(
    `window.richTextVimFixture.externalRead(${JSON.stringify(latestSnapshot)},'snapshot-B')`,
  )
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getText().includes('Latest external snapshot')`,
    'latest snapshot applies while older read is pending',
  )
  await evaluate(
    `window.richTextVimFixture.focus('secondary');window.richTextVimFixture.focus('primary')`,
  )
  await evaluate(`window.richTextVimFixture.releaseRead()`)
  await wait(
    `document.querySelector('[data-fixture-editor="primary"] [role="textbox"]')?.editor?.getText().includes('Latest external snapshot')`,
    'latest external snapshot wins after delayed stale read and A-B-A focus transition',
  )
  assert(!(await state()).markdown.includes('Stale delayed snapshot'))
  assert.equal((await state('secondary')).markdown, 'secondary alpha beta')
  mark('delayed-external-read-stale-result-ignored-across-focus-aba')

  await evaluate(`window.richTextVimFixture.setup('<p>dirty before departure</p>',1)`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'END' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'END' })
  win.webContents.insertText(' unsaved')
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
  assert((await readFile(note, 'utf8')).includes('Latest external snapshot'))
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
  mark('dirty-departure-refusal-retains-document-and-retry-flushes-before-switch')

  await evaluate(
    `window.richTextVimFixture.setup('<p>alpha beta</p>',1);window.richTextVimFixture.focus('primary')`,
  )
  await key('Escape')
  await key('v')
  await key('l')
  await capture('light.png')
  await evaluate(
    `document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark')`,
  )
  await capture('dark.png')
  const result = {
    ok: true,
    issue: 516,
    checks,
    nativeAssertions: [
      {
        name: 'native-comment-sidecar-anchor-maps-through-delete-and-change',
        deletion:
          'alpha is deleted; its production decoration is absent and sidecar text remains Review this passage',
        change: 'alpha is replaced with omega; the mapped decoration still covers exactly omega',
      },
      {
        name: 'native-platform-copy-paste-shortcuts-preserve-existing-clipboard',
        copy: 'selected alpha through native platform copy shortcut',
        paste: 'native platform paste inserts alpha after target',
        clipboard:
          'runner-owned guard restores the complete pasteboard or preserves external changes; no contents recorded',
      },
      {
        name: 'native-mermaid-line-yank-put-delete-undo-preserves-source-and-attrs',
        paste: 'Mermaid codeBlock duplicated with language=mermaid; before/after paragraphs remain',
        delete: 'one diagram node removed without touching neighboring nodes',
        undo: 'diagram restored with language=mermaid and source untouched',
      },
      {
        name: 'native-unsupported-cross-container-visual-operations-feedback-and-no-change',
        cases: ['table-cell to table-cell', 'paragraph to list item'],
        feedback: 'Vim selection crosses a list or table; no text was changed',
      },
      {
        name: 'native-task-and-nested-list-put-retains-structure',
        assertions: [
          'exact markdown and order',
          'task checked attributes',
          'nested list hierarchy',
        ],
      },
    ],
    expectedScenarios: [
      {
        name: 'native-ime-composition-start-update-end-preserves-input',
        input: 'base',
        output: 'base漢',
      },
      {
        name: 'native-occurrence-shortcut-vim-operator-clears-extra-edits',
        input: 'alpha beta alpha',
        output: 'alpha beta X',
      },
      {
        name: 'delayed-external-read-stale-result-ignored-across-focus-aba',
        staleSnapshot: 'Stale delayed snapshot',
        expectedVisibleSnapshot: 'Latest external snapshot',
        focusPathSequence: ['notes/acceptance.md', 'notes/secondary.md', 'notes/acceptance.md'],
      },
      {
        name: 'dirty-departure-refusal-retains-document-and-retry-flushes-before-switch',
        refusedWrite: 'fixture disk refusal',
        expectedSavedText: 'dirty before departure unsaved',
      },
    ],
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
      'The fixture uses the production DocumentView and complete document extension schema with a fixed notes.read/notes.write adapter.',
      'Comment anchors use production placeThreads and DocumentComments transaction mapping; an independent runner guard restores every captured pasteboard item and type or preserves external changes.',
      'Mermaid node content, ordered/task lists, wiki-link atoms, code blocks and table structures are exercised through native Vim keyboard input.',
      'The fixture controls a bounded two-document focus/switch surface; it does not represent shell tab routing.',
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
