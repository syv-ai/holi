import { createMdxNativeResourceControls } from './mdx-native-resource-controls.mjs'
import { assertMdxNativeApprovalOrder } from './mdx-native-approval-receipt.mts'
import { createMdxSmokeClient } from './mdx-native-smoke-client.mjs'
import assert from 'node:assert/strict'
import { runDocumentNativeAcceptance } from './mdx-document-native-smoke.mjs'
import { fixtureOrigins } from './mdx-native-fixture-constants.mts'

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
  const { wire, call, refuse } = createMdxSmokeClient(page)

  const {
    delay,
    untilDeadline,
    waitFor,
    findInFile,
    cleanDiagnostics,
    settledPaint,
    windowStatus,
  } = ui
  const [rawOrigin, redirectOrigin, cdnOrigin] = fixtureOrigins
  const publicEntry = `${rawOrigin}/syv-ai/holi/${fixtureSha}/apps/desktop/scripts/fixtures/mdx-external/entry.js`
  const source = `import '${publicEntry}'\n\n# External diagnostics fixture\n`
  const allow = (origin) => `Allow ${origin}`
  const deny = (origin) => `Deny ${origin}`
  const revoke = (origin) => `Revoke ${origin}`
  const runDiagnostics = 'Run diagnostics'
  const parts = ['entry', 'relative', 'redirect', 'cdn']
  const { button, click, openResources } = createMdxNativeResourceControls(page, ui)
  const cancelled = /abort|cancel|supersed|unavailable|invalidated/i
  const lifecycle = [
    ['approval', rawOrigin],
    ['approval', redirectOrigin],
    ['approval', cdnOrigin],
    ['revocation', rawOrigin],
    ['revocation', cdnOrigin],
  ]
  const capture = async (stage, expectedChanges = 0) => {
    const status = await windowStatus(page)
    const snapshot = (external.snapshots[stage] = {
      ...status.network,
      pushes: status.resourcePushes,
    })
    assert.deepEqual(
      assertMdxNativeApprovalOrder(snapshot),
      lifecycle.slice(0, expectedChanges),
      `${stage}: unexpected fixture consent history`,
    )
    requireOnlyDestinations(snapshot, external.snapshots.beforeVaultTrust, fixtureOrigins, stage)
    return snapshot
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

  let finished = false
  try {
    external.stage = 'pre-consent and denial'
    const isolated = await windowStatus(page)
    assert.equal(isolated.ambientCookieHosts, 3)
    const before = await capture('beforeEditing')
    noNewTraffic(
      external.snapshots.beforeVaultTrust,
      before,
      'trusted local source before external editing',
    )
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

    const { probeLease } = await runDocumentNativeAcceptance(page, {
      artifact,
      source,
      rawOrigin,
      ui,
      checks,
      report: external,
      resources: { open: openResources, click },
      assertNoTraffic: async (snapshot, label) =>
        noNewTraffic(before, await capture(snapshot), label),
    })
    let lease
    external.stage = 'relative and transitive graph'
    await click(allow(rawOrigin))
    const transitiveDeadline = performance.now() + 30000
    await openResources(allow(redirectOrigin), transitiveDeadline)
    await waitFor(() => button(allow(redirectOrigin)), 'transitive approval', {
      deadline: transitiveDeadline,
    })
    const transitive = await untilDeadline(
      () => capture('transitiveConsentPending', 1),
      transitiveDeadline,
      'transitive consent observation',
    )
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
    await click(allow(redirectOrigin), transitiveDeadline)
    const redirectDeadline = performance.now() + 30000
    await openResources(allow(cdnOrigin), redirectDeadline)
    const video = record ? await untilDeadline(record, redirectDeadline, 'recording start') : null
    if (video) await delay(700, redirectDeadline)
    await waitFor(() => button(allow(cdnOrigin)), 'redirect target approval', {
      deadline: redirectDeadline,
    })
    const redirect = await untilDeadline(
      () => capture('redirectConsentPending', 2),
      redirectDeadline,
      'redirect consent observation',
    )
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
    await click(allow(cdnOrigin), redirectDeadline)
    await waitFor(
      () => cleanDiagnostics(page),
      'clean FileView diagnostics after approval of all three public origins',
    )
    const approved = await capture('allApproved', 3)
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
    noNewTraffic(approved, await capture('userinfoRejected', 3), 'credential-bearing URL')
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
    const revoked = await capture('originRevoked', 4)
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
    const beforeStream = await capture('beforeStream', 4)
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
    await untilDeadline(
      () =>
        page.evaluate(
          `void (window.__mdxStreaming = window.holi.trpc(${JSON.stringify(streaming)}))`,
        ),
      started + 6500,
      'streaming compile start',
    )
    try {
      await waitFor(
        async () => {
          const observed = await observeStream()
          return (observed?.active || observed?.closed) && observed
        },
        'authorized TLS socket with a buffered incomplete response',
        { deadline: started + 6500 },
      )
      const point = await untilDeadline(
        () => button(revoke(cdnOrigin)),
        started + 6500,
        'stream revocation control',
      )
      assert(point, 'The FileView revoke control is not actionable while the probe streams')
      streamEvidence.beforeRevoke = await untilDeadline(
        observeStream,
        started + 6500,
        'active stream before revocation',
      )
      assert(
        streamEvidence.beforeRevoke?.active && streamEvidence.beforeRevoke.requests === 1,
        'Did not observe exactly one active, paused HTTPS stream at the revoke click',
      )
      await click(revoke(cdnOrigin), started + 6500)
      streamEvidence.afterRevoke = await waitFor(
        async () => {
          const observed = await observeStream()
          return observed?.closed && observed
        },
        'revocation-driven TLS socket close',
        { deadline: Math.min(performance.now() + 2000, started + 8000) },
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
    const streamRevoked = await capture('streamOriginRevoked', 5)
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
    finished = true
  } finally {
    // Keep the bounded receipt even on failure, without hiding the original error.
    const final = capture('finalObservation', lifecycle.length)
    if (finished) await final
    else await final.catch(() => {})
  }
  checks.push(
    'every observed Node DNS, TLS and HTTP contact followed durable approval for its own origin in the main-process sequence',
  )
  external.stage = 'complete'
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

/** Runs only after the original five-event consent receipt has been finalized. */
export async function runNestedResourceNativeAcceptance(
  page,
  { fixtureSha, checks, report, editAndWaitForSave, captureScreenshot, record, ui },
) {
  const { waitFor, cleanDiagnostics, settledPaint, windowStatus, delay } = ui
  const cdnOrigin = fixtureOrigins[2]
  const allow = (origin) => `Allow ${origin}`
  const revoke = (origin) => `Revoke ${origin}`
  const { click, openResources } = createMdxNativeResourceControls(page, ui)

  const routes = ['nested-css', 'child-css', 'nested-font', 'nested-image', 'nested-audio']
  const source = `import '${cdnOrigin}/gh/syv-ai/holi@${fixtureSha}/apps/desktop/scripts/fixtures/mdx-external/nested.css'\n\n# Nested resource diagnostics fixture\n`
  const capture = async (stage, changes) => {
    const status = await windowStatus(page)
    const snapshot = (report.snapshots[stage] = {
      ...status.network,
      pushes: status.resourcePushes,
    })
    const history = assertMdxNativeApprovalOrder(snapshot)
    assert.equal(history.length, 5 + changes, 'Unexpected nested-resource consent history')
    assert.deepEqual(
      history.slice(5),
      [
        ['approval', cdnOrigin],
        ['revocation', cdnOrigin],
      ].slice(0, changes),
    )
    return snapshot
  }
  const noContact = (before, after, label) => {
    assert.equal(after.dns, before.dns, `${label}: DNS`)
    assert.equal(after.socket, before.socket, `${label}: sockets`)
    assert.equal(after.requests.length, before.requests.length, `${label}: requests`)
    assert.equal(after.responses.length, before.responses.length, `${label}: responses`)
    requireOnlyDestinations(after, before, [], label)
  }
  let stopVideo
  try {
    report.stage = 'pending nested CSS origin'
    const before = await capture('beforeEditing', 0)
    stopVideo = record ? await record() : null
    await editAndWaitForSave(source, 'unapproved nested CSS source')
    await openResources(allow(cdnOrigin))
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'nested CSS consent diagnostic',
    )
    noContact(before, await capture('pending', 0), 'nested CSS before Allow')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(`window.__mdxSmoke.theme('${theme}')`)
      await settledPaint(page)
      await captureScreenshot(`nested-resources-${theme}.png`)
    }
    if (stopVideo) await delay(700)
    report.stage = 'approved nested resource graph'
    await click(allow(cdnOrigin))
    await waitFor(() => cleanDiagnostics(page), 'clean nested CSS/font/image/audio diagnostics')
    const approved = await capture('approved', 1)
    requireOnlyDestinations(approved, before, [cdnOrigin], 'nested resource graph')
    requireTransport(approved, before, [cdnOrigin])
    assert(approved.pushes > before.pushes, 'Nested approval did not push invalidation')
    const requests = approved.requests.slice(before.requests.length)
    assert(
      requests.every(
        ({ route, get, credentials }) => routes.includes(route) && get && !credentials,
      ),
      'Unexpected or credential-bearing nested resource request',
    )
    assert.deepEqual([...new Set(requests.map(({ route }) => route))].sort(), [...routes].sort())
    for (const route of routes)
      assert(
        approved.responses
          .slice(before.responses.length)
          .some((entry) => entry.route === route && entry.status === 200),
        `Missing successful ${route} response`,
      )
    assert.equal(await page.evaluate('globalThis.__mdxSmokeExecuted === undefined'), true)
    report.stage = 'approved-origin guest probes'
    report.guestPolicy = await page.evaluate("window.holiSmoke.call('smoke:public-guest-policy')")
    // The receipt is Chromium's enforcing production CSP, not a failed network
    // operation. The counters below observe only Node's typed main transport.
    const guestPolicy = report.guestPolicy.policy
    for (const [name, evidence] of Object.entries(guestPolicy.evidence)) {
      assert.equal(guestPolicy.results[name], true, name)
      assert.equal(evidence.disposition, 'enforce', name)
      assert(evidence.policy && evidence.destination && evidence.blockedURI, name)
    }
    assert(guestPolicy.evidence.publicSocket, 'Missing approved-host WebSocket CSP evidence')
    noContact(approved, await capture('guestDenied', 1), 'Node transport during guest probes')
    report.stage = 'nested resource revocation'
    await openResources(revoke(cdnOrigin))
    if (stopVideo) await delay(700)
    await click(revoke(cdnOrigin))
    await openResources(allow(cdnOrigin))
    await waitFor(
      () => page.evaluate('window.__mdxSmoke.diagnostics().length > 0'),
      'nested graph retry requires renewed consent',
    )
    const revoked = await capture('revokedRetry', 2)
    noContact(approved, revoked, 'revoked nested graph retry')
    assert(revoked.pushes > approved.pushes, 'Nested revocation did not push invalidation')
    await captureScreenshot('nested-resources-revoked.png')
    await editAndWaitForSave(
      '# Editable after nested resource revocation\n',
      'local source after nested resource revocation',
    )
    await waitFor(() => cleanDiagnostics(page), 'local diagnostics after nested revocation')
    assert.equal(
      await page.evaluate(
        'window.__mdxSmoke.source() === "# Editable after nested resource revocation\\n"',
      ),
      true,
    )
    noContact(approved, await capture('editable', 2), 'local editing after nested revocation')
    if (stopVideo) await delay(700)
    checks.push(
      'nested CSS and relative child/font/image/audio use approved typed HTTPS transport with clean diagnostics; pending/revoked retries make no observed Node contact; approved-origin guest probes have enforcing production CSP evidence and no observed Node transport contact; local editing remains usable',
    )
    report.stage = 'complete'
  } finally {
    // Retain the bounded observation even if recording finalization fails.
    report.finalObservation = await windowStatus(page).then(
      (status) => status.network,
      () => null,
    )
    if (stopVideo) await stopVideo()
  }
}
