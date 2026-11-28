import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { emptyVaultSnapshot, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import type { TrpcOpWire } from '../src/renderer/src/lib/ipc-link'
import { installAppMenu } from '../src/main/menu'
import { DEFAULT_MAIL_MARKER_PREFERENCES } from '../src/plugins/google/shared/mail-markers'
import type { MailAttentionSnapshot } from '../src/plugins/google/shared/types'

const root = process.env.HOLI_600_ROOT!
const evidence = process.env.HOLI_600_EVIDENCE!
const remote = 'fixture/backspace'
const requests: TrpcOpWire[] = []
const missing: string[] = []
const denied: string[] = []
const errors: string[] = []
const drafts = new Map<string, unknown>()
const saves: { draftId: string; mail: unknown }[] = []
const account = { sub: 'fixture-google', email: 'fixture@example.test', name: 'Synthetic account' }
const settings = {
  ...VAULT_SETTING_DEFAULTS,
  plugins: {
    vault: {
      google: true,
      tasks: false,
      automations: false,
      holis: false,
      links: false,
      browser: false,
      pdf: false,
      reader: false,
      apps: false,
      community: false,
      meetings: false,
    },
    localOff: [],
  },
  pluginValues: {},
  warnings: [],
}

// Fixtures replace main-side data only. No production account, vault, provider,
// credentials, router implementation or network client is initialized here.
function capability(name: string, params: Record<string, unknown>): unknown {
  switch (name) {
    case 'google.status':
      return { account, missingScopes: [], needsReconnect: false }
    case 'google.allAccounts':
      return { accounts: [account], current: account.sub }
    case 'google.search':
      return { threads: [], nextPageToken: null, syncedAt: null }
    case 'google.mailCounts':
      return { unread: 0, total: 0 }
    case 'google.mailAttention':
      return {
        accountSub: account.sub,
        unreadThreads: 0,
        status: 'fresh',
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      } satisfies MailAttentionSnapshot
    case 'google.mailMarkerPreferences':
      return DEFAULT_MAIL_MARKER_PREFERENCES
    case 'google.sendAs':
      return [account.email]
    case 'google.saveDraft': {
      assert.equal(params.expectedAccountSub, account.sub)
      if (params.draftId !== undefined) {
        assert.equal(typeof params.draftId, 'string')
        assert(drafts.has(params.draftId as string), 'Only an existing synthetic draft may update')
      }
      const id =
        typeof params.draftId === 'string' ? params.draftId : `fixture-draft-${drafts.size + 1}`
      const mail = structuredClone(params.mail)
      drafts.set(id, mail)
      saves.push({ draftId: id, mail })
      return { id }
    }
    case 'google.contacts':
    case 'agent.sessions':
    case 'agent.terminals':
    case 'agent.history':
    case 'agent.providers':
      return []
    case 'agent.inbox':
      return { entries: [], unread: 0 }
    case 'skills.status':
      return { pending: [], autoUpdate: false }
    default:
      missing.push(name)
      throw new Error(`Unimplemented fixture capability: ${name}`)
  }
}

function answer(op: TrpcOpWire): unknown {
  const input = (op.input ?? {}) as Record<string, unknown>
  if (input.remote !== undefined) assert.equal(input.remote, remote)
  switch (op.path) {
    case 'auth.status':
      return { viewer: { login: 'fixture', name: 'Synthetic user', avatarUrl: '' } }
    case 'vaults.list':
      return [
        {
          remote,
          name: 'Backspace fixture',
          path: join(root, 'vaults', remote),
          lastOpenedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    case 'vaults.open':
    case 'vaults.snapshot':
      return emptyVaultSnapshot()
    case 'settings.read':
      return settings
    case 'updates.status':
      return {
        supported: false,
        enabled: false,
        state: 'idle',
        availableVersion: null,
        lastError: null,
        channel: 'stable',
      }
    case 'ui.report':
      return null
    case 'subscriptions.list':
    case 'logs.entries':
    case 'activity.entries':
    case 'terminal.list':
    case 'cap.names':
      return []
    case 'sync.info':
      return {
        remote,
        branch: 'fixture',
        dirty: false,
        ahead: 0,
        behind: 0,
        lastSyncAt: null,
        lastError: null,
      }
    case 'theme.read':
      return { light: {}, dark: {}, warnings: [] }
    case 'github.collaborators':
      return { collaborators: [] }
    case 'cap.run':
      assert.equal(typeof input.name, 'string')
      return capability(
        input.name as string,
        JSON.parse(typeof input.paramsJson === 'string' ? input.paramsJson : '{}'),
      )
    default:
      missing.push(op.path)
      throw new Error(`Unimplemented fixture RPC: ${op.path}`)
  }
}

function report(): void {
  writeFileSync(
    join(evidence, 'main-state.tmp'),
    JSON.stringify(
      {
        requests,
        missing,
        denied,
        errors,
        drafts: [...drafts],
        saves,
        paths: {
          userData: app.getPath('userData'),
          sessionData: app.getPath('sessionData'),
          appData: app.getPath('appData'),
        },
      },
      null,
      2,
    ),
  )
  renameSync(join(evidence, 'main-state.tmp'), join(evidence, 'main-state.json'))
}

for (const name of ['userData', 'sessionData', 'appData'] as const) {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  app.setPath(name, path)
  assert.equal(app.getPath(name), path)
}
app.setName('Holi Backspace shell diagnostic')
app.on('window-all-closed', () => app.quit())
app.on('before-quit', report)

void app
  .whenReady()
  .then(async () => {
    const ses = session.defaultSession
    ses.setPermissionCheckHandler(() => false)
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (/^(file|data|devtools|about):/.test(details.url)) callback({})
      else {
        denied.push(details.url)
        report()
        callback({ cancel: true })
      }
    })
    const win = new BrowserWindow({
      width: 1300,
      height: 950,
      webPreferences: {
        preload: join(root, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('console-message', (event) => {
      console.log(`RENDERER ${event.level}: ${event.message}`)
      if (event.level === 'error') {
        errors.push(event.message)
        report()
      }
    })
    win.webContents.on('render-process-gone', (_event, detail) => {
      errors.push(`renderer gone: ${detail.reason}`)
      report()
    })
    ipcMain.handle('window:is-visible', (event) => {
      assert.equal(event.sender, win.webContents)
      assert.equal(event.senderFrame, win.webContents.mainFrame)
      return win.isVisible()
    })
    ipcMain.handle('holi:trpc', (event, op: TrpcOpWire) => {
      assert.equal(event.sender, win.webContents)
      assert.equal(event.senderFrame, win.webContents.mainFrame)
      requests.push(op)
      try {
        const data = answer(op)
        report()
        return { ok: true, data }
      } catch (error) {
        errors.push(String(error))
        report()
        return { ok: false, message: String(error) }
      }
    })
    installAppMenu(() => win)
    await win.loadFile(join(root, 'renderer/index.html'))
    win.show()
    win.focus()
    console.log(`HOLI_600_READY ${process.versions.electron}`)
  })
  .catch((error: unknown) => {
    errors.push(String(error))
    report()
    console.error(error)
    app.exit(1)
  })
