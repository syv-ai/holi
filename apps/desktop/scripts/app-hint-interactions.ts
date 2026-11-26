import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, type WebContents } from 'electron'
/** Drive the actual host shortcut, adapter and overlay while AppFrame owns its opaque guest. */
export async function runAppHintInteractions(
  contents: WebContents,
  captureFixture: (filename: string) => Promise<void>,
  mark: (name: string) => void,
): Promise<void> {
  const evaluate = async (script: string) => {
    try {
      return await contents.executeJavaScript(script)
    } catch (cause) {
      throw new Error(`App hint fixture script failed: ${script}`, { cause })
    }
  }
  const waitFor = async (expression: string, label: string): Promise<void> => {
    try {
      const result = await evaluate(
        `new Promise((resolve,reject)=>{const end=Date.now()+5000;const poll=()=>{if(${expression})resolve(true);else if(Date.now()>end)reject(new Error(${JSON.stringify(label)}));else setTimeout(poll,25)};poll()})`,
      )
      assert.equal(result, true)
    } catch (cause) {
      const state = await evaluate(
        `({focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.tagName,frame:document.querySelector('iframe')?.outerHTML,vim:window.fixtureVimEnabled,hints:Array.from(document.querySelectorAll('[data-hint-target]')).map(el=>el.getAttribute('data-hint-target'))})`,
      )
      const shadowDiagnostics = await Promise.all(
        ['open', 'closed', 'nested'].map(async (mode) => {
          const frame = contents.mainFrame.framesInSubtree.find((candidate) =>
            candidate.url.startsWith('holi-app://'),
          )
          if (!frame) return { mode, readError: 'owned guest frame not found' }
          try {
            return {
              mode,
              ...(await frame.executeJavaScript(
                `(()=>{const input=document.querySelector('#shadow-${mode}')?._fixtureInput;const root=input?.getRootNode();return {value:input?.value,isConnected:input?.isConnected,ownedRootActiveElement:root?.activeElement?.tagName,ownedRootActiveElementIsInput:root?.activeElement===input,documentFocused:document.hasFocus(),documentActiveElement:document.activeElement?.tagName}})()`,
              )),
            }
          } catch (readError) {
            return { mode, readError: String(readError) }
          }
        }),
      )
      throw new Error(
        `${label}: ${JSON.stringify({ windowFocused: BrowserWindow.fromWebContents(contents)?.isFocused(), state, shadowDiagnostics })}`,
        { cause },
      )
    }
  }
  const assertInputOwnership = async (): Promise<void> => {
    const window = BrowserWindow.fromWebContents(contents)
    assert(window?.isVisible() && window.isFocused(), 'native key input lost its owned window')
    assert.equal(
      await evaluate(`document.hasFocus()`),
      true,
      'native key input lost renderer focus',
    )
  }
  const input = async (key: string): Promise<void> => {
    await assertInputOwnership()
    contents.sendInputEvent({ type: 'keyDown', keyCode: key })
    if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key })
    contents.sendInputEvent({ type: 'keyUp', keyCode: key })
  }
  const typeGuestKey = async (key: 'f' | 'x'): Promise<void> => {
    await assertInputOwnership()
    if (process.platform === 'darwin') {
      const keyCode = key === 'f' ? 3 : 7
      await promisify(execFile)(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import('CoreGraphics');for(const down of [true,false]){const event=$.CGEventCreateKeyboardEvent(null,${keyCode},down);$.CGEventSetFlags(event,0);$.CGEventPostToPid(${process.pid},event)}`,
        ],
        { timeout: 5_000 },
      )
    } else {
      await input(key)
    }
  }
  const holdView = async (milliseconds = 750): Promise<void> => {
    if (process.env.HOLI_509_APP_HINTS_ONLY === '1' && process.env.HOLI_509_RECORD_VIDEO === '1')
      await new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
  const typeFixtureInput = async (): Promise<void> => {
    const window = BrowserWindow.fromWebContents(contents)
    assert(window?.isVisible() && window.isFocused(), 'native input lost its owned window')
    await waitFor(
      `document.hasFocus()&&document.visibilityState==='visible'&&document.activeElement?.tagName==='IFRAME'&&window.fixtureInputFocused===true`,
      'native input lost its owned guest focus',
    )
    if (process.platform === 'darwin') {
      // Never dispatch globally: a focus race must not type into another actor's window.
      await promisify(execFile)(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import('CoreGraphics');
          for (const key of [45,0,17,34,9,14]) {
            for (const down of [true,false]) {
              const event = $.CGEventCreateKeyboardEvent(null,key,down);
              $.CGEventSetFlags(event,0);
              $.CGEventPostToPid(${process.pid},event);
            }
            delay(0.05);
          }`,
        ],
        { timeout: 5_000 },
      )
      return
    }
    for (const key of 'native') await input(key)
  }
  const focusGuest = async () => {
    const window = BrowserWindow.fromWebContents(contents)
    assert(window, 'native app-frame window is unavailable')
    if (process.platform === 'darwin') {
      const appBundle = resolve(app.getPath('exe'), '..', '..', '..')
      await promisify(execFile)('/usr/bin/open', ['-a', appBundle], { timeout: 5_000 })
    }
    window.show()
    app.focus({ steal: true })
    window.focus()
    contents.focus()
    await evaluate(`document.querySelector('iframe')?.focus()`)
    const deadline = Date.now() + 5_000
    let state: { visible: boolean; focused: boolean; guestFocused: boolean } | undefined
    while (Date.now() < deadline) {
      state = (await evaluate(
        `({visible:document.visibilityState==='visible',focused:document.hasFocus(),guestFocused:document.activeElement===document.querySelector('iframe')})`,
      )) as typeof state
      if (
        window.isVisible() &&
        window.isFocused() &&
        state?.visible &&
        state.focused &&
        state.guestFocused
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `native app frame did not obtain visible focused window ownership: ${JSON.stringify({ windowVisible: window.isVisible(), windowFocused: window.isFocused(), state })}`,
    )
  }
  const requestHints = async () => {
    await focusGuest()
    await evaluate(
      `window.fixtureNeutralFocused=false;document.querySelector('iframe')?.contentWindow?.postMessage({kind:'fixture-neutral-focus'},'*')`,
    )
    await waitFor(`window.fixtureNeutralFocused===true`, 'guest did not leave its editable field')
    await waitFor(`window.fixtureVimEnabled===true`, 'Vim preference was not ready')
    await input('f')
    await waitFor(
      `document.querySelector('[data-host-hints] [data-hint-target="Activate smoke action"]')`,
      'app action hint did not appear',
    )
  }
  const assertVisibleLabels = async () => {
    await waitFor(
      `document.querySelector('[data-host-hints] [data-hint-target="Activate smoke action"]')&&document.querySelector('[data-host-hints] [data-hint-target="Smoke link"]')`,
      'real app hint labels did not appear',
    )
  }

  await evaluate(`window.postMessage({kind:'fixture-vim',enabled:true},'*')`)
  await waitFor(`window.fixtureVimEnabled===true`, 'Vim preference did not enable')
  await waitFor(
    `document.querySelector('iframe')?.getAttribute('aria-hidden')!=='true'`,
    'visible AppFrame did not mount',
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-pane]')?.hasAttribute('data-pane-focused')`),
    false,
    'ordinary single-pane production markup must not require a focus marker',
  )
  await requestHints()
  const labels = (await evaluate(
    `Array.from(document.querySelectorAll('[data-host-hints] [data-hint-target]')).map(el=>({label:el.getAttribute('data-hint-target'),key:el.getAttribute('data-hint-key')}))`,
  )) as Array<{ label: string; key: string }>
  assert(
    labels.some(({ label }) => label === 'Activate smoke action'),
    `Missing app action label: ${JSON.stringify({ labels, focus: await evaluate(`({focused:document.hasFocus(),active:document.activeElement?.tagName,frame:document.querySelector('iframe')?.outerHTML,pane:document.querySelector('[data-pane]')?.outerHTML})`) })}`,
  )
  assert(labels.some(({ label }) => label === 'Smoke link'))
  assert(!labels.some(({ label }) => label === 'Smoke input'))
  assert(!labels.some(({ label }) => /Disabled action|Hidden action|Occluded action/.test(label)))
  await input('Escape')
  await evaluate(
    `window.postMessage({kind:'fixture-split',split:true},'*');window.postMessage({kind:'fixture-focused',focused:false},'*')`,
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  await focusGuest()
  await input('f')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(
    await evaluate(`!!document.querySelector('[data-host-hints] [data-hint-target]')`),
    false,
    'unfocused split pane must not show hint labels',
  )
  await evaluate(`window.postMessage({kind:'fixture-focused',focused:true},'*')`)
  await requestHints()
  await input('Escape')
  await evaluate(`window.postMessage({kind:'fixture-split',split:false},'*')`)
  await requestHints()
  await input('Escape')
  await evaluate(`window.postMessage({kind:'fixture-visible',visible:false},'*')`)
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')`,
    'hidden pane retained labels',
  )
  await evaluate(`window.postMessage({kind:'fixture-visible',visible:true},'*')`)
  await requestHints()
  await input('Escape')
  await evaluate(`window.postMessage({kind:'fixture-focused',focused:true},'*')`)
  const darkNonce = await evaluate(`window.fixtureNonces?.a`)
  await evaluate(`window.postMessage({kind:'fixture-mode',mode:'light'},'*')`)
  await waitFor(
    `document.querySelector('.fixture.light')&&window.fixtureNonces?.a!==${JSON.stringify(darkNonce)}&&document.querySelector('#bridge-read-result')?.textContent?.includes('owned-a')`,
    'light-mode leased document was not ready',
  )
  await requestHints()
  await assertVisibleLabels()
  await captureFixture('app-hints-light.png')
  await holdView(1_500)
  await input('Escape')
  const lightNonce = await evaluate(`window.fixtureNonces?.a`)
  await evaluate(`window.postMessage({kind:'fixture-mode',mode:'dark'},'*')`)
  await waitFor(
    `document.querySelector('.fixture.dark')&&window.fixtureNonces?.a!==${JSON.stringify(lightNonce)}&&document.querySelector('#bridge-read-result')?.textContent?.includes('owned-a')`,
    'dark-mode leased document was not ready',
  )
  await requestHints()
  await assertVisibleLabels()
  await captureFixture('app-hints-dark.png')
  await holdView(1_500)
  const actionKey = await evaluate(
    `document.querySelector('[data-host-hints] [data-hint-target="Activate smoke action"]')?.getAttribute('data-hint-key')`,
  )
  assert.equal(
    typeof actionKey,
    'string',
    JSON.stringify(
      await evaluate(
        `({focused:document.hasFocus(),active:document.activeElement?.tagName,windowFocused:window.document.hasFocus(),hints:Array.from(document.querySelectorAll('[data-host-hints]')).map(root=>root.outerHTML),targets:Array.from(document.querySelectorAll('[data-hint-target]')).map(el=>el.outerHTML)})`,
      ),
    ),
  )
  for (const key of actionKey as string) await input(key)
  await waitFor(
    `document.querySelector('#guest-action-count')?.textContent==='1'`,
    'native hint keys did not activate exactly one guest action',
  )
  assert.equal(await evaluate(`document.querySelector('#guest-action-count')?.textContent`), '1')
  await requestHints()
  await assertVisibleLabels()
  const repeatedActionKey = await evaluate(
    `document.querySelector('[data-host-hints] [data-hint-target="Activate smoke action"]')?.getAttribute('data-hint-key')`,
  )
  for (const key of repeatedActionKey as string) await input(key)
  await waitFor(
    `document.querySelector('#guest-action-count')?.textContent==='2'`,
    'repeated native hint activation did not reach the guest action',
  )
  mark('production-app-frame-native-f-hint-label-keys-activate-repeatedly-through-host-layer')
  await holdView(1_000)

  const nativeInputObservations: Array<{
    key: string
    type: string
    modifiers: string[]
  }> = []
  const observeNativeInput = (_event: Electron.Event, input: Electron.Input): void => {
    if (nativeInputObservations.length < 64 && ['keyDown', 'keyUp'].includes(input.type)) {
      nativeInputObservations.push({
        key: input.key,
        type: input.type,
        modifiers: [...input.modifiers],
      })
    }
  }
  contents.on('before-input-event', observeNativeInput)
  try {
    for (const editor of ['open', 'closed', 'nested']) {
      await focusGuest()
      await evaluate(
        `document.querySelector('iframe')?.contentWindow?.postMessage({kind:'fixture-focus-shadow-${editor}'},'*')`,
      )
      await waitFor(
        `document.activeElement===document.querySelector('iframe')&&window.fixtureShadowFocused==='${editor}'`,
        `${editor} shadow editor did not receive native focus`,
      )
      await typeGuestKey('f')
      await waitFor(
        `window.fixtureShadowInput==='${editor}:f'`,
        `${editor} shadow editor did not receive native f typing`,
      )
      await typeGuestKey('x')
      await waitFor(
        `window.fixtureShadowInput==='${editor}:fx'`,
        `${editor} shadow editor did not receive continued native typing`,
      )
      assert.equal(
        await evaluate(`!!document.querySelector('[data-host-hints] [data-hint-target]')`),
        false,
      )
    }
  } catch (cause) {
    throw new Error(
      `Shadow editor native typing failed: ${JSON.stringify({ nativeInputObservations })}`,
      { cause },
    )
  } finally {
    contents.off('before-input-event', observeNativeInput)
  }
  mark('production-app-frame-open-closed-and-nested-shadow-editors-preserve-native-f')

  await evaluate(
    `window.postMessage({kind:'fixture-vim',enabled:false},'*');document.querySelector('iframe')?.contentWindow?.postMessage({kind:'fixture-focus-input'},'*')`,
  )
  await waitFor(`window.fixtureVimEnabled===false`, 'Vim preference did not disable')
  await waitFor(`document.activeElement?.tagName==='IFRAME'`, 'AppFrame did not retain focus')
  await waitFor(`window.fixtureInputFocused===true`, 'guest input did not acknowledge focus')
  await typeFixtureInput()
  await waitFor(
    `document.querySelector('#guest-input-value')?.textContent==='native'`,
    'native editable input typing changed while Vim hints were disabled',
  )
  mark('production-app-frame-vim-off-preserves-native-guest-input-typing')
  await holdView(1_500)

  await evaluate(`window.postMessage({kind:'fixture-vim',enabled:true},'*')`)
  await waitFor(`window.fixtureVimEnabled===true`, 'Vim preference did not re-enable')
  await requestHints()
  await holdView()
  await evaluate(
    `document.querySelector('iframe')?.contentWindow?.postMessage({kind:'fixture-mutate'},'*')`,
  )
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')`,
    'guest DOM mutation retained stale labels',
  )
  await holdView()
  await requestHints()
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-overlay',show:true},'*')`)
  await waitFor(`document.querySelector('#fixture-host-overlay')`, 'fixture overlay did not mount')
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')&&document.querySelector('#fixture-host-overlay')`,
    'host hints remained mounted with fixture overlay',
  )
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-overlay',show:false},'*')`)
  await waitFor(
    `!document.querySelector('#fixture-host-overlay')`,
    'fixture overlay did not unmount',
  )
  await evaluate(`window.postMessage({kind:'fixture-split',split:true},'*')`)
  await waitFor(
    `document.querySelectorAll('[data-pane]').length===2&&document.querySelector('[data-pane]')?.hasAttribute('data-pane-focused')`,
    'focused split pane was not established',
  )
  await requestHints()
  await assertVisibleLabels()
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-focused',focused:false},'*')`)
  await waitFor(
    `!document.querySelector('[data-pane]')?.hasAttribute('data-pane-focused')`,
    'split pane focus did not depart',
  )
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')`,
    'focus-away retained stale labels',
  )
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-focused',focused:true},'*')`)
  await requestHints()
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-visible',visible:false},'*')`)
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')`,
    'hidden AppFrame retained labels',
  )
  await holdView()
  await evaluate(`window.postMessage({kind:'fixture-visible',visible:true},'*')`)
  const previousNonce = await evaluate(`window.fixtureNonces?.a`)
  await evaluate(`window.postMessage({kind:'fixture-reload'},'*')`)
  await waitFor(
    `typeof window.fixtureNonces?.a==='string'&&window.fixtureNonces.a!==${JSON.stringify(previousNonce)}&&document.querySelector('iframe')?.isConnected&&document.querySelector('iframe')?.getAttribute('aria-hidden')!=='true'&&document.querySelector('#bridge-read-result')?.textContent?.includes('owned-a')`,
    'fresh AppFrame after hidden/show reload did not establish a new leased document',
  )
  await requestHints()
  await assertVisibleLabels()
  assert.equal(await evaluate(`document.querySelector('#guest-action-count')?.textContent`), '2')
  mark('production-app-frame-mutation-overlay-hidden-show-reload-focus-cycle-discards-stale-hints')
  await holdView()

  await evaluate(`window.postMessage({kind:'fixture-vim',enabled:false},'*')`)
  await waitFor(`window.fixtureVimEnabled===false`, 'Vim preference did not disable')
  await waitFor(
    `!document.querySelector('[data-host-hints] [data-hint-target]')`,
    'Vim disable retained stale labels',
  )
  mark('production-app-frame-vim-disable-removes-native-hint-labels')
  await holdView()
}
