import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runDocumentNativeAcceptance(
  page,
  { artifact, source, rawOrigin, ui, checks, report: external, resources, assertNoTraffic },
) {
  const { waitFor, windowStatus } = ui
  const { open: openResources, click } = resources
  const remote = 'fixture/isolated-mdx'
  const probePath = 'notes/probe.mdx'
  const runDiagnostics = 'Run diagnostics'
  const allow = (origin) => `Allow ${origin}`
  const wire = (name, input, type = 'mutation') => ({ path: `mdxTrust.${name}`, type, input })
  const rpc = (operation) => page.evaluate(`window.holi.trpc(${JSON.stringify(operation)})`)
  const call = async (name, input, type) => {
    const response = await rpc(wire(name, input, type))
    assert(response?.ok, `${name} refused by the application router`)
    return response.data
  }
  const refuse = async (response, label, message) => {
    const result = await response
    assert(result?.ok === false && message.test(result.message), label)
  }
  const staleResource = /MDX (?:lease|resource request) unavailable|MDX context changed/i
  const ready = () =>
    waitFor(
      () => page.evaluate('!!window.__mdxSmoke && !!document.querySelector(".cm-editor")'),
      'current FileView document',
    )
  const currentContext = async () => {
    const { context } = await call('status', { remote }, 'query')
    assert(context, 'Current trusted document has no context')
    return context
  }
  const probeLease = async (context) =>
    (
      await call('acquireDiagnosticsLease', {
        remote,
        context: context ?? (await currentContext()),
        path: probePath,
      })
    ).lease
  const pending = async (lease, generation) => {
    const diagnostics = await call('compile', { lease, generation, source })
    assert(diagnostics.length > 0, 'An unapproved graph must report diagnostics')
    const state = await call('externalResources', { lease }, 'query')
    assert.equal(state.generation, generation)
    assert.deepEqual(
      state.pending.map(({ origin }) => origin),
      [rawOrigin],
    )
    assert.equal(state.approved.length, 0)
    assert(state.pending[0].purpose, 'The server did not describe the purpose')
    return state.pending[0].id
  }
  external.stage = 'prevented navigation and Retry'
  const priorContext = await currentContext()
  const priorLease = await probeLease(priorContext)
  const beforePrevented = (await windowStatus(page)).preventedNavigations
  const otherUrl = pathToFileURL(join(artifact, 'renderer/other.html')).href
  await page.evaluate(
    `window.__mdxPriorDocument = true; location.assign(${JSON.stringify(otherUrl)}); true`,
  )
  await waitFor(
    async () => (await windowStatus(page)).preventedNavigations === beforePrevented + 1,
    'fixture window prevented a real renderer-initiated navigation',
  )
  assert.equal(await page.evaluate('window.__mdxPriorDocument'), true)
  await refuse(
    rpc(wire('externalResources', { lease: priorLease }, 'query')),
    'Provisional navigation did not retire the old lease',
    staleResource,
  )
  // Reacquire as Retry does, without issuing status again (which could mint a new context).
  await call('releaseDiagnosticsLease', { lease: await probeLease(priorContext) })
  await openResources(runDiagnostics)
  await click(runDiagnostics)
  await openResources(allow(rawOrigin))
  await assertNoTraffic('preventedNavigationRetry', 'prevented navigation Retry')
  checks.push('real prevented navigation preserves the current document and context for Retry')

  external.stage = 'committed missing-file error page'
  assert.equal(
    await page.evaluate(
      `window.holiSmoke.call('smoke:start-error-page-race', ${JSON.stringify(priorContext)})`,
    ),
    true,
  )
  await waitFor(
    () =>
      page.evaluate(
        '!window.__mdxPriorDocument && !!window.__mdxSmoke && !!document.querySelector(".cm-editor")',
      ),
    'recovered original FileView after the real missing-file navigation',
  )
  const errorPage = await page.evaluate(`window.holiSmoke.call('smoke:error-page-result')`)
  assert(errorPage?.ok, `Real error-page race failed: ${errorPage?.message}`)
  external.errorPage = errorPage.data
  const recoveredLease = await probeLease()
  await pending(recoveredLease, 1) // Fresh request, no grant from the retired approval.
  await call('releaseDiagnosticsLease', { lease: recoveredLease })
  await openResources(allow(rawOrigin))
  await assertNoTraffic('committedErrorPageRecovery', 'committed error-page race')
  checks.push(
    'owned missing-file error commit without did-navigate retires provisional work and admitted approval before FileView recovers',
  )

  external.stage = 'stale requests and application ownership'
  let lease = await probeLease()
  let requestId = await pending(lease, 1)
  const approval = () => wire('approveExternalResource', { lease, requestId })
  await refuse(
    page.evaluate(`window.holiSmoke.call('smoke:other-document', ${JSON.stringify(approval())})`),
    'A different native document could use the current view approval',
    /only to the current Holi application document/i,
  )
  await call('cancelCompile', { lease, generation: 2 })
  await refuse(rpc(approval()), 'An older source generation could be approved', staleResource)
  requestId = await pending(lease, 2)
  const write = await rpc({
    path: 'notes.write',
    type: 'mutation',
    input: { remote, path: probePath, text: '# Changed on disk\n' },
  })
  assert(write?.ok, 'The probe source was not saved through the router')
  await refuse(rpc(approval()), 'The previous saved source could still be approved', staleResource)
  lease = await probeLease()
  requestId = await pending(lease, 1)
  const retiredDocument = approval()
  await page.call('Page.enable')
  await page.call('Page.reload')
  await waitFor(
    () => page.evaluate('performance.getEntriesByType("navigation")[0]?.type === "reload"'),
    'new native application document',
  )
  await ready()
  await refuse(
    rpc(retiredDocument),
    'A reloaded application document could approve an old request',
    staleResource,
  )
  await openResources(allow(rawOrigin))
  await assertNoTraffic('staleRequests', 'stale or wrong native ownership')
  checks.push(
    'wrong native document, superseded generation, saved-source replacement and document reload refuse stale approval IDs',
  )

  return { probeLease }
}
