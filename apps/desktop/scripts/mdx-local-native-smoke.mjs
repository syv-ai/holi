import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureOrigins } from './mdx-native-fixture-constants.mts'

export async function runLocalNativeAcceptance(
  page,
  { isolation, checks, report: external, ui, captureScreenshot },
) {
  const { waitFor, windowStatus, cleanDiagnostics } = ui
  const evaluate = page.evaluate
  let positionedDiagnostics
  let nativeScenarios
  const click = (label) =>
    evaluate(
      `(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()===${JSON.stringify(label)}); if(!button) throw Error('missing button '+${JSON.stringify(label)}); button.click(); return true })()`,
    )
  await waitFor(
    () =>
      evaluate(
        `document.body.innerText.includes('Review MDX trust') && document.querySelector('.cm-editor')`,
      ),
    'production MDX FileView and trust control',
  )
  await click('Review MDX trust')
  await waitFor(
    () =>
      evaluate(
        `!![...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==='Approve vault')`,
      ),
    'production MDX approval dialog',
  )
  const preApproval = await windowStatus(page)
  assert.equal(preApproval.guestCreations, 0, 'compiler guest existed before approval')
  assert.equal(preApproval.inspectedSources, 0, 'source was delivered before approval')
  assert.equal(preApproval.guestProbes.length, 0, 'compiler guest was probed before approval')
  const preTrust = (external.snapshots.beforeVaultTrust = preApproval.network)
  assert.equal(preTrust.dns, 0, 'Node DNS activity before vault trust')
  assert.equal(preTrust.socket, 0, 'Node socket activity before vault trust')
  assert.deepEqual(preTrust.requests, [], 'Node HTTP requests before vault trust')
  assert.deepEqual(preTrust.responses, [], 'Node HTTP responses before vault trust')
  for (const destination of [...fixtureOrigins, 'unexpected', 'unattributed']) {
    assert(preTrust.destinations[destination], `Missing pre-trust observation for ${destination}`)
    for (const [counter, value] of Object.entries(preTrust.destinations[destination]))
      assert.equal(value, 0, `Node ${counter} before vault trust for ${destination}`)
  }
  checks.push('absolute zero observed Node DNS, TLS/socket or HTTP activity before vault trust')
  await click('Approve vault')
  const guest = await waitFor(async () => {
    const state = await windowStatus(page)
    return state.guestProbes?.find(
      (probe) => probe.url === 'https://mdx-compiler.invalid/guest.html',
    )
  }, 'actual isolated compiler guest probe')
  assert.deepEqual(guest.result.globals, {
    process: 'undefined',
    require: 'undefined',
    holi: 'undefined',
    electron: 'undefined',
    bridge: 'undefined',
  })
  assert.deepEqual(guest.result.storage, { hasCookies: false, local: 0, session: 0 })
  assert.equal(
    guest.result.hasCredentialMarker,
    false,
    'default-session fixture credential leaked into compiler guest',
  )
  checks.push('actual compiler guest has no privileged globals or session data')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>/^\\d+ MDX diagnostic/.test(el.textContent.trim()))`,
      ),
    'production FileView compiler diagnostic',
  )
  const diagnostic = await evaluate(
    `JSON.stringify({source:window.__mdxSmoke.source(),message:[...document.querySelectorAll('[aria-live="polite"]')].map((el)=>el.textContent).find((text)=>/^\\d+ MDX diagnostic/.test(text.trim())),underlines:document.querySelectorAll('.cm-lintRange-error').length,classes:[...document.querySelectorAll('.cm-editor *')].map((node)=>node.className?.baseVal??node.className).filter((name)=>String(name).includes('lint')||String(name).includes('diagnostic'))})`,
  ).then(JSON.parse)
  positionedDiagnostics = await evaluate('window.__mdxSmoke.diagnostics()')
  assert.equal(positionedDiagnostics.length, 1)
  assert.equal(positionedDiagnostics[0].line, 3)
  assert.equal(positionedDiagnostics[0].column, 14)
  assert.match(positionedDiagnostics[0].message, /expression|acorn/i)
  await captureScreenshot('diagnostics-light.png')
  await evaluate(`window.__mdxSmoke.theme('dark')`)
  await evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  )
  await evaluate(
    `Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`,
  )
  await captureScreenshot('diagnostics-dark.png')
  assert(diagnostic.source.includes('Café 🪿'), 'Unicode source was changed')
  assert(
    diagnostic.message.includes('MDX diagnostic'),
    'production editor did not display a compiler diagnostic',
  )
  assert(
    diagnostic.underlines > 0,
    `production editor diagnostic has no underline: ${JSON.stringify(diagnostic.classes)}`,
  )
  checks.push(
    'approval awaited before actual production FileView diagnostics',
    'Unicode diagnostic shown in production FileView',
  )

  const vaultRoot = isolation.vault
  const editAndWaitForSave = async (source, label) => {
    await evaluate(`window.__mdxSmoke.setSource(${JSON.stringify(source)})`)
    await waitFor(
      async () => (await readFile(join(vaultRoot, 'notes/fixture.mdx'), 'utf8')) === source,
      `${label} durable save`,
    )
  }
  await editAndWaitForSave('# Café 🪿\n\nA valid paragraph.\n', 'valid source')
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>el.textContent.includes('syntax is valid')) && document.querySelector('.cm-lintRange-error') === null`,
      ),
    'production editor clean compile',
  )
  await mkdir(join(vaultRoot, 'notes/graph'), { recursive: true })
  await writeFile(join(vaultRoot, 'notes/graph/root.jsx'), "export { value } from './nested.js'\n")
  await writeFile(join(vaultRoot, 'notes/graph/nested.js'), "export { value } from './leaf.js'\n")
  await writeFile(join(vaultRoot, 'notes/graph/leaf.js'), 'export const value = 1\n')
  await editAndWaitForSave(
    "import { value } from './graph/root.jsx'\n\nA valid graph.\n",
    'dependency graph',
  )
  await waitFor(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-live="polite"]')].some((el)=>el.textContent.includes('syntax is valid')) && document.querySelector('.cm-lintRange-error') === null`,
      ),
    'production diagnostics accept a nested MDX to JavaScript dependency graph',
  )
  checks.push(
    'nested MDX-to-JavaScript static dependency graph accepted through production FileView',
  )
  const hostile =
    "import Evil from 'file:///etc/passwd'\n\n{globalThis.__mdxSmokeExecuted = true}\n"
  await editAndWaitForSave(hostile, 'hostile source')
  await waitFor(
    () =>
      evaluate(
        `window.__mdxSmoke.diagnostics().some((item)=>/dependency|file|module/i.test(item.message))`,
      ),
    'hostile file dependency is rejected with a diagnostic',
  )
  assert(
    (await evaluate('window.__mdxSmoke.diagnostics()')).length > 0,
    'hostile dependency produced no diagnostic',
  )
  assert.equal(
    await evaluate(`globalThis.__mdxSmokeExecuted===true`),
    false,
    'compiled MDX expression was evaluated in FileView',
  )
  checks.push(
    'valid source clean',
    'hostile MDX dependency refused',
    'hostile MDX expression not evaluated by the renderer',
  )
  for (const [label, source] of [
    ['missing dependency', "import './graph/missing.jsx'\n"],
    ['protected dependency', "import './graph/secret.local.jsx'\n"],
    ['external dependency', "import 'https://example.invalid/module.js'\n"],
  ]) {
    await editAndWaitForSave(source, `${label} editable source`)
    await waitFor(
      () => evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      `${label} diagnostic`,
    )
    assert.equal(await readFile(join(vaultRoot, 'notes/fixture.mdx'), 'utf8'), source)
    checks.push(`${label}: FileView source remains editable and saved`)
  }
  await editAndWaitForSave('# recovered source\n', 'source recovery after dependency refusals')
  await waitFor(() => cleanDiagnostics(page), 'clean editor before separate local scenarios')
  assert.equal(
    await evaluate('window.__mdxSmoke.errors.length'),
    0,
    'fixture renderer reported runtime errors',
  )

  nativeScenarios = await evaluate(`window.holiSmoke.call('smoke:scenarios')`)
  assert(nativeScenarios.policy.executionChecks > 0)
  assert.equal(nativeScenarios.policy.outboundRequests, 0)
  assert.equal(nativeScenarios.recovery.crashRejected, true)
  assert.equal(nativeScenarios.recovery.timeoutRejected, true)
  assert.equal(nativeScenarios.recovery.recovered, true)
  assert.deepEqual(
    nativeScenarios.stale.map((item) => item.name).sort(),
    [
      'queued ownership revocation and in-flight release',
      'source generation cancellation',
      'view release',
      'trust revoke and reapproval',
      'account A–B–A',
      'vault A–B–A',
      'native filesystem replacement watcher',
    ].sort(),
  )
  assert(Array.isArray(nativeScenarios.graphCases) && nativeScenarios.graphCases.length >= 8)
  checks.push(
    ...nativeScenarios.graphCases.map((item) => `native graph ${item.name}: ${item.outcome}`),
  )
  checks.push(
    'real guest policy denies network, files, app URLs, popup, permission, media, navigation and download traffic',
    'real guest compiled output was not evaluated and storage was cleared',
    'real guest crash and deadline recover with fresh successful compilations',
    ...nativeScenarios.stale.map((item) => `native held compile rejects stale ${item.name}`),
  )

  return { positionedDiagnostics, nativeScenarios, editAndWaitForSave }
}
