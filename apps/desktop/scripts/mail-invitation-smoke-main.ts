import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { emptyVaultSnapshot } from '@holi/shared'
import { CapabilityError, trpcCodeOf } from '../src/main/capabilities/error'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import type { TrpcEnvelope, TrpcOpWire } from '../src/renderer/src/lib/ipc-link'
import type { GoogleAccountsManager } from '../src/plugins/google/main/accounts'
import { GoogleApi } from '../src/plugins/google/main/api'
import { openGoogleCache } from '../src/plugins/google/main/cache'
import {
  disposeGoogleCapabilities,
  googleCapabilities,
  GOOGLE_NAMESPACES,
} from '../src/plugins/google/main/capabilities'
import { createGoogleData } from '../src/plugins/google/main/data'
import { createMailInvitationSession } from '../src/plugins/google/main/mail-invitation-session'
import { createMailInvitationStore } from '../src/plugins/google/main/mail-invitation-store'
import { createMailMarkerStore } from '../src/plugins/google/main/markers'
import { GOOGLE_SCOPES, GoogleSession } from '../src/plugins/google/main/session'
import type { StoredGoogleAuth } from '../src/plugins/google/main/token-store'
import {
  attachment,
  attachmentEventId,
  createInvitationTransport,
  fixtureToken,
  inline,
  mailboxA,
  mailboxB,
  occurrence,
  occurrenceId,
  organizer,
  other,
  remote,
  series,
} from './mail-invitation-smoke-fixture'

const ipc = 'holi-invitation-fixture'
const root = __dirname
const html = join(root, 'renderer.html')
const htmlUrl = pathToFileURL(html).href
const userData = join(root, 'user-data')
const journalPath = join(userData, 'google-mail-invitations.json')
const evidence = join(root, 'evidence')
const vault = join(root, 'vault')
const frames = join(root, 'frames')
const partition = 'holi-mail-invitation-smoke' // No persist: this partition lives only in this process.

function isolate() {
  assert(!app.isReady(), 'profile paths must be set before Electron readiness')
  assert.equal(root, process.env.HOLI_INVITATION_ROOT)
  assert.equal(realpathSync(root), root)
  assert.match(basename(root), /^holi-mail-invitation-/)
  assert.equal(dirname(root), realpathSync(process.env.TMPDIR!))
  assert.equal(statSync(root).uid, process.getuid?.())
  assert.equal(statSync(root).mode & 0o077, 0)
  assert(process.env.HOLI_INVITATION_NONCE)
  assert.equal(readFileSync(join(root, 'owner'), 'utf8'), process.env.HOLI_INVITATION_NONCE)
  const paths = {
    userData,
    appData: join(root, 'app-data'),
    sessionData: join(root, 'session-data'),
    logs: join(root, 'logs'),
    crashDumps: join(root, 'crash-dumps'),
    temp: join(root, 'temp'),
  } as const
  app.setName('Holi synthetic mail invitation smoke')
  for (const name of [
    'appData',
    'userData',
    'sessionData',
    'logs',
    'crashDumps',
    'temp',
  ] as const) {
    const path = paths[name]
    mkdirSync(path, { mode: 0o700 })
    app.setPath(name, path)
    assert.equal(app.getPath(name), path)
  }
  for (const path of [vault, evidence, frames]) mkdirSync(path, { mode: 0o700 })
  assert.notEqual(vault, userData)
  process.env.HOLI_VAULT_ROOT = vault
  app.commandLine.appendSwitch('disable-background-networking')
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
  app.commandLine.appendSwitch('no-proxy-server')
  shell.openExternal = async () => {
    throw new Error('System browser disabled in fixture')
  }
  return paths
}

function googleRig() {
  const transport = createInvitationTransport()
  globalThis.fetch = transport.fetch
  let current = mailboxA
  let revision = 1
  const client = { id: 'offline-fixture', source: 'shipped' } as const
  const grants = new Map<string, StoredGoogleAuth>()
  const sessions = new Map(
    [mailboxA, mailboxB].map((account) => {
      grants.set(account.sub, {
        ...account,
        accessToken: fixtureToken(account),
        refreshToken: `refresh-${account.sub}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: [...GOOGLE_SCOPES],
      })
      const session = new GoogleSession({
        account: {
          read: () => grants.get(account.sub) ?? null,
          generation: () => 1,
          async write(auth, expectedGeneration) {
            assert.equal(expectedGeneration, 1)
            assert.equal(auth.sub, account.sub)
            grants.set(account.sub, auth)
          },
          async expire() {
            throw new Error('Fixture grant must not expire')
          },
          async remove() {
            throw new Error('Fixture grant must not be removed')
          },
        },
        client: () => client,
        fetch: transport.fetch,
      })
      return [account.sub, session] as const
    }),
  )
  const data = new Map(
    [...sessions].map(([sub, session]) => {
      const store = createGoogleData({
        api: () => new GoogleApi({ accessToken: () => session.getAccessToken() }),
        cache: openGoogleCache(join(userData, `${sub}.db`)),
        markers: createMailMarkerStore(userData, sub),
      })
      store.ensureShape()
      return [session, store] as const
    }),
  )
  const accounts: Pick<
    GoogleAccountsManager,
    'sessionFor' | 'bindingFor' | 'overview' | 'list' | 'link'
  > = {
    async sessionFor(owner) {
      assert.equal(owner, remote)
      return sessions.get(current.sub)!
    },
    async bindingFor(owner) {
      assert.equal(owner, remote)
      const linkedRevision = revision
      return {
        session: sessions.get(current.sub)!,
        revision: `fixture-binding-${linkedRevision}`,
        isCurrent: () => revision === linkedRevision,
      }
    },
    async overview(owner) {
      assert.equal(owner, remote)
      return {
        remote,
        state: 'connected',
        account: { ...current, missingScopes: [], otherVaults: 0 },
        client,
      }
    },
    list: () => [mailboxA, mailboxB],
    async link(owner, sub) {
      assert.equal(owner, remote)
      const account = [mailboxA, mailboxB].find((item) => item.sub === sub)
      assert(account)
      current = account
      revision++
    },
  }
  const registry = createCapabilityRegistry()
  const capabilities = googleCapabilities({
    accounts: accounts as GoogleAccountsManager,
    mailInvitations: createMailInvitationSession(createMailInvitationStore(userData)),
    dataFor: async (owner) => {
      assert.equal(owner, remote)
      return data.get(sessions.get(current.sub)!)!
    },
    dataForSession: (session) => data.get(session)!,
    settings: {
      read: async (path) => {
        assert.equal(path, vault)
        return { calendars: {}, imageSenders: [], imagesFromAllSenders: false }
      },
      write: async () => {
        throw new Error('No settings writes in this fixture')
      },
    },
  })
  registry.register(GOOGLE_NAMESPACES, capabilities)
  const context = {
    remote,
    root: vault,
    bundle: null,
    snapshot: async () => emptyVaultSnapshot(),
    claims: async () => [],
    core: noCoreServices(),
  }
  const allowed: ReadonlySet<string> = new Set<keyof typeof capabilities>([
    'google.status',
    'google.allAccounts',
    'google.useAccount',
    'google.search',
    'google.mailCounts',
    'google.categoryCounts',
    'google.contacts',
    'google.sendAs',
    'google.drafts',
    'google.thread',
    'google.imageSenders',
    'google.mailMarkerAnnotations',
    'google.mailMarkerPreferences',
    'google.mailInvitation',
    'google.validateMailInvitationBinding',
    'google.respondToMailInvitation',
  ])
  const calls: { name: string; params: unknown; linkedAccount: string; verdict?: string }[] = []
  async function invoke(op: TrpcOpWire): Promise<TrpcEnvelope> {
    const input = op.input as { remote: string; name: string; paramsJson?: string }
    assert.equal(input.remote, remote)
    if (op.type === 'query' && op.path === 'cap.names')
      return { ok: true, data: registry.names('ui', remote).filter((name) => allowed.has(name)) }
    assert.equal(op.type, 'mutation')
    assert.equal(op.path, 'cap.run')
    assert(allowed.has(input.name), `Unexpected capability: ${input.name}`)
    const params: unknown =
      input.paramsJson === undefined ? undefined : JSON.parse(input.paramsJson)
    const call: (typeof calls)[number] = { name: input.name, params, linkedAccount: current.sub }
    calls.push(call)
    try {
      const { value } = await registry.run(input.name, 'ui', context, params)
      call.verdict = 'ok'
      return { ok: true, data: value }
    } catch (error) {
      if (!(error instanceof CapabilityError)) throw error
      call.verdict = error.code
      return { ok: false, message: error.message, code: trpcCodeOf(error.code) }
    }
  }
  return {
    transport,
    invoke,
    calls,
    expireAccessToken: () => {
      grants.get(mailboxA.sub)!.expiresAt = 0
    },
    dispose: () => {
      disposeGoogleCapabilities(capabilities)
      for (const store of data.values()) store.forget()
    },
  }
}

const card = 'section[aria-label="Calendar invitation"]'
const literal = JSON.stringify
const controls = 'button, [role="menuitem"], a'
const target = (name: string, scope = 'body', selector = controls) =>
  `[...document.querySelectorAll(${literal(`${scope} :is(${selector})`)})].find(e => e.getClientRects().length && (e.getAttribute('aria-label') ?? e.innerText.trim()) === ${literal(name)})`

/** Trusted input and compositor capture are scoped to our WebContents. This
 * never uses a debugging port, desktop capture, or an external browser. */
function drive(win: BrowserWindow) {
  const js = <T>(expression: string): Promise<T> => win.webContents.executeJavaScript(expression)
  async function until<T>(label: string, read: () => T | Promise<T>) {
    const deadline = performance.now() + 9_000
    do {
      const value = await read()
      if (value) return value
      await pause(40)
    } while (performance.now() < deadline)
    throw new Error(
      `${label} did not settle; visible reader: ${await js('document.body.innerText')}`,
    )
  }
  async function clickElement(label: string, expression: string) {
    const point = await until(label, () =>
      js<{ x: number; y: number } | null>(`(() => {
      const e = ${expression}; if (!e || !e.getClientRects().length || e.disabled || e.getAttribute('aria-disabled') === 'true') return null;
      e.scrollIntoView({block:'nearest',inline:'nearest'});
      const r = e.getBoundingClientRect(); const x = Math.round(r.x + r.width / 2); const y = Math.round(r.y + r.height / 2);
      return e.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
    })()`),
    )
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const click = (name: string, scope?: string) => clickElement(name, target(name, scope))
  return { js, until, click, clickElement }
}

async function run() {
  const paths = isolate()
  const rig = googleRig()
  const denied: string[] = []
  const errors: string[] = []
  const external: string[] = []
  const checks: string[] = []
  const captures: { file: string; view: string; theme: string; width: number; card: string }[] = []
  const { transport } = rig
  let win: BrowserWindow | undefined
  const mark = (check: string) => {
    checks.push(check)
    console.log(`PASS ${check}`)
  }
  try {
    await app.whenReady()
    const browser = session.fromPartition(partition, { cache: false })
    assert.equal(browser.getStoragePath(), null)
    for (const isolated of [session.defaultSession, browser]) {
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.on('will-download', (event) => event.preventDefault())
      isolated.webRequest.onBeforeRequest(({ url }, callback) => {
        let allow = false
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'file:') {
            const path = realpathSync(fileURLToPath(parsed))
            allow = path === html || path.startsWith(join(root, 'renderer') + sep)
          } else
            allow = ['about:blank', 'about:srcdoc'].includes(url) || parsed.protocol === 'data:'
        } catch {
          /* Unknown local paths and all non-fixture traffic are denied. */
        }
        if (!allow) denied.push(url)
        callback({ cancel: !allow })
      })
    }
    const window = (win = new BrowserWindow({
      width: 1280,
      height: 920,
      useContentSize: true,
      webPreferences: {
        session: browser,
        preload: join(root, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    }))
    const contents = window.webContents
    const trusted = (event: Electron.IpcMainInvokeEvent) =>
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame?.url === htmlUrl
    ipcMain.handle(ipc, async (event, op: TrpcOpWire): Promise<TrpcEnvelope> => {
      if (!trusted(event)) return { ok: false, message: 'Not the fixture main frame' }
      try {
        return await rig.invoke(op)
      } catch (error) {
        errors.push(String(error))
        return { ok: false, message: String(error) }
      }
    })
    ipcMain.handle(`${ipc}-external`, (event, url: string) => {
      if (!trusted(event)) return
      // Assert the meeting target without moving focus or using a real browser.
      if (![inline.join, attachment.join].includes(url))
        errors.push(`Unexpected external link: ${url}`)
      external.push(url)
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => {
      if (!['about:blank', 'about:srcdoc'].includes(event.url)) event.preventDefault()
    })
    contents.on('console-message', ({ level, message }) => {
      if (level === 'error') errors.push(message)
    })
    contents.on('render-process-gone', (_event, { reason }) =>
      errors.push(`renderer gone: ${reason}`),
    )
    const { js, until, click, clickElement } = drive(window)
    const readCard = () => js<string>(`document.querySelector(${literal(card)})?.innerText ?? ''`)
    const rowSelector = (view: 'shell' | 'surface', invite: typeof inline) => {
      const scope = view === 'shell' ? 'Production MailShell' : 'Production MailView'
      return `[aria-label="${scope}"] #${invite.id}`
    }
    const open = (view: 'shell' | 'surface', invite: typeof inline) => {
      const row = rowSelector(view, invite)
      // MailShell's listitem handles clicks on its subject; MailView uses a row button.
      const selector = `${row} ${view === 'shell' ? 'p' : 'button'}`
      return clickElement(
        invite.subject,
        `[...document.querySelectorAll(${literal(selector)})].find(e => e.innerText.includes(${literal(invite.subject)}))`,
      )
    }
    const expectStatus = (text: string) =>
      until(text, async () => (await readCard()).includes(text))
    const expectDetails = async (invite: typeof inline) => {
      await until(invite.title, async () => (await readCard()).includes(invite.title))
      const text = await readCard()
      for (const field of [
        invite.title,
        organizer.name,
        organizer.email,
        invite.location,
        'November 18, 2026',
        'Accept',
        'Maybe',
        'Decline',
      ])
        assert(text.includes(field), `invitation is missing ${field}: ${text}`)
      assert.match(text, /15:20.*16:05|3:20\s*PM.*4:05\s*PM/i)
      const priorOpens = external.length
      if (invite.attached) {
        assert(text.includes(`Destination: ${new URL(invite.join).hostname}`))
        assert(!text.includes('Join meeting') && !text.includes('Open in Google Calendar'))
        await click('Open email link', card)
      } else {
        await click('Join meeting', card)
      }
      await until(
        `external target for ${invite.title}`,
        () => external.length === priorOpens + 1 && external.at(-1) === invite.join,
      )
    }
    const capture = async (name: string) => {
      await js(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      const image = await window.capturePage()
      assert(!image.isEmpty(), `Empty capture: ${name}`)
      const file = `${name}.png`
      writeFileSync(join(evidence, file), image.toPNG(), { flag: 'wx' })
      captures.push({
        file,
        view: await js('document.querySelector("main > section").ariaLabel'),
        theme: await js('document.documentElement.dataset.theme'),
        width: window.getContentBounds().width,
        card: await readCard(),
      })
    }
    // Local WebContents controls the clock and language without a debug port.
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
    await contents.debugger.sendCommand('Emulation.setLocaleOverride', { locale: 'en_US' })
    await window.loadFile(html)
    window.focus()
    contents.focus()
    const badge = '[aria-label="Meeting invite"]'
    const inlineRow = rowSelector('shell', inline)
    const attachedRow = rowSelector('shell', attachment)
    await until('attached invite appears as the positive list-badge control', () =>
      js(
        `!!document.querySelector(${literal(`${attachedRow} ${badge}`)})?.getClientRects().length`,
      ),
    )
    assert(await js(`!!document.querySelector(${literal(inlineRow)})?.getClientRects().length`))
    assert.equal(await js(`!!document.querySelector(${literal(`${inlineRow} ${badge}`)})`), false)
    await open('shell', inline)
    await expectDetails(inline)
    await expectStatus('No response yet')
    mark('mail-shell-filename-less-inline-invite-has-no-list-badge-but-opens-a-card')
    await capture('01-shell-before-light')

    let frame = 0
    let activeFrame: Promise<void> | undefined
    const record = setInterval(() => {
      if (activeFrame || frame >= 100 || window.isDestroyed()) return
      activeFrame = window
        .capturePage()
        .then((image) => {
          assert(!image.isEmpty())
          writeFileSync(
            join(frames, `frame-${String(frame++).padStart(4, '0')}.png`),
            image.toPNG(),
            { flag: 'wx' },
          )
        })
        .catch((error) => {
          errors.push(`Recording: ${String(error)}`)
        })
        .finally(() => {
          activeFrame = undefined
        })
    }, 200)
    try {
      for (const [action, label, answer] of [
        ['Accept', 'Accepted', 'accepted'],
        ['Maybe', 'Tentative', 'tentative'],
        ['Decline', 'Declined', 'declined'],
      ] as const) {
        const before = transport.writes.length
        await pause(700)
        if (answer === 'declined') transport.loseNextPatchAcknowledgement()
        await click(action, card)
        if (answer === 'declined') {
          await expectStatus('Retry only checks its status')
          await expectStatus('Response: Tentative')
          assert.equal(transport.writes.length, before + 1)
          assert.equal(transport.snapshot().tokenRefreshes, 0)
          rig.expireAccessToken()
          await click('Retry', card)
        }
        await expectStatus(`Response: ${label}`)
        assert.equal(transport.writes.length, before + 1)
        assert.equal(transport.writes[before]?.answer, answer)
        assert.equal(transport.snapshot().calendarResponse, answer)
        assert.equal(transport.snapshot().calendarReadbacks, before + 1)
        await capture(`02-shell-${answer}-light`)
      }
      assert.equal(transport.snapshot().tokenRefreshes, 1)
      mark(
        'mail-shell-calendar-patches-and-readback-including-read-only-retry-after-uncertain-patch',
      )
      await click('Mail surface')
      await js('document.documentElement.dataset.theme = "dark"')
      transport.missAttachmentCollection()
      await open('surface', attachment)
      await expectStatus('Calendar could not verify')
      assert(!(await readCard()).includes('Accept'))
      const writesBeforeCollectionRetry = transport.writes.length
      await click('Retry', card)
      await expectStatus('No response yet')
      assert.equal(transport.writes.length, writesBeforeCollectionRetry)
      mark('calendar-collection-404-blocks-rsvp-until-a-read-confirms-absence')
      await expectDetails(attachment)
      await expectStatus('No response yet')
      await capture('03-mail-view-before-dark')
      mark('mail-view-attachment-without-calendar-copy-shows-invitation')

      transport.refuseNextSend()
      await pause(700)
      await click('Accept', card)
      await until('invitation refusal with Retry', () =>
        js(
          `!!document.querySelector(${literal(`${card} [role="alert"]`)}) && !!(${target('Retry', card)})`,
        ),
      )
      await expectStatus('No response yet')
      assert.equal(transport.writes.at(-1)?.status, 403)
      assert(
        rig.calls.some(
          ({ name, verdict }) =>
            name === 'google.respondToMailInvitation' && verdict === 'FORBIDDEN',
        ),
        'the real capability must classify the Gmail scope refusal',
      )
      assert.equal(transport.snapshot().sentReceiptReads, 0)
      await capture('04-mail-view-refusal-dark')
      const refusedWrites = transport.writes.length
      const attachmentReadsBeforeRetry = transport.snapshot().attachmentReads
      await pause(700)
      await click('Retry', card)
      await until('Retry reconciled without writing', () =>
        js(`!(${target('Retry', card)}) && (${target('Accept', card)})?.disabled === false`),
      )
      await expectStatus('No response yet')
      assert(transport.snapshot().attachmentReads > attachmentReadsBeforeRetry)
      assert.equal(transport.writes.length, refusedWrites)
      mark('gmail-refusal-retains-old-response-and-retry-does-not-send')
      await pause(700)
      const beforeSent = transport.snapshot()
      const releaseSent = transport.holdSentAcknowledgement()
      try {
        await click('Accept', card)
        await expectStatus('Sending your response…')
        await expectStatus('No response yet')
        assert(!(await readCard()).includes('Response: Accepted'))
      } finally {
        releaseSent()
      }
      await expectStatus('Google accepted your response.')
      await expectStatus('Response: Accepted')
      assert(!(await js(`!!(${target('Retry', card)})`)))
      assert.equal(transport.writes.length, refusedWrites + 1)
      const afterSent = transport.snapshot()
      assert(afterSent.attachmentReads > 0)
      assert(afterSent.sentReceiptMisses > beforeSent.sentReceiptMisses)
      assert(afterSent.sentIdSearches > beforeSent.sentIdSearches)
      assert(afterSent.sentReceiptReads > beforeSent.sentReceiptReads)
      assert.equal(statSync(journalPath).mode & 0o777, 0o600)
      await capture('05-mail-view-sent-readback-dark')
      mark('gmail-itip-reply-confirms-through-exact-id-readback-from-a-separate-sent-thread')
      await pause(700)
    } finally {
      clearInterval(record)
      await activeFrame
    }
    assert(frame >= 13, 'recording must contain at least 2.5s of actual fixture frames')

    window.setContentSize(860, 920)
    await until('invitation controls fit the narrow reader', () =>
      js(`(() => {
      if (innerWidth > 900) return false;
      const area = document.querySelector(${literal(card)});
      if (!area) return false;
      const bounds = area.getBoundingClientRect();
      const buttons = [...area.querySelectorAll('button')];
      return buttons.length >= 4 && buttons.every(button => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= Math.min(innerWidth, bounds.right + 1);
      });
    })()`),
    )
    await expectStatus('Response: Accepted')
    await capture('06-mail-view-narrow-dark')
    window.setContentSize(1280, 920)
    await open('surface', series)
    const scopedCards = `${card} article`
    const matchesCard = (title: string) =>
      `[...document.querySelectorAll(${literal(scopedCards)})].find(e => e.querySelector('h4')?.textContent === ${literal(title)})`
    const containsCard = (title: string, text: string) =>
      js<boolean>(`!!(${matchesCard(title)})?.innerText.includes(${literal(text)})`)
    await until(
      'series and occurrence are rendered separately',
      async () =>
        (await containsCard(series.title, 'Whole series')) &&
        (await containsCard(occurrence.title, 'This occurrence')),
    )
    const priorScopedWrites = transport.writes.length
    await clickElement(
      'Accept',
      `[...(${matchesCard(occurrence.title)}).querySelectorAll('button')].find(e => e.innerText === 'Accept')`,
    )
    await until(
      'only the moved occurrence shows the accepted response',
      async () =>
        (await containsCard(occurrence.title, 'Response: Accepted')) &&
        (await containsCard(series.title, 'No response yet')),
    )
    assert.equal(transport.writes.length, priorScopedWrites + 1)
    assert.equal(
      transport.writes.at(-1)?.resource,
      `/calendar/v3/calendars/primary/events/${occurrenceId}`,
    )
    assert.equal(transport.snapshot().seriesResponse, 'needsAction')
    assert.equal(transport.snapshot().occurrenceResponse, 'accepted')
    mark('mail-view-series-and-moved-occurrence-have-independent-external-targets')

    const writesBeforeCalendarCopy = transport.writes.length
    const readsBeforeCalendarCopy = transport.snapshot()
    transport.setCalendarCopyOfAttachment('needsAction')
    await open('surface', attachment)
    await until('the verified Sent answer survives the new Calendar copy', async () => {
      const observed = transport.snapshot()
      return (
        observed.attachmentCopyReads > readsBeforeCalendarCopy.attachmentCopyReads &&
        observed.sentReceiptReads > readsBeforeCalendarCopy.sentReceiptReads &&
        (await containsCard(attachment.title, 'Response: Accepted')) &&
        (await containsCard(attachment.title, 'Open in Google Calendar'))
      )
    })
    assert(!(await containsCard(attachment.title, 'No response yet')))
    assert.equal(transport.writes.length, writesBeforeCalendarCopy)
    mark('a-new-unanswered-calendar-copy-does-not-erase-a-confirmed-itip-response')

    transport.setCalendarCopyOfAttachment('tentative')
    await open('surface', attachment)
    await expectStatus('Calendar: Tentative')
    await expectStatus('Gmail Sent: Accepted')
    assert(!(await containsCard(attachment.title, 'Response: Accepted')))
    assert(await js(`(${target('Maybe', card)})?.disabled === true`))
    assert.equal(transport.writes.length, writesBeforeCalendarCopy)
    await capture('07-mail-view-calendar-and-sent-conflict-dark')

    await click('Decline', card)
    await until(
      'the explicitly changed answer is recorded in Calendar',
      async () =>
        (await containsCard(attachment.title, 'Response: Declined')) &&
        (await js(`(${target('Decline', card)})?.disabled === true`)),
    )
    assert.equal(transport.writes.length, writesBeforeCalendarCopy + 1)
    assert.equal(transport.snapshot().attachmentResponse, 'declined')
    mark('calendar-maybe-disagrees-with-gmail-sent-and-only-an-explicit-change-writes')

    await click('Sidebar mail')
    await js('document.documentElement.dataset.theme = "light"')
    await open('shell', inline)
    await expectStatus('Response: Declined')
    const held = transport.holdCalendarRead(1)
    const writesBeforeSwitch = transport.writes.length
    const callsBeforeSwitch = rig.calls.length
    try {
      await click('Accept', card)
      let entered = false
      void held.entered.then(() => {
        entered = true
      })
      await until(
        'old-account response rechecking its Calendar copy before dispatch',
        () => entered,
      )
      await click(`Google account ${mailboxA.email}`)
      await click(mailboxB.email)
      await until('account B loaded in production shell', () =>
        js(
          `!!(${target(`Google account ${mailboxB.email}`)}) && document.body.innerText.includes(${literal(other.subject)})`,
        ),
      )
    } finally {
      held.release()
    }
    await until('stale invitation refused by the real capability', () =>
      rig.calls
        .slice(callsBeforeSwitch)
        .some(
          ({ name, linkedAccount, verdict }) =>
            name === 'google.respondToMailInvitation' &&
            linkedAccount === mailboxA.sub &&
            verdict === 'FORBIDDEN',
        ),
    )
    assert.equal(transport.writes.length, writesBeforeSwitch)
    await open('shell', other)
    await until('same thread ID renders only the new mailbox invitation', async () =>
      (await readCard()).includes(other.title),
    )
    await expectStatus('No response yet')
    assert(!(await readCard()).includes(inline.title))
    assert(!(await js(`!!document.querySelector(${literal(`${card} [role="alert"]`)})`)))
    await capture('08-shell-account-switch-light')
    mark('account-switch-abandons-in-flight-rsvp-without-writing-to-either-account')

    assert.deepEqual(
      transport.writes.map((write) => [
        write.account,
        write.method,
        write.resource,
        write.method === 'PATCH'
          ? { organizerEmail: write.organizerEmail, sendUpdates: write.sendUpdates }
          : { to: write.to },
        write.answer,
        write.status,
      ]),
      [
        ...['accepted', 'tentative', 'declined'].map((answer) => [
          mailboxA.sub,
          'PATCH',
          '/calendar/v3/calendars/primary/events/fixture-event',
          { organizerEmail: organizer.email, sendUpdates: 'all' },
          answer,
          answer === 'declined' ? 'transport error' : 200,
        ]),
        ...[403, 200].map((status) => [
          mailboxA.sub,
          'POST',
          '/gmail/v1/users/me/messages/send',
          { to: organizer.email },
          'accepted',
          status,
        ]),
        [
          mailboxA.sub,
          'PATCH',
          `/calendar/v3/calendars/primary/events/${occurrenceId}`,
          { organizerEmail: organizer.email, sendUpdates: 'all' },
          'accepted',
          200,
        ],
        [
          mailboxA.sub,
          'PATCH',
          `/calendar/v3/calendars/primary/events/${attachmentEventId}`,
          { organizerEmail: organizer.email, sendUpdates: 'all' },
          'declined',
          200,
        ],
      ],
    )
    const trustedClicks = await js<string[]>('window.fixtureClicks')
    for (const label of ['Accept', 'Maybe', 'Decline', 'Retry', mailboxB.email])
      assert(trustedClicks.includes(label), `Missing trusted click: ${label}`)
    assert.deepEqual(external, [inline.join, attachment.join])
    assert.deepEqual(denied, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(transport.rejected, [])
    assert.deepEqual(await js('window.fixtureErrors'), [])
    writeFileSync(
      join(root, 'native.json'),
      JSON.stringify(
        {
          ok: true,
          checks,
          captures,
          frameCount: frame,
          trustedClicks,
          external,
          denied,
          errors,
          google: {
            writes: transport.writes,
            reads: transport.requestCounts,
            ...transport.snapshot(),
          },
          calls: rig.calls.filter(({ name }) => /Invitation|useAccount/.test(name)),
          paths: { ...paths, vault, partition },
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    )
  } catch (error) {
    writeFileSync(
      join(root, 'native.json'),
      JSON.stringify(
        {
          ok: false,
          checks,
          captures,
          errors,
          denied,
          rejectedGoogleRequests: transport.rejected,
          writes: transport.writes,
          failure: String(error),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    )
    throw error
  } finally {
    ipcMain.removeHandler(ipc)
    ipcMain.removeHandler(`${ipc}-external`)
    win?.destroy()
    rig.dispose()
  }
}

void run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  },
)
