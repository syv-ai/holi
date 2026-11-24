import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixtureOrigins } from './mdx-native-network-observation.ts'

export async function runExternalNativeAcceptance(
  page,
  {
    artifact,
    fixtureSha,
    checks,
    report: external,
    editAndWaitForSave,
    captureScreenshot,
    record,
    appendLog,
    ui,
  },
) {
  const {
    delay,
    waitFor,
    clickPointerAt,
    findInFile,
    cleanDiagnostics,
    settledPaint,
    windowStatus,
  } = ui
  const remote = 'fixture/isolated-mdx'
  const probePath = 'notes/probe.mdx'
  const [rawOrigin, redirectOrigin, cdnOrigin] = fixtureOrigins
  const publicEntry = `${rawOrigin}/syv-ai/holi/${fixtureSha}/apps/desktop/scripts/fixtures/mdx-external/entry.js`
  const source = `import '${publicEntry}'\n\n# External diagnostics fixture\n`
  const allow = (origin) => `Allow ${origin}`
  const deny = (origin) => `Deny ${origin}`
  const revoke = (origin) => `Revoke ${origin}`
  const trigger = 'MDX resources'
  const runDiagnostics = 'Run diagnostics'
  const parts = ['entry', 'relative', 'redirect', 'cdn']
  const button = (label) =>
    page.evaluate(`(() => {
    const match = Array.from(document.querySelectorAll('button,[role="button"]')).find(item =>
      (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)} &&
      !item.closest('[aria-hidden="true"],[inert]') && item.getClientRects().length &&
      getComputedStyle(item).visibility === 'visible' && !item.matches(':disabled,[aria-disabled="true"]'));
    if (!match) return null;
    const {x, y, width, height} = match.getBoundingClientRect();
    const point = {x: x + width / 2, y: y + height / 2};
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && match.contains(hit) ? point : null;
  })()`)
  const clickAt = (point) => clickPointerAt(page, point)
  const click = async (label) => clickAt(await waitFor(() => button(label), label))
  const openResources = async (expected) => {
    const deadline = performance.now() + 30000
    for (;;) {
      const state = await waitFor(
        async () => {
          if (await button(expected)) return { ready: true }
          // Mutations may close the panel or leave it open while state refreshes.
          const open =
            await page.evaluate(`Array.from(document.querySelectorAll('button')).some(item =>
          (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(trigger)} &&
          (item.getAttribute('aria-expanded') === 'true' || item.getAttribute('data-state') === 'open'))`)
          const point = !open && (await button(trigger))
          return point ? { point } : false
        },
        expected,
        Math.max(0, deadline - performance.now()),
      )
      if (state.ready) return
      if (performance.now() >= deadline) throw new Error(`Timed out opening ${expected}`)
      await clickAt(state.point)
    }
  }
  const ready = () =>
    waitFor(
      () => page.evaluate('!!window.__mdxSmoke && !!document.querySelector(".cm-editor")'),
      'current FileView document',
    )
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
  const cancelled = /cancel|supersed|unavailable|invalidated/i
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
  const capture = async (stage) => {
    const status = await windowStatus(page)
    external.snapshots[stage] = { ...status.network, pushes: status.resourcePushes }
    return external.snapshots[stage]
  }
  const noNewTraffic = (before, after, label) => {
    for (const field of ['dns', 'socket'])
      assert.equal(after[field], before[field], `${label}: ${field} activity`)
    assert.equal(after.requests.length, before.requests.length, `${label}: HTTP request activity`)
    assert.equal(
      after.responses.length,
      before.responses.length,
      `${label}: HTTP response activity`,
    )
    requireOnlyDestinations(after, before, [], label)
  }
  const requireRoutes = (snapshot, start, allowed) => {
    const sent = snapshot.requests.slice(start.requests.length)
    assert(
      sent.every(({ route, get, credentials }) => allowed.includes(route) && get && !credentials),
      'An unapproved route or credential-bearing/non-GET request reached Node HTTPS',
    )
    assert.deepEqual(
      [...new Set(sent.map(({ route }) => route))].sort(),
      [...allowed].sort(),
      'Expected production HTTPS requests were not observed',
    )
  }
  const requireResponse = (snapshot, route, test) => {
    assert(
      snapshot.responses.some((entry) => entry.route === route && test(entry.status)),
      `No expected public HTTPS response for ${route}`,
    )
  }

  try {
    external.stage = 'pre-consent and denial'
    const isolated = await windowStatus(page)
    assert.equal(isolated.ambientCookieHosts, 3)
    const before = await capture('beforeEditing')
    await editAndWaitForSave(source, 'unapproved external source')
    try {
      await findInFile(page, 'External diagnostics fixture')
    } catch (error) {
      await captureScreenshot('find-failure.png').catch(() => {})
      const errors = await page.evaluate('window.__mdxSmoke?.errors').catch(() => null)
      if (errors?.length) appendLog(`\nFind renderer errors: ${JSON.stringify(errors)}\n`)
      throw error
    }
    await openResources(allow(rawOrigin))
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'unapproved external import diagnostic',
    )
    await page.evaluate(`window.__mdxSmoke.theme('light')`)
    await settledPaint(page)
    await captureScreenshot('resources-light.png')
    await page.evaluate(`window.__mdxSmoke.theme('dark')`)
    await settledPaint(page)
    await captureScreenshot('resources-dark.png')
    await click(deny(rawOrigin))
    const denial = await waitFor(
      () => page.evaluate('window.holiSmoke.denialReceipt()'),
      'production Deny mutation receipt',
    )
    assert.deepEqual(denial, { ok: true }, 'The application router did not dismiss the request')
    await openResources(runDiagnostics)
    await waitFor(
      () =>
        page.evaluate(`(() => {
        const panel = document.querySelector('[role="dialog"][aria-label="MDX resources"]');
        return !!panel && !panel.querySelector('[role="alert"],[role="status"]') &&
          !Array.from(panel.querySelectorAll('button')).some(item => item.getAttribute('aria-label') === ${JSON.stringify(allow(rawOrigin))}) &&
          Array.from(panel.querySelectorAll('button')).some(item => item.textContent.trim() === ${JSON.stringify(runDiagnostics)} && !item.disabled);
      })()`),
      'Deny completed, request absent and idle resource panel without error',
    )
    noNewTraffic(
      before,
      await capture('denied'),
      'vault trust and explicit denial do not authorize the public origin',
    )
    checks.push(
      'unapproved source remains editable, saved and findable with zero observed Node DNS, socket and HTTP activity',
      'production resource denial completed and dismissed the request without error or traffic',
    )

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
    noNewTraffic(before, await capture('preventedNavigationRetry'), 'prevented navigation Retry')
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
    noNewTraffic(before, await capture('committedErrorPageRecovery'), 'committed error-page race')
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
    await refuse(
      rpc(approval()),
      'The previous saved source could still be approved',
      staleResource,
    )
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
    noNewTraffic(before, await capture('staleRequests'), 'stale or wrong native ownership')
    checks.push(
      'wrong native document, superseded generation, saved-source replacement and document reload refuse stale approval IDs',
    )

    external.stage = 'relative and transitive graph'
    await click(allow(rawOrigin))
    await openResources(allow(redirectOrigin))
    const allowTransitive = await waitFor(
      () => button(allow(redirectOrigin)),
      'transitive approval',
    )
    const transitive = await capture('transitiveConsentPending')
    requireOnlyDestinations(transitive, before, [rawOrigin], 'before transitive origin consent')
    requireTransport(transitive, before, [rawOrigin])
    requireRoutes(transitive, before, ['entry', 'relative'])
    for (const route of ['entry', 'relative'])
      requireResponse(transitive, route, (code) => code === 200)
    assert(transitive.pushes > before.pushes, 'Production approval did not push invalidation')
    checks.push(
      'approved HTTPS entry and relative child fetched; zero observed Node DNS, TLS/socket or HTTP for the transitive origin, redirect target or unexpected/unattributed traffic',
    )

    external.stage = 'cross-origin redirect'
    await clickAt(allowTransitive)
    await openResources(allow(cdnOrigin))
    const video = record ? await record() : null
    if (video) await delay(700)
    const allowRedirectTarget = await waitFor(
      () => button(allow(cdnOrigin)),
      'redirect target approval',
    )
    const redirect = await capture('redirectConsentPending')
    requireOnlyDestinations(
      redirect,
      transitive,
      [rawOrigin, redirectOrigin],
      'before redirect target consent',
    )
    requireTransport(redirect, transitive, [rawOrigin, redirectOrigin])
    requireRoutes(redirect, transitive, ['entry', 'relative', 'redirect'])
    requireResponse(redirect, 'redirect', (code) => [301, 302, 303, 307, 308].includes(code))
    checks.push(
      'actual HTTPS redirect discovered a new origin with zero observed Node DNS, TLS/socket or HTTP for it or unexpected/unattributed traffic',
    )

    external.stage = 'approved dependency success'
    await clickAt(allowRedirectTarget)
    await waitFor(
      () => cleanDiagnostics(page),
      'clean FileView diagnostics after approval of all three public origins',
    )
    const approved = await capture('allApproved')
    const origins = [rawOrigin, redirectOrigin, cdnOrigin]
    requireOnlyDestinations(approved, redirect, origins, 'after all origins approved')
    requireTransport(approved, redirect, origins)
    requireRoutes(approved, redirect, parts)
    requireResponse(approved, 'cdn', (code) => code === 200)
    assert(approved.pushes > redirect.pushes, 'Final approval did not push invalidation')
    assert.equal(
      await page.evaluate('globalThis.__mdxSmokeExecuted === undefined'),
      true,
      'External fixture code executed in FileView',
    )
    assert.equal(
      await page.evaluate(`window.holiSmoke.call('smoke:guest-healthy')`),
      true,
      'The compiler guest policy probe failed during external diagnostics',
    )
    checks.push(
      'all three approved origins produced clean diagnostics with no cookie, authorization or proxy-authorization headers on observed Node HTTPS requests',
    )

    external.stage = 'userinfo rejection and pre-transport revoke'
    lease = await probeLease()
    const credentialUrl = publicEntry.replace('https://', 'https://synthetic-user:synthetic-only@')
    const unsafe = await call('compile', {
      lease,
      generation: 1,
      source: `import '${credentialUrl}'`,
    })
    assert(unsafe.length > 0, 'A credential-bearing URL was accepted')
    assert.equal((await call('externalResources', { lease }, 'query')).pending.length, 0)
    noNewTraffic(approved, await capture('userinfoRejected'), 'credential-bearing URL')
    checks.push(
      'URL userinfo is rejected even for an approved origin without observed Node DNS, socket or HTTP activity',
    )

    await openResources(revoke(rawOrigin))
    if (video) await delay(700)
    const held = wire('compile', { lease, generation: 2, source })
    await page.evaluate(`(async () => {
      const ready = window.holiSmoke.call('smoke:hold-compiler');
      window.__mdxHeld = window.holi.trpc(${JSON.stringify(held)});
      return ready;
    })()`)
    await click(revoke(rawOrigin))
    await refuse(
      page.evaluate('window.__mdxHeld'),
      'The native compile held before transport returned stale diagnostics',
      cancelled,
    )
    await openResources(allow(rawOrigin))
    const revoked = await capture('originRevoked')
    noNewTraffic(
      approved,
      revoked,
      'revoked origin including in-flight native compiler and pushed retry',
    )
    assert(revoked.pushes > approved.pushes, 'Revocation did not push invalidation')
    assert.equal(await button(revoke(rawOrigin)), null, 'Revoked origin still appeared granted')
    const remaining = await call('externalResources', { lease }, 'query')
    assert.deepEqual(remaining.approved.map(({ origin }) => origin).sort(), [
      cdnOrigin,
      redirectOrigin,
    ])
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'diagnostic restored after revocation',
    )
    await captureScreenshot('resources-revoked.png')
    if (video) await delay(700)
    await call('releaseDiagnosticsLease', { lease })
    await editAndWaitForSave(
      '# Editable after resource revocation\n',
      'source after resource revocation',
    )
    await waitFor(
      () => cleanDiagnostics(page),
      'local diagnostics remain usable after resource revocation',
    )
    assert.equal(
      await page.evaluate(
        'window.__mdxSmoke.source() === "# Editable after resource revocation\\n"',
      ),
      true,
    )
    checks.push(
      'revocation cancels a held native compiler before transport; push restores the request without traffic and editing/saving still work',
    )
    external.stage = 'client-side HTTPS stream revocation'
    // The FileView is on a clean local source; the probe lease streams using
    // the same account/vault approval while the real revoke control stays ready.
    await openResources(revoke(cdnOrigin))
    if (video) await delay(700)
    lease = await probeLease()
    const streamUrl = await page.evaluate(`window.holiSmoke.call('smoke:arm-stream')`)
    const observeStream = () => page.evaluate(`window.holiSmoke.call('smoke:stream-status')`)
    const beforeStream = await capture('beforeStream')
    const streaming = wire('compile', { lease, generation: 1, source: `import '${streamUrl}'` })
    const streamEvidence = {
      backpressure:
        'Fixture paused one real TLS socket after a buffered body chunk, suppressing socket resumes until close; client-side evidence only',
      beforeRevoke: null,
      afterRevoke: null,
      compileRejected: false,
    }
    external.streamRevocation = streamEvidence
    const started = performance.now()
    await page.evaluate(
      `void (window.__mdxStreaming = window.holi.trpc(${JSON.stringify(streaming)}))`,
    )
    try {
      await waitFor(
        async () => {
          const observed = await observeStream()
          return (observed?.active || observed?.closed) && observed
        },
        'authorized TLS socket with a buffered incomplete response',
        6500,
      )
      const point = await button(revoke(cdnOrigin))
      assert(point, 'The FileView revoke control is not actionable while the probe streams')
      streamEvidence.beforeRevoke = await observeStream()
      assert(
        streamEvidence.beforeRevoke?.active && streamEvidence.beforeRevoke.requests === 1,
        'Did not observe exactly one active, paused HTTPS stream at the revoke click',
      )
      await clickAt(point)
      streamEvidence.afterRevoke = await waitFor(
        async () => {
          const observed = await observeStream()
          return observed?.closed && observed
        },
        'revocation-driven TLS socket close',
        2000,
      )
      // Do not credit an AbortError/close from the independent 8-second fetch deadline.
      streamEvidence.closeObservedWithinMs = Math.ceil(performance.now() - started)
      assert(
        streamEvidence.closeObservedWithinMs < 8000,
        'Closure was not observed before the transport deadline',
      )
      assert(streamEvidence.afterRevoke.abortError, 'Client transport reported no AbortError')
      assert(
        streamEvidence.afterRevoke.incompleteAtClose,
        'HTTPS response completed instead of being cancelled',
      )
      await refuse(
        page.evaluate('window.__mdxStreaming'),
        'The native compile streaming over HTTPS returned stale diagnostics',
        cancelled,
      )
      streamEvidence.compileRejected = true
    } finally {
      streamEvidence.lastObservation = await observeStream().catch(() => null)
    }

    const retrySource = `import '${streamUrl}'\n\n# Stalled stream retry requires consent\n`
    await editAndWaitForSave(retrySource, 'source after streaming origin was revoked')
    await openResources(allow(cdnOrigin))
    const streamRevoked = await capture('streamOriginRevoked')
    requireOnlyDestinations(
      streamRevoked,
      beforeStream,
      [cdnOrigin],
      'HTTPS stream and revoked retry',
    )
    requireTransport(streamRevoked, beforeStream, [cdnOrigin])
    requireRoutes(streamRevoked, beforeStream, ['stream'])
    for (const field of ['resolve4', 'resolve6', 'tls', 'httpCreated', 'httpStarted']) {
      assert.equal(
        streamRevoked.destinations[cdnOrigin][field] - beforeStream.destinations[cdnOrigin][field],
        1,
        `More than one operation for the streamed or revoked origin: ${field}`,
      )
    }
    assert(
      streamRevoked.pushes > beforeStream.pushes,
      'Stream revocation did not push invalidation',
    )
    assert.deepEqual(
      (await call('externalResources', { lease }, 'query')).approved.map(({ origin }) => origin),
      [redirectOrigin],
    )
    await captureScreenshot('resources-stream-revoked.png')
    checks.push(
      'FileView revocation aborts a real authorized HTTPS stream stalled by forced client backpressure, closes its socket before response completion/deadline, rejects the compile, and prevents a subsequent fetch',
    )
    await call('releaseDiagnosticsLease', { lease })
    if (video) {
      await delay(700)
      await video()
    }
    external.stage = 'complete'
  } finally {
    // Preserve only bounded counts and booleans even on public DNS/CDN failures.
    await capture('finalObservation').catch(() => {})
  }
}

function requireOnlyDestinations(current, baseline, allowed, label) {
  const destinations = [...fixtureOrigins, 'unexpected', 'unattributed']
  for (const destination of destinations) {
    assert(current.destinations?.[destination], `${label}: destination observation unavailable`)
    if (!allowed.includes(destination)) {
      assert.deepEqual(
        current.destinations[destination],
        baseline.destinations[destination],
        `${label}: unexpected Node network activity for ${destination}`,
      )
    }
  }
  for (const [field, total] of [
    ['dnsResources', current.dns],
    ['socketResources', current.socket],
    ['httpStarted', current.requests.length],
  ]) {
    assert.equal(
      destinations.reduce((sum, origin) => sum + current.destinations[origin][field], 0),
      total,
      `${label}: ${field} observations do not account for the aggregate`,
    )
  }
}

function requireTransport(current, baseline, origins) {
  for (const origin of origins) {
    for (const field of [
      'resolve4',
      'resolve6',
      'dnsResources',
      'socketResources',
      'tls',
      'verifiedPeer',
      'httpCreated',
      'httpStarted',
    ]) {
      assert(
        current.destinations[origin]?.[field] > baseline.destinations[origin]?.[field],
        `Actual ${field} observation unavailable for ${origin}`,
      )
    }
    const now = current.destinations[origin]
    const before = baseline.destinations[origin]
    assert.equal(
      now.verifiedPeer - before.verifiedPeer,
      now.tls - before.tls,
      `Not all TLS connections for ${origin} had a verified matching peer`,
    )
  }
}
