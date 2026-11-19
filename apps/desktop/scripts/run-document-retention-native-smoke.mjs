import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCdpClient } from './native-smoke-cdp.mjs'
import { observeChild, stopOwnedCommunityFixture } from './native-smoke-process.mjs'
import { prepareCommunityHintsNativeFixture } from './community-hints-native-fixture.mjs'
import { finalizeScreencast } from './native-smoke-recording.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = resolve(
  process.argv.slice(2).find((arg) => arg !== '--') ?? `/tmp/holi-220-native-${Date.now()}`,
)
await mkdir(evidence, { recursive: true })
assert.deepEqual(await readdir(evidence), [], 'refusing to overwrite native evidence')
const root = await realpath(await mkdtemp('/tmp/holi-220-runtime-'))
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
const fixtureFilename = 'slides.fixture'
try {
  debugPort = await port()
  pluginPort = await port()
  const { electron, env } = await prepareCommunityHintsNativeFixture({
    desktop,
    root,
    pluginPort,
    retention: true,
  })
  child = spawn(electron, [root, `--remote-debugging-port=${debugPort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log += chunk
      process.stdout.write(chunk)
    })
  const childState = observeChild(child)
  closed = childState.closed.then((result) => {
    closeResult = result
    return result
  })
  let target
  for (let n = 0; n < 120; n++) {
    if (childState.spawnFailure)
      throw new Error(`Electron launch failed: ${childState.spawnFailure}`)
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
      if (message.method === 'Page.screencastFrame') {
        screencastFrames.push({
          image: Buffer.from(message.params.data, 'base64'),
          timestamp: Number(process.hrtime.bigint()) / 1e9,
        })
        void cdpClient?.call('Page.screencastFrameAck', {
          sessionId: message.params.sessionId,
        })
      }
      if (message.method === 'Runtime.exceptionThrown')
        log += `\nrenderer exception: ${JSON.stringify(message.params.exceptionDetails)}\n`
      if (message.method === 'Runtime.consoleAPICalled')
        log += `\nrenderer console: ${JSON.stringify(message.params.args?.map((arg) => arg.value ?? arg.description))}\n`
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
  await cdp('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
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
      `timeout: ${description}; host=${await evaluate('document.body.innerText')}; html=${await evaluate('document.body.innerHTML')}; fixture=${JSON.stringify(await evaluate('window.communitySmoke?.debug?.()'))}; hostMessages=${JSON.stringify(await evaluate('window.smokeMessages'))}; guestMessages=${JSON.stringify(await evaluate('window.smokeMessages', true))}`,
    )
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
  const button = async (label) => {
    const point = await evaluate(`(() => {
      const element = [...document.querySelectorAll('button')].find(button => button.textContent === ${JSON.stringify(label)});
      if (!element) throw new Error('Missing navigation button');
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    })()`)
    await click(point.x, point.y)
  }
  const shot = async (name) => {
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    )
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true })
    await writeFile(join(evidence, name), Buffer.from(data, 'base64'))
    await sleep(400)
  }
  const visibleTitle = `document.querySelector('[data-pane-slot] input[aria-label="Meeting title"]')`
  await wait('!!document.querySelector("iframe")', 'real PluginFrame acquire')
  await wait('!!window.fixtureGeneration', 'actual guest document', true)
  await cdp('Page.bringToFront')
  const generation = await evaluate('window.fixtureGeneration', true)
  const baseline = await evaluate('window.holiSmoke.leaseEvents()')
  assert.equal(baseline.length, 1, 'one server lease initially')
  await evaluate(
    `window.retainedFrame = document.querySelector('iframe'); window.retainedWindow = window.retainedFrame.contentWindow; window.retainedLoads = 0; window.retainedFrame.addEventListener('load', () => window.retainedLoads++)`,
  )
  const guestInput = await evaluate(
    `(() => { const r = document.querySelector('input[aria-label="Editable fixture"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    true,
  )
  const framePosition = await evaluate(
    `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return {x:r.x,y:r.y}; })()`,
  )
  await click(framePosition.x + guestInput.x, framePosition.y + guestInput.y)
  await cdp('Input.insertText', { text: 'Unsaved plugin draft' })
  assert.equal(
    await evaluate(`document.querySelector('input[aria-label="Editable fixture"]').value`, true),
    'Unsaved plugin draft',
  )
  await shot('community-before.png')
  await button('Meetings')
  await wait(
    '!!document.querySelector("[data-retained-parking] iframe")',
    'community document parked',
  )
  assert.equal(await evaluate('document.querySelector("[data-retained-parking]").inert'), true)
  assert.equal(
    await evaluate('document.querySelector("[data-retained-parking]").getAttribute("aria-hidden")'),
    'true',
  )
  await wait(
    '!document.querySelector("[data-retained-parking]").contains(document.activeElement)',
    'hidden guest releases focus',
  )
  await button('Slides fixture')
  await wait('!!document.querySelector("[data-pane-slot] iframe")', 'community restored')
  await button('Split views')
  await wait(
    'document.querySelectorAll("[data-pane-slot]").length === 2',
    'two visible split slots',
  )
  assert.equal(
    await evaluate(
      'document.querySelector("iframe") === window.retainedFrame && window.retainedFrame.contentWindow === window.retainedWindow && window.retainedLoads === 0',
    ),
    true,
  )
  await shot('split.png')
  await button('Slides fixture')
  assert.equal(await evaluate('window.fixtureGeneration', true), generation)
  assert.equal(
    await evaluate(`document.querySelector('input[aria-label="Editable fixture"]').value`, true),
    'Unsaved plugin draft',
  )
  assert.deepEqual(await evaluate('window.holiSmoke.leaseEvents()'), baseline)
  assertions.push(
    'registered non-Markdown community file retains its actual iframe node, WindowProxy, page generation, load count, unsaved input and server lease across switch/back and split/single; hidden frame is parked inert and releases focus',
  )
  await shot('light.png')

  await button('Meeting folder')
  await wait(`${visibleTitle}?.value === 'Weekly review'`, 'registered .meeting folder opened')
  const titlePosition = await evaluate(
    `(() => { const r = ${visibleTitle}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  )
  await cdp('Page.bringToFront')
  await click(titlePosition.x, titlePosition.y)
  await evaluate(`${visibleTitle}.focus(); ${visibleTitle}.select()`)
  await wait(`document.activeElement === ${visibleTitle}`, 'meeting title owns native input')
  await cdp('Input.insertText', { text: 'Unsaved meeting draft' })
  await wait(`${visibleTitle}?.value === 'Unsaved meeting draft'`, 'native draft input')
  await evaluate(`void (window.retainedTitle = ${visibleTitle})`)
  await shot('meeting-before.png')
  await button('Slides fixture')
  assert.equal(await evaluate('window.retainedTitle.closest("[inert]") !== null'), true)
  assert.equal(
    await evaluate('document.querySelectorAll("[role=dialog],[role=listbox],[role=menu]").length'),
    0,
  )
  await button('Meeting folder')
  assert.equal(
    await evaluate(
      `${visibleTitle} === window.retainedTitle && ${visibleTitle}.value === 'Unsaved meeting draft'`,
    ),
    true,
  )
  await button('Split meeting folder')
  await wait('document.querySelectorAll("[data-pane-slot]").length === 2', 'meeting split visible')
  assert.equal(
    await evaluate(
      `${visibleTitle} === window.retainedTitle && ${visibleTitle}.value === 'Unsaved meeting draft'`,
    ),
    true,
  )
  await button('Meeting folder')
  await evaluate('window.communitySmoke.theme("dark")')
  await shot('dark.png')
  await evaluate('window.communitySmoke.closeMeeting()')
  await wait('!window.retainedTitle.isConnected', 'closed meeting disposes local view')
  await evaluate('window.communitySmoke.reopenMeeting()')
  await wait(`${visibleTitle}?.value === 'Weekly review'`, 'reopened meeting starts fresh')
  await evaluate(`void (window.retainedTitle = ${visibleTitle})`)
  assertions.push(
    'actual registered .meeting surface preserves the same title input and unsaved draft across switch/back and splits, hidden content is inert without foreground portals, and close/reopen resets local state',
  )

  await button('Slides fixture')
  await evaluate('window.communitySmoke.close()')
  await wait('!document.querySelector("iframe")', 'closed community document disposed')
  await wait(
    'window.holiSmoke.leaseEvents().then(events => events.length === 2)',
    'lease released exactly once',
  )
  await evaluate('window.communitySmoke.reopen()')
  guestSession = undefined
  await wait('!!document.querySelector("iframe")', 'new community iframe')
  await wait('!!window.fixtureGeneration', 'new guest document', true)
  assert.notEqual(await evaluate('window.fixtureGeneration', true), generation)
  assert.equal(
    await evaluate(`document.querySelector('input[aria-label="Editable fixture"]').value`, true),
    '',
  )
  await wait(
    'window.holiSmoke.leaseEvents().then(events => events.length === 3)',
    'new lease after reopen',
  )
  await evaluate('window.communitySmoke.depart()')
  await wait(
    '!document.querySelector("iframe") && !window.retainedTitle.isConnected',
    'vault departure disposes views',
  )
  await wait(
    'window.holiSmoke.leaseEvents().then(events => events.length === 4)',
    'departure releases live lease exactly once',
  )
  assertions.push(
    'close/reopen resets guest-local input and page generation with one release and fresh acquire; vault departure disposes retained views and releases the live lease',
  )
  await cdp('Page.stopScreencast')
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
    const stopped = await stopOwnedCommunityFixture({
      installedCode,
      pluginPort,
      filename: fixtureFilename,
      sleep,
    })
    fixturePid = stopped.pid
    fixtureServerStopped = stopped.stopped
    assert(fixtureServerStopped, `fixture process ${fixturePid} still alive`)
  } catch (error) {
    failure ??= error
  }

  cdpClient?.close()
  let runtimeRemoved = false
  const ownershipSafeToRemove =
    fixtureServerStopped && (!child || child.exitCode !== null || child.signalCode !== null)
  if (ownershipSafeToRemove) {
    try {
      await rm(root, { recursive: true, force: true })
      runtimeRemoved = true
    } catch (error) {
      failure ??= error
    }
  }
  try {
    await writeFile(join(evidence, 'electron.log'), log)
    const artifactNames = ['dark.png', 'light.png', 'meeting-before.png', 'activation.webm']
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
          command: `node apps/desktop/scripts/run-document-retention-native-smoke.mjs ${evidence}`,
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
console.log(`Document retention native proof passed: ${evidence}`)
