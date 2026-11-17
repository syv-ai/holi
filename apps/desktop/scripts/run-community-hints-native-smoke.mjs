import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCdpClient } from './native-smoke-cdp.mjs'
import { stopOwnedCommunityFixture } from './native-smoke-process.mjs'
import { prepareCommunityHintsNativeFixture } from './community-hints-native-fixture.mjs'
import { createNativeProofRecorder, finalizeScreencast } from './native-smoke-recording.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.argv.slice(2).find((arg) => arg !== '--') ?? `/tmp/holi-510-native-${Date.now()}`,
)
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], 'refusing to overwrite native evidence')
const root = await mkdtemp('/tmp/holi-510-runtime-')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assertions = []
let child
let closed
let closeResult
let screencastFrames = []
let cdpClient
let ws
let quit
let log = ''
let failure
const port = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const value = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return value
}
let debugPort
let pluginPort
try {
  debugPort = await port()
  pluginPort = await port()
  const { electron, env } = await prepareCommunityHintsNativeFixture({ desktop, root, pluginPort })
  child = spawn(electron, [root, `--remote-debugging-port=${debugPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk
      process.stdout.write(chunk)
    })
  closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      closeResult = { code, signal }
      resolve(closeResult)
    })
  })
  let target
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`fixture exited ${child.exitCode ?? child.signalCode}`)
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    target = targets.find((item) => item.type === 'page')
    if (target?.webSocketDebuggerUrl) break
    await sleep(250)
  }
  assert(target?.webSocketDebuggerUrl, 'missing native CDP page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const contexts = new Map()
  cdpClient = createCdpClient(ws, {
    onEvent(message) {
      if (message.method === 'Runtime.executionContextCreated' && !message.sessionId)
        contexts.set(message.params.context.id, message.params.context)
      if (message.method === 'Runtime.executionContextDestroyed')
        contexts.delete(message.params.executionContextId)
      if (message.method === 'Runtime.executionContextsCleared') contexts.clear()
    },
  })
  const cdp = (method, params = {}, sessionId) => cdpClient.call(method, params, sessionId)
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  const guestContext = () =>
    [...contexts.values()].find(
      (context) =>
        /^http:\/\/(?:127\.0\.0\.1|localhost):/.test(context.origin) && context.auxData?.isDefault,
    )?.id
  let guestSession
  const evaluate = async (expression, guest = false) => {
    const contextId = guest ? guestContext() : undefined
    if (guest && !contextId && !guestSession) {
      const { targetInfos } = await cdp('Target.getTargets')
      const frame = targetInfos.find(
        (item) => item.type === 'iframe' && /^http:\/\/(?:127\.0\.0\.1|localhost):/.test(item.url),
      )
      if (!frame) return undefined
      guestSession = (
        await cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true })
      ).sessionId
    }
    const result = await cdp(
      'Runtime.evaluate',
      {
        expression,
        contextId,
        returnByValue: true,
        awaitPromise: true,
      },
      guest && !contextId ? guestSession : undefined,
    )
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async (expression, description, guest = false) => {
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Electron stopped while waiting')
      if (await evaluate(expression, guest)) return
      await sleep(100)
    }
    throw new Error(
      `timeout: ${description}; host=${await evaluate('document.body.innerText')}; hostMessages=${JSON.stringify(await evaluate('window.smokeMessages'))}; guestMessages=${JSON.stringify(await evaluate('window.smokeMessages', true))}`,
    )
  }
  const key = async (value, modifiers = 0) => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: value,
      code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
      text: value.length === 1 ? value : undefined,
      modifiers,
    })
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: value,
      code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
      modifiers,
    })
  }
  const click = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }
  quit = () => evaluate('window.holiSmoke.quit()')
  await wait('!!document.querySelector("iframe")', 'real PluginFrame acquire')
  await wait('!!window.__holiHintBridgeV1__', 'served opt-in bridge', true)
  for (const guest of [false, true])
    await evaluate(
      `window.smokeMessages=[];window.addEventListener('message',event=>window.smokeMessages.push({origin:event.origin,data:event.data}))`,
      guest,
    )
  assert.equal(await evaluate('window.holi', true), undefined, 'no harness bridge in guest')
  const setupInstall = JSON.parse(
    await readFile(join(root, 'profile/plugins/installed.json'), 'utf8'),
  ).find((item) => item.id === 'smoke-plugin')
  const installedCode = join(
    root,
    'profile/plugins/smoke-plugin',
    setupInstall.source.commit,
    setupInstall.source.path,
  )
  const supervisedServerPid = Number(await readFile(join(installedCode, '.hint-smoke-pid'), 'utf8'))
  assertions.push(
    'real release install requires consent; setup marker is verified in installed release checkout; pin/acquire start supervised server and emitted production bridge asset is readable',
  )
  const focusGuest = async () => {
    await cdp('Page.bringToFront')
    const rect = await evaluate(
      '(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()',
    )
    await click(rect.x, rect.y)
    await wait('document.activeElement===document.querySelector("iframe")', 'guest frame focus')
    await wait('document.hasFocus()', 'native guest keyboard focus', true)
    // Flush layout/focus work from the preceding presentation change before input.
    const rendered =
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
    await evaluate(rendered)
    await evaluate(rendered, true)
  }
  const hints = () =>
    evaluate(
      '[...document.querySelectorAll("[data-host-hints] [data-hint-key]")].map(e=>({key:e.getAttribute("data-hint-key"),target:e.getAttribute("data-hint-target")}))',
    )
  const clickGuestSelector = async (selector) => {
    const point = await evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      true,
    )
    const frame = await evaluate(
      '(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return {x:r.x,y:r.y}})()',
    )
    await click(frame.x + point.x, frame.y + point.y)
  }
  const start = async () => {
    await focusGuest()
    await key('f')
    await wait(
      '!!document.querySelector("[data-host-hints]")',
      'actual guest f to shared host labels',
    )
  }
  await start()
  const first = await hints()
  const realSnapshot = await evaluate(
    'window.smokeMessages.map(message=>message.data).filter(message=>message?.type==="holi-hints:snapshot").at(-1)',
  )
  assert(realSnapshot?.nonce && Number.isSafeInteger(realSnapshot.revision))
  assert.equal(
    first.some((hint) => hint.target === 'Host action'),
    false,
    'guest-started labels must exclude host chrome',
  )
  assert(
    first.some((hint) => hint.target === 'Offscreen fixture') === false,
    'offscreen target exposed',
  )
  const button = first.find((hint) => hint.target === 'Native button')
  assert(button?.key, `guest native button label absent: ${JSON.stringify(first)}`)
  const replayFromGuest = async (snapshot) =>
    evaluate(`window.parent.postMessage(${JSON.stringify(snapshot)}, "*")`, true)
  const replayBaseline = realSnapshot
  assert(replayBaseline?.nonce && Number.isSafeInteger(replayBaseline.revision))
  const replayTargets = replayBaseline.targets.map((target) => ({
    ...target,
    label: `Replay target: ${target.label}`,
  }))
  const remainsCurrent = async (description) => {
    await sleep(100)
    const labels = await hints()
    assert(
      labels.some((hint) => hint.target === 'Native button'),
      `${description} replaced live labels`,
    )
    assert(
      labels.every((hint) => !hint.target.startsWith('Replay target:')),
      `${description} exposed rejected replay labels`,
    )
  }
  // These messages are posted from the actual fixture guest frame, preserving its
  // origin and WindowProxy source while independently varying protocol credentials.
  await replayFromGuest({
    ...replayBaseline,
    nonce: `${replayBaseline.nonce}forged`,
    revision: replayBaseline.revision + 1,
    targets: replayTargets,
  })
  await remainsCurrent('old nonce with otherwise valid bounded snapshot')
  await replayFromGuest({
    ...replayBaseline,
    revision: Math.max(0, replayBaseline.revision - 1),
    targets: replayTargets,
  })
  await remainsCurrent('nonmonotonic revision with current nonce')
  const acceptedReplayRevision = replayBaseline.revision + 1
  await replayFromGuest({
    ...replayBaseline,
    revision: acceptedReplayRevision,
    targets: replayTargets,
  })
  // The protocol snapshot is cached by the adapter; a matching start asks the
  // real host discovery path to render that controlled revision for inspection.
  await replayFromGuest({
    type: 'holi-hints:start',
    nonce: replayBaseline.nonce,
    revision: acceptedReplayRevision,
  })
  await wait(
    ' [...document.querySelectorAll("[data-host-hints] [data-hint-target]")].some(e=>e.getAttribute("data-hint-target").startsWith("Replay target:"))',
    'fresh valid guest replay replaces labels',
  )
  assert(
    (await hints()).some((hint) => hint.target === 'Replay target: Native button'),
    'correct guest source and origin fresh revision was not accepted',
  )
  const previousGuestGeneration = await evaluate('window.fixtureGeneration', true)
  await evaluate('location.reload()', true)
  await wait('!document.querySelector("[data-host-hints]")', 'negative replay reset')
  await wait(
    `window.fixtureGeneration !== ${JSON.stringify(previousGuestGeneration)}`,
    'new actual guest document after replay',
    true,
  )
  await wait('!!window.__holiHintBridgeV1__', 'fresh actual guest bridge after replay', true)
  await start()
  const restoredLabels = await hints()
  assert(
    restoredLabels.some((hint) => hint.target === 'Native button') &&
      restoredLabels.every((hint) => !hint.target.startsWith('Replay target:')),
    'fresh actual guest snapshot did not replace controlled replay labels',
  )
  const setupHint = restoredLabels.find((hint) => hint.target === 'Run fixture setup')
  assert(setupHint?.key, 'fresh actual snapshot omitted native setup target')
  for (const letter of setupHint.key) await key(letter)
  await wait(
    'document.querySelector("#output").textContent==="Setup complete"',
    'fresh actual keyboard activation',
    true,
  )
  await start()
  assertions.push(
    'old nonce and nonmonotonic revisions with valid fixture targets are rejected; a fresh correct-source/origin revision changes visible labels, then a new actual guest snapshot restores labels and native keyboard activation succeeds',
  )
  const addTarget = (await hints()).find((hint) => hint.target === 'Temporary target')
  assert(addTarget?.key, 'dynamic-target trigger label absent')
  for (const letter of addTarget.key) await key(letter)
  await wait('!document.querySelector("[data-host-hints]")', 'target mutation invalidation')
  await start()
  assert(
    (await hints()).some((hint) => hint.target === 'Dynamic target'),
    'new target missing from fresh snapshot',
  )
  await key('Escape')
  assertions.push(
    'native activation adds a live target; mutation invalidates labels, stale nonce/revision snapshots are rejected, and fresh labels include the new target',
  )
  const shot = async (name) => {
    const result = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(result.data, 'base64'))
  }
  await start()
  await key('Escape')
  await wait('!document.querySelector("[data-host-hints]")', 'Escape cancellation')
  await start()
  await key('Escape')
  await wait('!document.querySelector("[data-host-hints]")', 'repeated Escape cancellation')
  await evaluate('document.querySelector("button").focus()')
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'ordinary single-pane host start')
  const hostLabels = await hints()
  assert(
    hostLabels.some((hint) => hint.target === 'Host action'),
    'ordinary host start omitted pane chrome',
  )
  assert(
    !hostLabels.some((hint) => hint.target === 'Native button'),
    'ordinary host start included guest targets',
  )
  const viewport = await evaluate('({width:innerWidth,height:innerHeight})')
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: viewport.width - 80,
    height: viewport.height - 60,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(
    '!document.querySelector("[data-host-hints]")',
    'native CDP viewport resize invalidation',
  )
  await cdp('Emulation.clearDeviceMetricsOverride')
  await key('Escape')
  assertions.push(
    'repeated Escape recovers; ordinary pane ignores a retained hidden pane and starts host-only; native viewport resize invalidates labels',
  )
  await start()
  const beforeFrameResize = await hints()
  const nativeLabelBeforeResize = beforeFrameResize.find((hint) => hint.target === 'Native button')
  assert(nativeLabelBeforeResize?.key)
  await evaluate('document.querySelector("iframe").style.width="90%"')
  await wait('!document.querySelector("[data-host-hints]")', 'frame layout change invalidation')
  await evaluate('document.querySelector("iframe").style.width="100%"')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'frame resize fresh labels')
  const remappedStableButton = (await hints()).find((hint) => hint.target === 'Stable button')
  assert(remappedStableButton?.key, 'freshly mapped stable button missing after frame resize')
  for (const letter of remappedStableButton.key) await key(letter)
  await wait('window.fixtureStableClicks===1', 'freshly mapped label activation', true)
  await start()
  const consecutiveStableButton = (await hints()).find((hint) => hint.target === 'Stable button')
  assert(consecutiveStableButton?.key, 'stable target absent from immediate fresh session')
  for (const letter of consecutiveStableButton.key) await key(letter)
  await wait('window.fixtureStableClicks===2', 'consecutive mutation-free activation', true)
  await start()
  await key('Escape')
  assertions.push(
    'iframe viewport geometry invalidates and remaps targets; a fresh mapped target activates, then remains activatable in a consecutive mutation-free session',
  )
  assertions.push('actual cross-origin f produces shared host/guest labels; Escape cancels')
  await start()
  await key('ArrowDown')
  await wait('!document.querySelector("[data-host-hints]")', 'unsupported key cancellation')
  assert.equal(await evaluate('window.fixtureClicks', true), 0)
  await start()
  await key('x', 2)
  await wait('!document.querySelector("[data-host-hints]")', 'modified key cancellation')
  await clickGuestSelector('input[aria-label="Editable fixture"]')
  await key('x')
  assert.equal(
    await evaluate(
      'document.querySelector("input[aria-label=\\"Editable fixture\\"]").value',
      true,
    ),
    'x',
    'unsupported and modified hint keys must leave subsequent native editable input intact',
  )
  assertions.push(
    'unsupported and modified native keys clear active labels without activating a target; ordinary editable input remains intact',
  )
  await start()
  const staleButton = (await hints()).find((hint) => hint.target === 'Native button')
  assert(staleButton?.key)
  await evaluate('document.querySelector("#activate").remove()', true)
  await wait('!document.querySelector("[data-host-hints]")', 'guest mutation cancellation')
  for (const letter of staleButton.key) await key(letter)
  assert.equal(await evaluate('window.fixtureClicks', true), 0)
  assertions.push('removed target cancels labels and cannot receive stale activation')
  await evaluate('window.communitySmoke.vim(false)')
  await focusGuest()
  await key('f')
  assert.equal(await evaluate('!!document.querySelector("[data-host-hints]")'), false)
  await evaluate('window.communitySmoke.vim(true)')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'Vim reenable')
  await evaluate('window.communitySmoke.visible(false)')
  await wait('!document.querySelector("[data-host-hints]")', 'hide cancellation')
  await evaluate('window.communitySmoke.visible(true)')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'new visible presentation')
  await key('Escape')
  const oldGeneration = await evaluate('window.fixtureGeneration', true)
  await start()
  await evaluate('location.reload()', true)
  await wait(
    '!document.querySelector("[data-host-hints]")',
    'exact guest document reload invalidation',
  )
  await wait(
    'window.fixtureGeneration !== ' + oldGeneration,
    'new exact guest document generation',
    true,
  )
  await replayFromGuest(realSnapshot)
  await sleep(100)
  assert.equal(
    await evaluate('!!document.querySelector("[data-host-hints]")'),
    false,
    'prior document nonce must not authorize a snapshot in the replacement guest',
  )
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'reloaded guest recovery')
  await key('Escape')
  assertions.push(
    'Vim disable, hide/show and exact guest document reload invalidate; the new document generation recovers',
  )
  await clickGuestSelector('input[aria-label="Editable fixture"]')
  await key('f')
  assert.equal(
    await evaluate(
      'document.querySelector("input[aria-label=\\"Editable fixture\\"]").value',
      true,
    ),
    'f',
  )
  assert.equal(await evaluate('!!document.querySelector("[data-host-hints]")'), false)
  await start()
  const overlayHint = (await hints()).find((hint) => hint.target === 'Open overlay')
  assert(overlayHint?.key, 'overlay trigger label absent')
  for (const letter of overlayHint.key) await key(letter)
  await wait('!document.querySelector("[data-host-hints]")', 'overlay activation invalidation')
  await focusGuest()
  await key('f')
  assert.equal(
    await evaluate('!!document.querySelector("[data-host-hints]")'),
    false,
    'overlay must suppress hints',
  )
  await clickGuestSelector('#overlay-toggle')
  await clickGuestSelector('input[aria-label="Composition fixture"]')
  await cdp('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 })
  assert.equal(
    await evaluate(
      'document.querySelector("input[aria-label=\\"Composition fixture\\"]").value',
      true,
    ),
    '漢',
  )
  await key('f')
  assert.equal(
    await evaluate(
      'document.querySelector("input[aria-label=\\"Composition fixture\\"]").value.startsWith("漢")',
      true,
    ),
    true,
    'native typing changed in-progress IME composition',
  )
  assert.equal(
    await evaluate('!!document.querySelector("[data-host-hints]")'),
    false,
    'native composition input must not start hints',
  )
  assertions.push(
    'active editable typing is unchanged; overlay and composing input suppress hint activation',
  )
  await evaluate(
    '(()=>{const pane=document.createElement("section");pane.dataset.pane="";pane.dataset.paneFocused="true";pane.hidden=true;pane.style.cssText="position:fixed;right:16px;top:16px";pane.textContent="Other pane";document.body.append(pane)})()',
  )
  await start()
  await key('Escape')
  await wait('!document.querySelector("[data-host-hints]")', 'retained hidden pane cancellation')
  await evaluate(
    '(()=>{const panes=document.querySelectorAll("[data-pane]");panes[1].hidden=false;panes[0].setAttribute("data-pane-focused","false");panes[1].setAttribute("data-pane-focused","true")})()',
  )
  await focusGuest()
  await key('f')
  await sleep(200)
  assert.equal(await evaluate('!!document.querySelector("[data-host-hints]")'), false)
  await evaluate(
    '(()=>{const panes=document.querySelectorAll("[data-pane]");panes[0].setAttribute("data-pane-focused","true");panes[1].setAttribute("data-pane-focused","false")})()',
  )
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'focused split pane recovery')
  await evaluate(
    '(()=>{const panes=document.querySelectorAll("[data-pane]");panes[0].setAttribute("data-pane-focused","false");panes[1].setAttribute("data-pane-focused","true")})()',
  )
  await wait('!document.querySelector("[data-host-hints]")', 'split focus transition cancellation')
  await evaluate(
    '(()=>{const panes=document.querySelectorAll("[data-pane]");panes[1].remove();panes[0].setAttribute("data-pane-focused","true")})()',
  )
  assertions.push(
    'split panes restrict guest hints to the exact focused pane; focus changes cancel and a hidden pane does not interfere with the primary pane',
  )
  await evaluate(
    '(()=>{const activate=document.querySelector("#activate");const prefixes=document.createElement("div");prefixes.className="key-padding";prefixes.setAttribute("aria-label","Native hint prefix fixtures");prefixes.style.cssText="display:flex;flex-wrap:wrap;gap:1px;margin:4px 0";for(let index=1;index<=40;index++){const button=document.createElement("button");button.type="button";button.textContent="Prefix fixture "+String(index).padStart(2,"0");button.style.cssText="font-size:10px;margin:1px;padding:2px";prefixes.append(button)}activate.before(prefixes)})()',
    true,
  )
  await focusGuest()
  const recordingStartedAt = process.hrtime.bigint()
  const recorder = createNativeProofRecorder({
    evaluate,
    captureScreenshot: () => cdp('Page.captureScreenshot', { format: 'png', fromSurface: true }),
    frames: screencastFrames,
    startedAt: recordingStartedAt,
  })
  await recorder.recordUnassertedFrame('initial')
  await sleep(500)
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'final light proof session')
  await sleep(500)
  await writeFile(
    join(evidence, 'light.png'),
    await recorder.recordFrame('light-hints', 'Native button'),
  )
  const finalButton = (await hints()).find((hint) => hint.target === 'Native button')
  assert(
    finalButton?.key && finalButton.key.length > 1,
    'native final target needs a visible key-selection prefix',
  )
  await key(finalButton.key[0])
  await wait(
    `!!document.querySelector("[data-host-hints] [data-hint-target=\\"Native button\\"]")`,
    'native key prefix remains visibly selected',
  )
  await sleep(500)
  await recorder.recordFrame('key-selection', 'Native button')
  for (const letter of finalButton.key.slice(1)) await key(letter)
  await wait('window.fixtureClicks===1', 'final native button activation', true)
  await sleep(500)
  await recorder.recordUnassertedFrame('activation-result')
  await evaluate('document.documentElement.dataset.theme="dark"')
  await focusGuest()
  await key('f')
  await wait('!!document.querySelector("[data-host-hints]")', 'dark theme proof session')
  await sleep(500)
  await writeFile(
    join(evidence, 'dark.png'),
    await recorder.recordFrame('dark-hints', 'Native button'),
  )
  await sleep(500)
  await key('Escape')
  assert(screencastFrames.length > 0, 'native screenshot recording produced no frames')
  assert(
    screencastFrames.every(
      (frame, index) =>
        Number.isFinite(frame.timestamp) &&
        (index === 0 || frame.timestamp > screencastFrames[index - 1].timestamp),
    ),
    'native frame timestamps must be finite and strictly increasing in one monotonic domain',
  )
  assertions.push(
    'native activation succeeds and actual native frames preserve the visible hint session',
  )
  await evaluate('document.documentElement.dataset.theme="dark"')
  await shot('dark-activated.png')
  await evaluate(
    'window.holiSmoke.call("community.remove",{id:"smoke-plugin"}).then(()=>window.communitySmoke.refresh())',
  )
  await wait('!document.querySelector("iframe")', 'consent/install removal detaches frame')
  let removedProcess = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(supervisedServerPid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        removedProcess = true
        break
      }
      throw error
    }
    await sleep(100)
  }
  assert(removedProcess, 'community removal left the actual fixture process alive')
  assertions.push('real community removal stops supervised process and removes eligible frame')
} catch (error) {
  failure = error
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      await quit?.().catch(() => undefined)
      await Promise.race([closed, sleep(8000)])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([closed, sleep(5000)])
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await closed
      }
    } catch (error) {
      failure ??= error
    }
  }
  if (closeResult && (closeResult.code !== 0 || closeResult.signal !== null))
    failure ??= new Error(`Electron did not exit cleanly: ${JSON.stringify(closeResult)}`)

  ws?.close()
  let fixturePid = 0
  let fixtureServerStopped = false
  try {
    const install = JSON.parse(
      await readFile(join(root, 'profile/plugins/installed.json'), 'utf8').catch(() => '[]'),
    ).find((item) => item.id === 'smoke-plugin')
    const installedCode = install
      ? join(root, 'profile/plugins/smoke-plugin', install.source.commit, install.source.path)
      : null
    const stopped = await stopOwnedCommunityFixture({ installedCode, pluginPort, sleep })
    fixturePid = stopped.pid
    fixtureServerStopped = stopped.stopped
    assert(fixtureServerStopped, `fixture process ${fixturePid} still alive`)
  } catch (error) {
    failure ??= error
  }

  cdpClient?.close()
  let runtimeRemoved = false
  try {
    await rm(root, { recursive: true, force: true })
    runtimeRemoved = true
  } catch (error) {
    failure ??= error
  }
  try {
    await writeFile(join(evidence, 'electron.log'), log)
    const artifactNames = ['dark.png', 'light.png', 'activation.webm']
    try {
      if (screencastFrames.length)
        await finalizeScreencast(screencastFrames, {
          root: evidence,
          evidence,
          filename: 'activation.webm',
        })
    } catch (error) {
      failure ??= error
    }
    const exists = []
    for (const name of artifactNames) {
      try {
        const stat = await import('node:fs/promises').then(({ stat }) => stat(join(evidence, name)))
        if (stat.isFile() && stat.size > 0) exists.push(name)
      } catch {}
    }
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          passed: !failure && exists.length === artifactNames.length && runtimeRemoved,
          command: `node apps/desktop/scripts/run-community-hints-native-smoke.mjs ${evidence}`,
          source: {
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            dirty:
              execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length >
              0,
          },
          assertions,
          artifacts: exists,
          failure:
            failure?.stack ??
            (!runtimeRemoved
              ? 'Disposable runtime directory was not removed'
              : exists.length !== artifactNames.length
                ? 'Required artifacts missing'
                : undefined),
          cleanup: {
            runtimeRemoved,
            electronStopped: !child || child.exitCode !== null || child.signalCode !== null,
            electronClose: closeResult,
            fixtureServerStopped,
          },
        },
        null,
        2,
      ),
    )
  } catch (error) {
    await writeFile(join(evidence, 'cleanup-error.txt'), String(error))
    failure ??= error
  }
}
if (failure) throw failure
const report = JSON.parse(await readFile(join(evidence, 'result.json'), 'utf8'))
assert(report.passed, 'native proof report did not pass')
console.log(`Community hints native proof passed: ${evidence}`)
