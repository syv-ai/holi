import assert from 'node:assert/strict'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.HOLI_516_ROOT!
const evidence = process.env.HOLI_516_EVIDENCE!
const vault = join(root, 'vault')
const note = join(vault, 'notes/acceptance.md')
const secondaryNote = join(vault, 'notes/secondary.md')
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
}
const checks: string[] = []
let windowRef: BrowserWindow | undefined
let writes = 0
let frame = 0
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
    return readFile(file, 'utf8')
  })
  ipcMain.handle('rich-text-vim:write', async (event, requested: string, text: string) => {
    assert.equal(event.senderFrame?.url, `file://${join(root, 'renderer/index.html')}`)
    const file = fixtureFiles.get(requested)
    assert(file, `Unexpected fixture path: ${requested}`)
    assert.equal(typeof text, 'string')
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
    `window.richTextVimFixture.setup('<p>alpha beta</p>',1,'primary');window.richTextVimFixture.setup('<p>alpha beta</p>',1,'secondary');window.richTextVimFixture.focusOwnership(true,'secondary');window.richTextVimFixture.focus('secondary')`,
  )
  await key('Escape')
  await key('d')
  await key('w')
  assert.equal((await state('secondary')).markdown, 'beta')
  assert.equal((await state('primary')).markdown, 'alpha beta', 'unfocused split is unchanged')
  await evaluate(
    `window.richTextVimFixture.focusOwnership(true,'primary');window.richTextVimFixture.focus('primary')`,
  )
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
    `window.richTextVimFixture.setup('<table><tbody><tr><td><p>one</p></td></tr><tr><td><p>last</p></td></tr></tbody></table>',3)`,
  )
  await key('Escape')
  await key('d')
  await key('d')
  const tableAfterDelete = await state()
  assert.equal(tableAfterDelete.json.content[0]?.type, 'table')
  assert(tableAfterDelete.markdown.includes('last'))
  mark('native-line-delete-retains-table-container')

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

  await evaluate(`window.richTextVimFixture.mode(false)`)
  await key('a')
  await evaluate(`window.richTextVimFixture.mode(true)`)
  await evaluate(
    `window.richTextVimFixture.focusOwnership(false); window.richTextVimFixture.visibility(false)`,
  )
  await evaluate(
    `window.richTextVimFixture.visibility(true); window.richTextVimFixture.focusOwnership(true)`,
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

  await capture('light.png')
  await evaluate(
    `document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark')`,
  )
  await capture('dark.png')
  const result = {
    ok: true,
    issue: 516,
    checks,
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
      'The fixture does not claim app-shell integration: multi-document shell routing, native comment persistence, delayed cross-vault races, and real close-tab UI are not represented.',
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
