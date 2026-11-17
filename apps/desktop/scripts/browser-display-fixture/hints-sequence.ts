// Injected into browser-display-smoke's live Electron main-process fixture for #524.
{
  const hintsChecks: string[] = []
  const runtimeErrors: string[] = []
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) runtimeErrors.push(`host: ${message}`)
  })
  view.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) runtimeErrors.push(`page: ${message}`)
  })
  const hintMark = (name: string) => {
    hintsChecks.push(name)
    mark(name)
  }
  const page = view.webContents
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const pageEval = <T>(expression: string) => inPage<T>(view, expression)
  const pageNativePress = async (
    key: string,
    options: { shift?: boolean; meta?: boolean } = {},
  ) => {
    const before = await pageEval<number>(`(() => {
      if (!window.qaHintKeyUps) {
        window.qaHintKeyUps = 0
        window.addEventListener('keyup', event => {
          if (event.isTrusted) window.qaHintKeyUps++
        }, true)
      }
      return window.qaHintKeyUps
    })()`)
    const routedBefore = sent.length
    const keyCode = key.length === 1 ? key.toLowerCase() : key
    const modifiers = [
      ...(options.shift ? ['shift'] : []),
      ...(options.meta ? [process.platform === 'darwin' ? 'meta' : 'control'] : []),
    ]
    page.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (key.length === 1) page.sendInputEvent({ type: 'char', keyCode: key, modifiers })
    page.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    if (options.meta) {
      await until(
        () =>
          sent
            .slice(routedBefore)
            .some(
              (event) => event.name === 'key' && (event.payload as { key?: string }).key === key,
            ),
        `native shell shortcut ${key}`,
      )
      return
    }
    await until(
      async () => (await pageEval<number>('window.qaHintKeyUps')) > before,
      `trusted hint key ${key}`,
    )
  }
  const pressLabel = async (label: string) => {
    for (const key of label) await pageNativePress(key)
  }
  const hostNativePress = async (key: string) => {
    const before = await ui(`(() => {
      if (!window.qaHostKeyUps) {
        window.qaHostKeyUps = []
        window.addEventListener('keyup', event => {
          if (event.isTrusted)
            window.qaHostKeyUps.push({
              key: event.key,
              trusted: event.isTrusted,
              source: 'WebContents.sendInputEvent',
            })
        }, true)
      }
      return window.qaHostKeyUps.length
    })()`)
    const keyCode = key.length === 1 ? key.toLowerCase() : key
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await until(
      async () => (await ui('window.qaHostKeyUps.length')) > before,
      `trusted host key ${key}`,
    )
  }
  const requestPageHints = async (selector = 'body') => {
    page.focus()
    await pageEval(
      `(() => { const target=document.querySelector(${JSON.stringify(selector)});target.tabIndex=-1;target.focus() })()`,
    )
    await captureFrame(page)
    if (selector === '#search') await pageNativePress('Escape')
    await pageNativePress('f')
  }
  const hostHintCount = () =>
    ui(`document.querySelectorAll('[data-host-hints] [data-hint-key]').length`)
  const hintFrames = join(evidence, 'hints-frames')
  mkdirSync(hintFrames, { recursive: true })
  let recordingHints = false
  let hintFrame = 0
  let hintRecordingError: unknown
  let consecutiveCaptureFailures = 0
  const captureWarnings: string[] = []
  let hintRecorder: Promise<void> | undefined
  const startHintRecording = () => {
    recordingHints = true
    hintRecorder = (async () => {
      while (recordingHints && hintFrame < 2400) {
        try {
          const image = await page.capturePage()
          consecutiveCaptureFailures = 0
          if (!image.isEmpty())
            writeFileSync(
              join(hintFrames, `${String(hintFrame++).padStart(5, '0')}.png`),
              image.toPNG(),
            )
        } catch (error) {
          const missingFrame =
            error instanceof Error &&
            (error.name === 'UnknownVizError' || error.message === 'UnknownVizError')
          if (missingFrame && !page.isDestroyed() && ++consecutiveCaptureFailures <= 8) {
            if (captureWarnings.length < 32) captureWarnings.push(error.message)
            await wait(125)
            continue
          }
          hintRecordingError = error
          break
        }
        await wait(125)
      }
      recordingHints = false
    })()
  }
  const stopHintRecording = async () => {
    recordingHints = false
    await hintRecorder
    if (hintRecordingError) throw hintRecordingError
  }
  // Set the production preference and focus the real embedded page before sending
  // the Vim binding as native keyboard input (not a page/host dispatchEvent).
  await ui('qa.setVim(true)')
  await wait(700)
  await requestPageHints()
  await until(async () => (await hostHintCount()) > 0, 'mixed host and native page hints')
  startHintRecording()
  const hostLabels = await ui(
    `Array.from(document.querySelectorAll('[data-host-hints] [data-hint-key]')).map(e=>({key:e.getAttribute('data-hint-key'),label:e.getAttribute('data-hint-target')}))`,
  )
  assert(hostLabels.length > 0, 'HostHintLayer did not render shell chrome targets')
  await until(async () => (await pageOverlayCount()) > 0, 'closed-shadow page hint labels')
  const pageLabels = await pageLabelsFor(page)
  assert(pageLabels.length > 0, 'page-local closed-shadow labels missing')
  const sharedKeys = [
    ...hostLabels.map((item: any) => item.key),
    ...pageLabels.map((item: any) => item.key),
  ]
  assert.equal(
    new Set(sharedKeys).size,
    sharedKeys.length,
    'chrome and page targets share one label space',
  )
  assert(
    pageLabels.some((item: any) => item.key.length > 1),
    'fixture did not exercise multi-character hint keys',
  )
  assert(
    !pageLabels.some((item: any) =>
      /Disabled exclusion|Hidden exclusion|Occluded exclusion|Clipped exclusion|Transparent exclusion|Inert exclusion|Aria hidden exclusion|frame/i.test(
        item.label,
      ),
    ),
    'disabled, hidden, occluded, clipped or child-frame target was included',
  )
  hintMark('native-page-f-discovers-production-page-and-host-labels')

  // The page itself captures keys and reports a request-scoped keyboard event;
  // all chosen actions below are generated by WebContents.sendInputEvent.
  const button = pageLabels.find((item: any) => /Submit/.test(item.label))
  assert(button, 'native Submit target was not discoverable')
  await pageEval(
    `window.qaHintEvents=[];document.querySelector('#trusted-button').addEventListener('click',e=>qaHintEvents.push({type:'button',trusted:e.isTrusted}))`,
  )
  await pressLabel(button.key)
  await until(
    async () => (await pageEval<any[]>('window.qaHintEvents')).length > 0,
    'trusted native button click',
  )
  const buttonEvents = await pageEval<any[]>('window.qaHintEvents')
  assert.equal(
    buttonEvents.at(-1).trusted,
    true,
    'button action must be an actual trusted native click',
  )
  hintMark('page-label-activation-produces-trusted-native-button-click')

  for (const selector of ['#trusted-button', '#trusted-link']) {
    await requestPageHints(selector)
    await until(
      async () => (await pageLabelsFor(page)).length > 0,
      `focused ${selector} requests hints`,
    )
    const chosen = (await pageLabelsFor(page)).find((item: any) => /Submit/.test(item.label))
    assert(chosen)
    const before = (await pageEval<any[]>('window.qaHintEvents')).length
    await pressLabel(chosen.key)
    await until(
      async () => (await pageEval<any[]>('window.qaHintEvents')).length > before,
      `trusted activation from ${selector}`,
    )
    assert.equal((await pageEval<any[]>('window.qaHintEvents')).at(-1).trusted, true)
  }
  hintMark('body-button-link-focus-request-hints-with-trusted-activation')

  // Delay only the selected browser UI capability. Escape must retire the page
  // snapshot immediately AND reach the retained selected host cancellation route.
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'delayed activation hints')
  const delayedTarget = (await pageLabelsFor(page)).find((item: any) => /Submit/.test(item.label))
  assert(delayedTarget)
  const clicksBeforeDelay = (await pageEval<any[]>('window.qaHintEvents')).length
  let releaseHintActivation!: () => void
  let hintActivationEntered!: () => void
  const activationEntered = new Promise<void>((resolve) => {
    hintActivationEntered = resolve
  })
  hintActivationGate = {
    wait: new Promise<void>((resolve) => {
      releaseHintActivation = resolve
    }),
    entered: hintActivationEntered,
  }
  try {
    await pressLabel(delayedTarget.key)
    await activationEntered
    const queued = hintUiCalls.filter((call) => call.name === 'browser.hints-activate').at(-1)!
      .params.owner
    await pageNativePress('Escape')
    assert.equal(
      (await pageLabelsFor(page)).length,
      0,
      'Escape did not synchronously retire the page snapshot',
    )
    await until(
      () =>
        hintUiCalls.some(
          (call) =>
            call.name === 'browser.hints-clear' &&
            call.params.request === queued.request &&
            call.params.nonce === queued.nonce &&
            call.params.attachment === queued.attachment,
        ),
      'selected host cancellation route clears exact request',
    )
    hintMark('native-escape-retires-delayed-action-and-routes-exact-host-cancellation')
  } finally {
    hintActivationGate = undefined
    releaseHintActivation()
  }
  await wait(300)
  assert.equal(
    (await pageEval<any[]>('window.qaHintEvents')).length,
    clicksBeforeDelay,
    'cancelled delayed activation clicked',
  )

  // Once the selected async target retires the visible session, Escape in the
  // real host window must still cancel its owned pending activation.
  await ui('document.body.tabIndex=-1;document.body.focus()')
  await hostNativePress('f')
  await until(
    async () => (await pageLabelsFor(page)).length > 0,
    'host-origin Escape activation hints',
  )
  const hostEscapeTarget = (await pageLabelsFor(page)).find((item: any) =>
    /Submit/.test(item.label),
  )
  assert(hostEscapeTarget)
  const clicksBeforeHostEscape = (await pageEval<any[]>('window.qaHintEvents')).length
  let releaseHostEscape!: () => void
  let hostEscapeActivationEntered!: () => void
  const hostEscapeEntered = new Promise<void>((resolve) => {
    hostEscapeActivationEntered = resolve
  })
  hintActivationGate = {
    wait: new Promise<void>((resolve) => {
      releaseHostEscape = resolve
    }),
    entered: hostEscapeActivationEntered,
  }
  try {
    for (const key of hostEscapeTarget.key) await hostNativePress(key)
    await hostEscapeEntered
    const queued = hintUiCalls.filter((call) => call.name === 'browser.hints-activate').at(-1)!
      .params.owner
    const hostFocusBefore = await ui('document.activeElement?.tagName')
    await hostNativePress('Escape')
    const hostKeyEvidence = await ui('window.qaHostKeyUps.at(-1)')
    assert.deepEqual(hostKeyEvidence, {
      key: 'Escape',
      trusted: true,
      source: 'WebContents.sendInputEvent',
    })
    assert.equal(await ui('document.activeElement?.tagName'), hostFocusBefore)
    await until(
      () =>
        hintUiCalls.some(
          (call) =>
            call.name === 'browser.hints-clear' &&
            call.params.request === queued.request &&
            call.params.nonce === queued.nonce &&
            call.params.attachment === queued.attachment,
        ),
      'native host Escape clears exact delayed activation',
    )
    await wait(350)
    assert.equal(await pageOverlayCount(), 0, 'host Escape left page labels')
    assert.equal(await hostHintCount(), 0, 'host Escape left host labels')
    hintMark('native-host-escape-cancels-selected-delayed-browser-action')
  } finally {
    hintActivationGate = undefined
    releaseHostEscape()
  }
  await wait(300)
  assert.equal(
    (await pageEval<any[]>('window.qaHintEvents')).length,
    clicksBeforeHostEscape,
    'host Escape allowed delayed activation to click',
  )

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'opacity invalidation hints')
  await pageEval(`document.querySelector('#trusted-button').style.opacity='0'`)
  await until(
    async () => (await pageLabelsFor(page)).length === 0 && (await hostHintCount()) === 0,
    'opacity mutation revokes snapshot',
  )
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'transparent target rediscovery')
  assert(
    !(await pageLabelsFor(page)).some((item: any) => /Submit/.test(item.label)),
    'newly transparent target still discoverable',
  )
  await pageNativePress('Escape')
  await pageEval(`document.querySelector('#trusted-button').style.opacity=''`)
  hintMark('transparent-targets-and-ancestors-excluded-and-opacity-mutation-revokes')

  // Hold only this fixture's isolated-world poll while f and Escape are queued
  // in the same native turn. The exact cancellation must reach the host even
  // though discovery never starts; it must not produce toolbar fallback labels.
  await pageEval(`document.body.tabIndex=-1;document.body.focus()`)
  const clearsBeforePrediscoveryCancel = hintUiCalls.filter(
    (call) => call.name === 'browser.hints-clear',
  ).length
  await captureFrame(page)
  await pageEval(`(() => {
    window.qaCancelKeyUps=[]
    const listener=event=>{if(event.isTrusted)window.qaCancelKeyUps.push(event.key)}
    window.addEventListener('keyup',listener,true)
  })()`)
  const hintsEventsBefore = sent.filter(
    (event) => event.remote === 'A' && event.name === 'hints',
  ).length
  await page.executeJavaScriptInIsolatedWorld(1017, [
    { code: `globalThis.qaSavedHintPoll=__holiPage.hints.poll;__holiPage.hints.poll=()=>[];true` },
  ])
  try {
    const before = await pageEval<number>('window.qaCancelKeyUps.length')
    for (const key of ['f', 'Escape']) {
      const keyCode = key.length === 1 ? key.toLowerCase() : key
      page.sendInputEvent({ type: 'keyDown', keyCode })
      if (key.length === 1) page.sendInputEvent({ type: 'char', keyCode: key })
      page.sendInputEvent({ type: 'keyUp', keyCode })
    }
    await until(
      async () => (await pageEval<number>('window.qaCancelKeyUps.length')) >= before + 2,
      'trusted native f and Escape',
    )
  } finally {
    await page.executeJavaScriptInIsolatedWorld(1017, [
      { code: `__holiPage.hints.poll=qaSavedHintPoll;delete globalThis.qaSavedHintPoll` },
    ])
  }
  await until(
    () =>
      hintUiCalls.filter((call) => call.name === 'browser.hints-clear').length >
      clearsBeforePrediscoveryCancel,
    'cancelled pre-discovery request reaches host adapter',
  )
  const requestEvent = sent
    .slice()
    .filter((event) => event.remote === 'A' && event.name === 'hints')
    .slice(hintsEventsBefore)
    .find((event) => (event.payload as any).type === 'request')
  const cancelEvent = sent
    .slice()
    .filter((event) => event.remote === 'A' && event.name === 'hints')
    .slice(hintsEventsBefore)
    .find((event) => (event.payload as any).type === 'cancel')
  assert(requestEvent && cancelEvent, 'native request and cancel were not emitted by production')
  assert.deepEqual(cancelEvent.payload, { ...requestEvent.payload, type: 'cancel' })
  const cancelledWire = hintUiCalls
    .filter((call) => call.name === 'browser.hints-clear')
    .at(-1)!.params
  assert.deepEqual(
    {
      tab: cancelledWire.tab,
      nonce: cancelledWire.nonce,
      attachment: cancelledWire.attachment,
      request: cancelledWire.request,
    },
    {
      tab: (cancelEvent.payload as any).tab,
      nonce: (cancelEvent.payload as any).nonce,
      attachment: (cancelEvent.payload as any).attachment,
      request: (cancelEvent.payload as any).request,
    },
    'native cancellation clear must match its exact emitted request scope',
  )
  await wait(350)
  assert.equal(await pageOverlayCount(), 0, 'pre-discovery Escape left page labels')
  assert.equal(await hostHintCount(), 0, 'cancelled discovery fell back to host toolbar labels')
  hintMark('native-prediscovery-escape-cancels-request-without-host-fallback')

  // Hold only this fixture's isolated-world poll while genuine native keys fill
  // the pre-discovery queue. No synthetic/trust override or production test door.
  await pageEval(
    `document.body.tabIndex=-1;document.body.focus();window.qaReleasedKeys=[];window.addEventListener('keydown',event=>{if(event.isTrusted)qaReleasedKeys.push({key:event.key,prevented:event.defaultPrevented})})`,
  )
  await captureFrame(page)
  await page.executeJavaScriptInIsolatedWorld(1017, [
    { code: `globalThis.qaSavedHintPoll=__holiPage.hints.poll;__holiPage.hints.poll=()=>[];true` },
  ])
  try {
    await pageNativePress('f')
    for (let index = 0; index < 35; index++) await pageNativePress('a')
    await pageNativePress('Escape')
    await pageNativePress('x')
    const pendingEvents = await page.executeJavaScriptInIsolatedWorld(1017, [
      { code: `qaSavedHintPoll()` },
    ])
    assert.equal(pendingEvents.length, 1, 'overflow retained old request or queued keys')
    assert.equal(pendingEvents[0].type, 'revoke')
    assert(Number.isSafeInteger(pendingEvents[0].capture))
    const released = await pageEval<any[]>('window.qaReleasedKeys')
    assert(
      released.some((event) => event.key === 'Escape' && !event.prevented),
      'overflow stuck intercepting Escape',
    )
    assert(
      released.some((event) => event.key === 'x' && !event.prevented),
      'overflow stuck intercepting ordinary body input',
    )
  } finally {
    await page.executeJavaScriptInIsolatedWorld(1017, [
      { code: `__holiPage.hints.poll=qaSavedHintPoll;delete globalThis.qaSavedHintPoll` },
    ])
  }
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'fresh capture after overflow')
  await pageNativePress('Escape')
  hintMark('native-prediscovery-overflow-releases-escape-input-and-fresh-capture')

  await requestPageHints()
  await until(
    async () => (await pageLabelsFor(page)).length > 0,
    'settled capture before delayed poll',
  )
  const delayedPollStart = sent.filter(
    (event) => event.remote === 'A' && event.name === 'hints',
  ).length
  await pageEval(`(() => {
    window.qaDelayedKeyUps=[]
    window.addEventListener('keyup',event=>{if(event.isTrusted)window.qaDelayedKeyUps.push(event.key)},true)
  })()`)
  await page.executeJavaScriptInIsolatedWorld(1017, [
    { code: `globalThis.qaSavedHintPoll=__holiPage.hints.poll;__holiPage.hints.poll=()=>[];true` },
  ])
  try {
    for (const key of ['a', 'Escape']) {
      const keyCode = key.length === 1 ? key.toLowerCase() : key
      page.sendInputEvent({ type: 'keyDown', keyCode })
      if (key.length === 1) page.sendInputEvent({ type: 'char', keyCode: key })
      page.sendInputEvent({ type: 'keyUp', keyCode })
    }
    await until(
      async () => (await pageEval<string[]>('window.qaDelayedKeyUps')).length >= 2,
      'trusted delayed-poll key acknowledgements',
    )
    await wait(350)
    assert((await pageOverlayCount()) > 0, 'fixture did not hold more than two production polls')
  } finally {
    await page.executeJavaScriptInIsolatedWorld(1017, [
      { code: `__holiPage.hints.poll=qaSavedHintPoll;delete globalThis.qaSavedHintPoll` },
    ])
  }
  await until(
    () =>
      sent.filter((event) => event.remote === 'A' && event.name === 'hints').length >=
      delayedPollStart + 2,
    'production emits buffered prefix key and Escape cancellation',
  )
  const delayedEvents = sent
    .filter((event) => event.remote === 'A' && event.name === 'hints')
    .slice(delayedPollStart)
    .map((event) => event.payload as any)
  const latePrefix = delayedEvents.find((event) => event.type === 'key' && event.key === 'a')
  const lateCancel = delayedEvents.find((event) => event.type === 'cancel')
  assert(latePrefix && lateCancel, 'late capture key or Escape cancellation was lost')
  assert.deepEqual(
    {
      tab: latePrefix.tab,
      nonce: latePrefix.nonce,
      attachment: latePrefix.attachment,
      request: latePrefix.request,
      origin: latePrefix.origin,
    },
    {
      tab: lateCancel.tab,
      nonce: lateCancel.nonce,
      attachment: lateCancel.attachment,
      request: lateCancel.request,
      origin: lateCancel.origin,
    },
    'late captured keys and cancellation must retain exact owner identity',
  )
  hintMark('native-delayed-poll-forwards-prefix-and-escape-through-settled-owner')

  await pageEval(`document.querySelector('#search').focus()`)
  await requestPageHints('#search')
  await until(async () => (await pageLabelsFor(page)).length > 0, 'field hints')
  const fieldLabels = await pageLabelsFor(page)
  const search = fieldLabels.find((item: any) => /Search/.test(item.label))
  assert(search, 'supported search field missing from hints')
  await pressLabel(search.key)
  await wait(400)
  assert.equal(await pageEval<string>('document.activeElement.id'), 'search')
  await pageNativePress('H')
  assert.equal(await pageEval<string>(`document.querySelector('#search').value`), 'H')
  hintMark('supported-field-handoff-enters-insert-and-receives-native-typing')

  // Prefix filtering, backspace and Escape all use genuine key events in the
  // native page, and stale labels are not left visible on cancellation.
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 2, 'multi-target hint labels')
  const beforePrefix = await pageLabelsFor(page)
  const firstKey = beforePrefix[0].key[0]
  await pageNativePress(firstKey)
  await wait(100)
  const narrowed = await pageLabelsFor(page)
  assert(narrowed.length <= beforePrefix.length, 'prefix did not narrow page labels')
  await pageNativePress('Backspace')
  await pageNativePress('Escape')
  await wait(250)
  await until(
    async () => (await pageLabelsFor(page)).length === 0 && (await hostHintCount()) === 0,
    'page and host labels revoke after Escape',
  )
  hintMark('native-prefix-backspace-and-escape-clear-request-scoped-labels')

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'overlay invalidation session')
  await ui('qa.setOverlay(true)')
  await until(async () => win.contentView.children.length === 0, 'hint overlay detaches page view')
  await wait(200)
  assert.equal((await pageLabelsFor(page)).length, 0, 'overlay left stale page labels')
  assert.equal(await hostHintCount(), 0, 'overlay left stale shell labels')
  await ui('qa.setOverlay(false)')
  await until(async () => win.contentView.children.length === 1, 'page returns after overlay')
  await pageEval(`document.querySelector('#search').focus()`)
  await pageNativePress('Escape')
  await pageEval(`document.body.tabIndex=-1;document.body.focus()`)
  hintMark('overlay-change-invalidates-page-and-host-labels')

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'hide invalidation session')
  await ui('qa.setVisible(false)')
  await until(async () => win.contentView.children.length === 0, 'hide removes browser view')
  await wait(200)
  assert.equal((await pageLabelsFor(page)).length, 0, 'hide left stale page labels')
  assert.equal(await hostHintCount(), 0, 'hide left stale shell labels')
  await ui('qa.setVisible(true)')
  await until(async () => win.contentView.children.length === 1, 'browser view returns after hide')
  await pageEval(`document.querySelector('#search').focus()`)
  await pageNativePress('Escape')
  await pageEval(`document.body.tabIndex=-1;document.body.focus()`)
  hintMark('hide-return-invalidates-old-page-and-host-labels')

  await invoke('A', 'open', { tab: 'same', url: `${url}/a?hint-replacement` })
  await until(
    () => page.getURL().endsWith('/a?hint-replacement'),
    'hint-owned navigation replacement',
  )
  await wait(350)
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'replacement document hints')
  await pageNativePress('Escape')
  await until(async () => (await pageLabelsFor(page)).length === 0, 'replacement hint cancellation')
  hintMark('hint-owned-navigation-replacement-rearms-current-document')

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'mutation invalidation session')
  await pageEval(
    `document.querySelector('#trusted-button').setAttribute('aria-label','Mutated target')`,
  )
  await until(
    async () => (await pageLabelsFor(page)).length === 0,
    'page mutation invalidates labels',
  )
  await until(async () => (await hostHintCount()) === 0, 'host labels revoke after page mutation')
  hintMark('page-dom-mutation-invalidates-visible-labels-and-actions')

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'scroll invalidation session')
  await pageEval(`document.body.tabIndex=-1;document.body.focus()`)
  await pageNativePress('PageDown')
  await until(
    async () => (await pageLabelsFor(page)).length === 0,
    'page scroll invalidates labels',
  )
  await until(async () => (await hostHintCount()) === 0, 'host labels revoke after page scroll')
  hintMark('native-page-scroll-invalidates-page-and-host-labels')
  await pageEval(`window.scrollTo(0, 0)`)
  await wait(200)

  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'shell zoom invalidation session')
  win.webContents.setZoomFactor(1.1)
  await until(
    async () => (await pageLabelsFor(page)).length === 0,
    'shell zoom invalidates page labels',
  )
  await until(async () => (await hostHintCount()) === 0, 'host labels revoke after shell zoom')
  win.webContents.setZoomFactor(1)
  await wait(250)
  hintMark('shell-zoom-invalidates-page-and-host-labels')

  // Preference-off and native insert-mode typing leave the page in control.
  await ui('qa.setVim(false)')
  await wait(300)
  await requestPageHints()
  await wait(250)
  assert.equal((await pageLabelsFor(page)).length, 0, 'preference off exposed page hints')
  assert.equal(await hostHintCount(), 0, 'preference off exposed host hints')
  assert.equal(await pageEval<boolean>('document.activeElement === document.body'), true)
  await ui('qa.setVim(true)')
  await wait(350)
  await pageEval(
    `document.querySelector('#search').value='';document.querySelector('#search').focus()`,
  )
  await pageNativePress('f')
  await wait(250)
  assert.equal((await pageLabelsFor(page)).length, 0, 'insert-mode f opened hints')
  await pageNativePress('f', { meta: true })
  await wait(250)
  assert.equal((await pageLabelsFor(page)).length, 0, 'modified native shortcut opened hints')
  hintMark('preference-off-insert-and-modified-keys-pass-through')

  // Trusted click listeners distinguish sendInputEvent from HTMLElement.click().
  await pageEval(
    `window.qaHintEvents=[];document.querySelector('#trusted-link').addEventListener('click',e=>qaHintEvents.push({type:'link',trusted:e.isTrusted}))`,
  )
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'link hints')
  const link = (await pageLabelsFor(page)).find((item: any) => /Trusted link/.test(item.label))
  assert(link, 'link target was not discoverable')
  await pressLabel(link.key)
  await until(
    async () => (await pageEval<any[]>('window.qaHintEvents')).length > 0,
    'trusted link click',
  )
  const linkEvents = await pageEval<any[]>('window.qaHintEvents')
  assert.equal(linkEvents.at(-1).trusted, true, 'link action must be trusted')
  hintMark('page-label-activation-produces-trusted-native-link-click')

  // Clear stale CDP media emulation left by earlier native captures. Production
  // uses data-theme, never a manually invented .dark class contract.
  const themeEvidence: any[] = []
  const setActualTheme = async (theme: 'light' | 'dark') => {
    for (const wc of [page, win.webContents]) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    }
    await ui(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`,
    )
    await pageEval(`document.documentElement.style.colorScheme=${JSON.stringify(theme)}`)
    await captureFrame(page)
    await captureFrame(win.webContents)
    const host = await ui(
      `({theme:document.documentElement.dataset.theme,scheme:getComputedStyle(document.documentElement).colorScheme,bg:getComputedStyle(document.body).backgroundColor})`,
    )
    const guest = await pageEval<any>(
      `({scheme:getComputedStyle(document.documentElement).colorScheme,bg:getComputedStyle(document.body).backgroundColor})`,
    )
    assert.equal(host.theme, theme)
    assert.equal(host.scheme, theme)
    assert.equal(guest.scheme, theme)
    assert.equal(
      guest.bg,
      theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 18)',
      'Canvas did not resolve to actual requested scheme',
    )
    return { theme, host, guest }
  }
  const assertInstalledPresentation = async () => {
    const host = await ui(
      `(() => {const s=getComputedStyle(document.querySelector('[data-host-hint-presentation]'));return Object.fromEntries(['backgroundColor','color','fontFamily','fontSize','fontWeight','lineHeight','height','minWidth','paddingInline','paddingBlock','borderRadius','letterSpacing','pointerEvents'].map(name=>[name,s[name]]))})()`,
    )
    const labels = await pageLabelsFor(page)
    assert(labels.length > 0)
    for (const label of labels)
      assert.deepEqual(label.presentation, host, 'isolated page label differs from installed Kbd')
    return host
  }
  for (const theme of ['light', 'dark'] as const) {
    const actual = await setActualTheme(theme)
    await requestPageHints()
    await until(
      async () => (await pageLabelsFor(page)).length > 0,
      `${theme} page screenshot labels`,
    )
    const presentation = await assertInstalledPresentation()
    themeEvidence.push({ ...actual, presentation })
    const image = await page.capturePage()
    assert(!image.isEmpty())
    writeFileSync(join(evidence, `hints-page-${theme}.png`), image.toPNG())
    const shell = await win.capturePage()
    assert(!shell.isEmpty())
    writeFileSync(join(evidence, `hints-shell-${theme}.png`), shell.toPNG())
    await pageNativePress('Escape')
  }
  assert.notEqual(
    themeEvidence[0].presentation.backgroundColor,
    themeEvidence[1].presentation.backgroundColor,
  )
  assert.notEqual(themeEvidence[0].host.bg, themeEvidence[1].host.bg)
  // A custom semantic theme is consumed from the same installed Kbd, not from a
  // hard-coded light/dark palette in the browser adapter or the page.
  await ui(
    `document.documentElement.style.setProperty('--muted','rgb(211, 223, 231)');document.documentElement.style.setProperty('--muted-foreground','rgb(31, 47, 59)')`,
  )
  await requestPageHints()
  await until(async () => (await pageLabelsFor(page)).length > 0, 'custom semantic labels')
  const custom = await assertInstalledPresentation()
  assert.equal(custom.backgroundColor, 'rgb(211, 223, 231)')
  assert.equal(custom.color, 'rgb(31, 47, 59)')
  themeEvidence.push({ theme: 'custom', presentation: custom })
  await pageNativePress('Escape')
  await ui(
    `document.documentElement.style.removeProperty('--muted');document.documentElement.style.removeProperty('--muted-foreground')`,
  )
  hintMark('native-page-light-dark-and-shell-evidence-captured')
  hintMark('installed-kbd-light-dark-and-custom-theme-presentation-matches-page')

  await stopHintRecording()
  assert(hintFrame > 0, 'hint interaction recording has no native page frames')
  writeFileSync(
    join(evidence, 'hints-result.json'),
    JSON.stringify(
      {
        ok: true,
        checks: hintsChecks,
        source: process.env.HOLI_553_SHA,
        sourceHash: process.env.HOLI_553_SOURCE_HASH,
        runtimeErrors,
        trustedButton: buttonEvents.at(-1),
        trustedLink: linkEvents.at(-1),
        pageTargets: pageLabels.map((item: any) => item.label),
        hostTargets: hostLabels.map((item: any) => item.label),
        evidence: [
          'hints-page-light.png',
          'hints-page-dark.png',
          'hints-shell-light.png',
          'hints-shell-dark.png',
        ],
        interactionFrames: hintFrame,
        captureWarnings,
        themeEvidence,
      },
      null,
      2,
    ),
  )
  // Return the shared fixture to the default toolbar sequence's starting state.
  await setActualTheme('light')
  await invoke('A', 'open', { tab: 'same', url: `${url}/a` })
  await until(() => page.getURL().endsWith('/a'), 'toolbar starting document restored')
  await captureFrame(page)
  await badge('insert')
}

async function pageLabelsFor(target: WebContentsView['webContents']): Promise<any[]> {
  return target.executeJavaScriptInIsolatedWorld(1017, [{ code: `__holiPage.hints.inspect()` }])
}
async function pageOverlayCount(): Promise<number> {
  return (await pageLabelsFor(view.webContents)).length
}
