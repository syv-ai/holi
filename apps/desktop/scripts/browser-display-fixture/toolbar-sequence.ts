{
  await host.reconcile(vault('A'), 'open')
  await host.reconcile(vault('B'), 'open')
  host.setDisplayed('A')
  ipcMain.on('qa:plugin', (event, id, message) => {
    if (event.sender !== win.webContents || id !== 'browser') return
    for (const listener of [...listeners]) listener(message)
  })
  // Native-fixture-only delay at this adapter's UI capability seam. It cannot
  // evaluate renderer/guest code and does not exist in the production app.
  let hintActivationGate: { wait: Promise<void>; entered(): void } | undefined
  const hintUiCalls: { name: string; params: any }[] = []
  ipcMain.handle('qa:trpc', async (event, op) => {
    assert.equal(event.sender, win.webContents)
    assert.equal(op.path, 'cap.run')
    const { remote, name, paramsJson } = op.input
    assert(name.startsWith('browser.'))
    assert(['A', 'B'].includes(remote))
    try {
      if (name.startsWith('browser.hints-')) {
        hintUiCalls.push({ name, params: paramsJson ? JSON.parse(paramsJson) : undefined })
        if (name === 'browser.hints-activate' && hintActivationGate) {
          hintActivationGate.entered()
          await hintActivationGate.wait
        }
      }
      const result = await registry.run(
        name,
        'ui',
        {
          remote,
          root: roots[remote as 'A' | 'B'],
          bundle: null,
          core: noCoreServices(),
          claims: async () => [],
          snapshot: async () => {
            throw Error('unused')
          },
        },
        paramsJson ? JSON.parse(paramsJson) : undefined,
      )
      return { ok: true, data: result.value }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  })
  await win.loadFile(join(process.env.HOLI_553_RENDERER!, 'index.html'))
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (read: () => unknown, label: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await read()) return
      await pause(25)
    }
    throw Error(`timed out waiting for ${label}`)
  }
  const trustedPress = async (target: WebContentsView, key: string) => {
    const shift = key.length === 1 && key !== key.toLowerCase()
    const keyCode = shift ? key.toLowerCase() : key
    const before = await target.webContents.executeJavaScript('window.qaKeys?.length ?? 0')
    const modifiers = shift ? ['shift'] : []
    target.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (key.length === 1)
      target.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers })
    target.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await until(
      () => target.webContents.executeJavaScript(`(window.qaKeys?.length ?? 0) > ${before}`),
      `trusted DOM key ${key}`,
    )
  }
  await until(() => win.webContents.executeJavaScript('!!window.qa'), 'production renderer ready')
  await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: false })

  win.webContents.send('qa:event', {
    remote: 'A',
    name: 'tabs',
    payload: await invoke('A', 'tabs', {}),
  })
  for (const event of sent.filter((entry) => entry.remote === 'A' && entry.name === 'vim-mode'))
    win.webContents.send('qa:event', event)
  await until(async () => win.contentView.children.length === 1, 'renderer placement')
  let view = child()
  const ui = (code: string) => win.webContents.executeJavaScript(code)
  const badge = async (mode: string) =>
    until(
      async () =>
        await ui(
          `document.querySelector('[data-browser-tab="same"] [aria-label="Vim ${mode} mode"]') !== null`,
        ),
      `toolbar ${mode}`,
    )
  const field = async (code: string) => inPage(view, code)
  const text = () => field(`document.querySelector('#text').value`)
  const captureFrame = async (wc: any) => {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.captureScreenshot', { fromSurface: true })
    await wc.executeJavaScript(
      `if(!window.__qaKeyListener){globalThis.qaKeys=[];window.addEventListener('keydown',e=>qaKeys.push({key:e.key,trusted:e.isTrusted}),true);window.__qaKeyListener=true}`,
    )
  }
  const focus = async (id = 'text') => {
    await captureFrame(view.webContents)
    await field(`document.querySelector('#${id}').focus()`)
    assert.equal(await field('document.activeElement.id'), id)
  }
  await until(
    async () => await ui('(qa.state().modes.same?.revision ?? 0)>0'),
    'initial off configuration applied',
  )
  const pref = async (enabled: boolean) => {
    const revision = await ui('qa.state().modes.same.revision')
    await ui(`qa.setVim(${enabled})`)
    await until(
      async () => await ui(`qa.state().modes.same.revision>${revision}`),
      'preference configuration acknowledged',
    )
  }
  await pref(true)
  await badge('insert')

  // Exercise two simultaneous native views whose tab IDs differ within one vault.
  await invoke('A', 'open', { reopen: 'other', url: `${url}/a?other-pane`, shown: false })
  await ui('qa.setOtherPane(true)')
  win.webContents.send('qa:event', {
    remote: 'A',
    name: 'tabs',
    payload: await invoke('A', 'tabs', {}),
  })
  for (const event of sent.filter((entry) => entry.remote === 'A' && entry.name === 'vim-mode'))
    win.webContents.send('qa:event', event)
  const nativeViewFor = (path: string) =>
    win.contentView.children.find((candidate) => candidate.webContents.getURL().endsWith(path)) as
      WebContentsView | undefined
  await until(
    () =>
      win.contentView.children.length === 2 &&
      nativeViewFor('/a') !== undefined &&
      nativeViewFor('/a?other-pane') !== undefined,
    'two same-vault native views',
  )
  const sameView = nativeViewFor('/a')!
  const otherView = nativeViewFor('/a?other-pane')!
  assert.notEqual(sameView, otherView)
  await until(
    async () =>
      (await ui('qa.state().modes')).same?.revision > 0 &&
      (await ui('qa.state().modes')).other?.revision > 0,
    'per-tab vim configurations',
  )
  const paneBadge = async (id: string, mode: string) =>
    until(
      async () =>
        await ui(
          `document.querySelector('[data-browser-tab="${id}"] [aria-label="Vim ${mode} mode"]') !== null`,
        ),
      `${id} toolbar ${mode}`,
    )
  await paneBadge('same', 'insert')
  await paneBadge('other', 'insert')
  await captureFrame(sameView.webContents)
  await captureFrame(otherView.webContents)
  await sameView.webContents.executeJavaScript(
    `document.querySelector('#text').value='same-pane';document.querySelector('#text').setSelectionRange(0,0);document.querySelector('#text').focus()`,
  )
  await otherView.webContents.executeJavaScript(
    `document.querySelector('#text').value='other-pane';document.querySelector('#text').setSelectionRange(0,0);document.querySelector('#text').focus()`,
  )
  await trustedPress(sameView, 'Escape')
  await paneBadge('same', 'normal')
  await paneBadge('other', 'insert')
  await trustedPress(otherView, 'Escape')
  await paneBadge('other', 'normal')
  await captureFrame(sameView.webContents)
  await sameView.webContents.executeJavaScript(`document.querySelector('#text').focus()`)
  await trustedPress(sameView, 'i')
  await paneBadge('same', 'insert')
  await trustedPress(sameView, 'S')
  assert.equal(
    await sameView.webContents.executeJavaScript(`document.querySelector('#text').value`),
    'Ssame-pane',
  )
  assert.equal(
    await otherView.webContents.executeJavaScript(`document.querySelector('#text').value`),
    'other-pane',
  )
  await captureFrame(otherView.webContents)
  await trustedPress(otherView, 'i')
  await paneBadge('other', 'insert')
  await trustedPress(otherView, 'O')
  assert.equal(
    await otherView.webContents.executeJavaScript(`document.querySelector('#text').value`),
    'Oother-pane',
  )
  assert.equal(
    await sameView.webContents.executeJavaScript(`document.querySelector('#text').value`),
    'Ssame-pane',
  )
  await ui('qa.setOtherPane(false)')
  await until(async () => win.contentView.children.length === 1, 'second pane detached')
  assert.equal(child(), sameView)
  view = sameView
  await captureFrame(view.webContents)
  await trustedPress(view, 'Escape')
  await paneBadge('same', 'normal')
  await trustedPress(view, 'i')
  await paneBadge('same', 'insert')
  mark('native-same-vault-two-pane-tabs-own-input-and-mode-independently')

  await badge('insert')
  await focus()
  await trustedPress(view, 'Escape')
  await badge('normal')
  await field(
    `window.qaTrusted=[];window.addEventListener('keydown',event=>qaTrusted.push({key:event.key,trusted:event.isTrusted}),true)`,
  )
  await field(
    `document.querySelector('#text').value='  one two';document.querySelector('#text').setSelectionRange(6,6)`,
  )
  await trustedPress(view, 'I')
  await badge('insert')
  assert.equal(await field(`document.querySelector('#text').selectionStart`), 2)
  await trustedPress(view, 'X')
  assert.equal(await text(), '  Xone two')
  await trustedPress(view, 'Escape')
  await trustedPress(view, 'A')
  await badge('insert')
  assert.equal(await field(`document.querySelector('#text').selectionStart`), 10)
  await trustedPress(view, '!')
  assert.equal(await text(), '  Xone two!')
  mark('production-browser-surface-I-A-native-insertion-and-actual-mode')
  await trustedPress(view, 'Escape')
  await trustedPress(view, 'Tab')
  await badge('insert')
  assert.equal(await field('document.activeElement.id'), 'lines')
  const oldText = await text()
  await trustedPress(view, 'z')
  assert.equal(await text(), oldText)
  mark('native-tab-focus-resets-mode-and-preserves-other-field')
  await focus()
  await trustedPress(view, 'Escape')
  await field(
    `const old=document.querySelector('#text');old.replaceWith(old.cloneNode());document.querySelector('#text').focus()`,
  )
  await badge('insert')
  await trustedPress(view, 'q')
  assert(((await text()) as string).includes('q'))
  mark('native-element-replacement-releases-old-field')
  await focus('plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  await field(
    `(() => { const old=document.querySelector('#plaintext'); const clone=old.cloneNode(true); old.replaceWith(clone); clone.focus() })()`,
  )
  await badge('insert')
  await trustedPress(view, 'Escape')
  await badge('normal')
  await trustedPress(view, 'i')
  await badge('insert')
  await trustedPress(view, 'q')
  assert(
    ((await field(`document.querySelector('#plaintext').textContent`)) as string).includes('q'),
  )
  mark('plaintext-host-replacement-releases-old-owner')
  await pref(false)
  await until(
    async () => await ui(`document.querySelector('[aria-label^="Vim "]')===null`),
    'disabled badge',
  )
  await focus()
  await field(`document.querySelector('#text').setSelectionRange(0,0)`)
  await trustedPress(view, 'h')
  assert(((await text()) as string).startsWith('h'))
  await pref(true)
  await badge('insert')
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('production-preference-disables-and-reenables-native-page')
  await ui('qa.setOverlay(true)')
  await until(async () => win.contentView.children.length === 0, 'overlay detach')
  await ui('qa.setOverlay(false)')
  await until(async () => win.contentView.children.length === 1, 'overlay reattach')
  await pause(350)
  await focus('plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('production-overlay-restores-vim-with-fresh-attachment')
  mark('plaintext-host-rearms-after-overlay')
  await ui('qa.setVisible(false)')
  await until(async () => win.contentView.children.length === 0, 'hide detach')
  await ui('qa.setVisible(true)')
  await until(async () => win.contentView.children.length === 1, 'show attach')
  await pause(350)
  await focus('plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('production-visible-hide-return-rearms-field')
  mark('plaintext-host-rearms-after-hide-return')
  win.webContents.setZoomFactor(1.25)
  await pause(400)
  assert.equal(await ui(`document.querySelector('[aria-label="Vim normal mode"]')!==null`), true)
  const unchanged = await text()
  await trustedPress(view, 'h')
  assert.equal(await text(), unchanged)
  assert(view.getBounds().y > 0)
  win.webContents.setZoomFactor(1)
  await pause(250)
  mark('native-shell-zoom-keeps-mode-and-field-input')
  const before = await ui('qa.state().modes.same')
  await invoke('A', 'reload', { tab: 'same' })
  await until(async () => {
    const state = await ui('qa.state()')
    return (
      state.modes.same?.nonce !== before.nonce &&
      state.pages.find((p: any) => p.id === 'same')?.loading === false
    )
  }, 'reload new document')
  await pause(350)
  for (const listener of [...listeners])
    listener({
      remote: 'A',
      name: 'vim-config',
      payload: { id: 'same', ...before, enabled: true, revision: 90000 },
    })
  const staleArm = await view.webContents.executeJavaScriptInIsolatedWorld(1017, [
    { code: `__holiPage.vim.configure(true,90001,${JSON.stringify(before.nonce)})` },
  ])
  assert.equal(staleArm, false)
  await focus('plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('native-reload-rejects-old-document-arm-and-reconfigures')
  mark('plaintext-host-rearms-after-reload')
  await invoke('A', 'open', { tab: 'same', url: `${url}/a?new-document` })
  await pause(400)
  await focus('plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('native-navigation-reinitializes-current-document')
  mark('plaintext-host-rearms-after-navigation')
  const oldA = view
  host.setDisplayed('B')
  await ui('qa.setRemote("B")')
  await invoke('B', 'open', { reopen: 'same', url: `${url}/b`, shown: false })
  win.webContents.send('qa:event', {
    remote: 'B',
    name: 'tabs',
    payload: await invoke('B', 'tabs', {}),
  })
  await until(
    async () => win.contentView.children.length === 1 && child() !== oldA,
    'B same-id native view',
  )
  view = child()
  await pause(350)
  await focus()
  await trustedPress(view, 'Escape')
  await badge('normal')
  const bText = await text()
  host.setDisplayed('A')
  await ui('qa.setRemote("A")')
  win.webContents.send('qa:event', {
    remote: 'A',
    name: 'tabs',
    payload: await invoke('A', 'tabs', {}),
  })
  await until(
    async () => win.contentView.children.length === 1 && child() === oldA,
    'return A view',
  )
  view = child()
  await pause(350)
  await focus()
  await trustedPress(view, 'Escape')
  await badge('normal')
  assert.equal(await inPage(child(), `document.querySelector('#text').value`), 'one two three')
  mark('native-A-B-A-identical-tab-ids-retain-own-vim-context')
  await invoke('A', 'close', { tab: 'same' })
  await invoke('A', 'open', { reopen: 'same', url: `${url}/a`, shown: false })
  await until(
    async () => win.contentView.children.length === 1 && child() !== oldA,
    'same-id replacement',
  )
  view = child()
  await pause(350)
  await focus()
  await trustedPress(view, 'Escape')
  await badge('normal')
  mark('native-same-id-replacement-gets-fresh-vim-owner')
  await pref(false)
  await pause(150)
  await focus()
  if (!view.webContents.debugger.isAttached()) view.webContents.debugger.attach('1.3')
  await view.webContents.debugger.sendCommand('Input.imeSetComposition', {
    text: '日本語',
    selectionStart: 3,
    selectionEnd: 3,
  })
  await view.webContents.debugger.sendCommand('Input.insertText', { text: '日本語' })
  assert(((await text()) as string).includes('日本語'))
  await pref(true)
  await badge('insert')
  mark('native-composition-preserves-unmodified-insert-path')
  await field(
    `(() => { const host=document.querySelector('#plaintext'); host.textContent='one two three'; host.focus(); const range=document.createRange(); range.setStart(host.firstChild,0); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); window.qaTrusted=[]; window.addEventListener('keydown',e=>qaTrusted.push({key:e.key,trusted:e.isTrusted}),true) })()`,
  )
  await trustedPress(view, 'Escape')
  await badge('normal')
  const png = async (wc: any) => {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { fromSurface: true })
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
  }
  const composed = async (name: string) => {
    const main = await png(win.webContents)
    const page = await png(view.webContents)
    const size = main.getSize()
    const scale = size.width / win.getContentSize()[0]
    const bounds = view.getBounds()
    const ps = {
      width: Math.round(bounds.width * scale),
      height: Math.round(bounds.height * scale),
    }
    const bitmap = main.toBitmap()
    const p = page.resize(ps).toBitmap()
    const x = Math.round(bounds.x * scale),
      y = Math.round(bounds.y * scale)
    for (let row = 0; row < ps.height && y + row < size.height; row++) {
      if (y + row < 0) continue
      const width = Math.min(ps.width, size.width - x)
      if (width > 0)
        p.copy(
          bitmap,
          ((y + row) * size.width + x) * 4,
          row * ps.width * 4,
          (row * ps.width + width) * 4,
        )
    }
    writeFileSync(join(evidence, name), nativeImage.createFromBitmap(bitmap, size).toPNG())
  }
  await ui('document.documentElement.dataset.theme="light"')
  await field(`document.documentElement.style.colorScheme='light'`)
  await composed('ui-light.png')
  await ui('document.documentElement.dataset.theme="dark"')
  await field(`document.documentElement.style.colorScheme='dark'`)
  await pause(150)
  await composed('ui-dark.png')
  await ui('document.documentElement.dataset.theme="light"')
  await field(`document.documentElement.style.colorScheme='light'`)
  await field(
    `(() => { const host=document.querySelector('#plaintext'); host.focus(); const range=document.createRange(); range.setStart(host.firstChild,0); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  assert.equal(await field('document.activeElement.id'), 'plaintext')
  await trustedPress(view, 'Escape')
  await badge('normal')
  let recording = true
  let frame = 0
  mkdirSync(join(evidence, 'frames'), { recursive: true })
  const started = Date.now()
  const recordingLoop = (async () => {
    while (recording) {
      await composed(`frames/${String(frame++).padStart(5, '0')}.png`)
      await pause(80)
    }
  })()
  await pause(600)
  const pageMode = async () =>
    view.webContents.executeJavaScriptInIsolatedWorld(1017, [
      { code: '__holiPage.vim.mode().mode' },
    ])
  assert.equal(await pageMode(), 'normal', 'recording starts in page normal mode')
  assert.equal(await field(`document.querySelector('#plaintext').textContent`), 'one two three')
  await trustedPress(view, '0')
  assert.equal(await pageMode(), 'normal', '0 keeps page normal mode')
  await pause(600)
  await trustedPress(view, 'w')
  assert.equal(await pageMode(), 'normal', 'w keeps page normal mode')
  await pause(600)
  await trustedPress(view, 'i')
  await badge('insert')
  for (const key of 'native ') await trustedPress(view, key)
  await pause(700)
  await trustedPress(view, 'Escape')
  await badge('normal')
  await pause(800)
  await trustedPress(view, 'A')
  await badge('insert')
  await trustedPress(view, '!')
  await pause(800)
  await trustedPress(view, 'Escape')
  await badge('normal')
  await pause(500)
  view.webContents.undo()
  await pause(700)
  assert.equal(
    await field(`document.querySelector('#plaintext').textContent`),
    'one native two three',
  )
  view.webContents.redo()
  await pause(700)
  assert.equal(
    await field(`document.querySelector('#plaintext').textContent`),
    'one native two three!',
  )
  const originalRichMarkup = '<strong>bold</strong> <a href="/next">café🙂 link</a><em></em>'
  await field(`document.querySelector('#rich').innerHTML=${JSON.stringify(originalRichMarkup)}`)
  await field(
    `(() => { const host=document.querySelector('#rich'); const node=host.querySelector('a').firstChild; host.focus(); const range=document.createRange(); range.setStart(node,5); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range) })()`,
  )
  await trustedPress(view, 'Escape')
  await badge('normal')
  await trustedPress(view, 'l')
  assert.equal(await field('getSelection().anchorOffset'), 7)
  await trustedPress(view, 'i')
  await badge('insert')
  await trustedPress(view, 'x')
  const changedRichMarkup = await field(`document.querySelector('#rich').innerHTML`)
  assert.equal(changedRichMarkup, '<strong>bold</strong> <a href="/next">café🙂x link</a><em></em>')
  await trustedPress(view, 'Escape')
  await badge('normal')
  view.webContents.undo()
  await pause(500)
  assert.equal(await field(`document.querySelector('#rich').innerHTML`), originalRichMarkup)
  view.webContents.redo()
  await pause(500)
  assert.equal(await field(`document.querySelector('#rich').innerHTML`), changedRichMarkup)
  await pause(800)
  recording = false
  await recordingLoop
  assert.equal(
    await field(`document.querySelector('#plaintext').textContent`),
    'one native two three!',
  )
  const trusted = await field('qaTrusted')
  assert(trusted.length > 10 && trusted.every((event: any) => event.trusted))
  writeFileSync(
    join(evidence, 'recording.json'),
    JSON.stringify({
      frames: frame,
      elapsedMs: Date.now() - started,
      trusted,
      finalValue: await field(`document.querySelector('#plaintext').textContent`),
      source: process.env.HOLI_553_SHA,
      sourceHash: process.env.HOLI_553_SOURCE_HASH,
      worktree: process.env.HOLI_553_WORKTREE,
      worktreeStatus: process.env.HOLI_553_STATUS,
      capture: 'actual host and native page frames composed at native view bounds',
    }),
  )
  mark('production-toolbar-native-interaction-light-dark-and-trusted-recording')
  mark('native-rich-contenteditable-recorded')
  await ui('qa.setVisible(false)')
  await pause(200)
  await win.loadURL('data:text/html,<h1>Holi shell: no browser page attached</h1>')
  await host.stopAll()
}
