import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

const probeFields = [
  'connected',
  'headingVisible',
  'disconnectEnabled',
  'disconnectPresent',
  'googleVisible',
  'emailVisible',
  'blockingDialog',
  'connectionsNavigationPresent',
  'connectionsNavigationCurrent',
  'settingsInert',
]

const captureExpression = `(async () => {
  const { BrowserWindow, screen } = require('electron');
  const live = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  const windows = live();
  if (windows.length !== 1) return null;
  const window = windows[0];
  if (window.webContents.isLoading()) return null;
  const bounds = window.getContentBounds();
  const scale = screen.getDisplayMatching(bounds).scaleFactor;
  if (![bounds.width, bounds.height, scale].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || scale <= 0 || bounds.width * scale > 4096 || bounds.height * scale > 4096) return null;
  const image = await window.capturePage();
  if (window.isDestroyed() || window.webContents.isLoading() || live().length !== 1 || live()[0] !== window) return null;
  const size = image.getSize();
  if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0 || size.width > 4096 || size.height > 4096) return null;
  const png = image.toPNG();
  if (png.length > 16 * 1024 * 1024) return null;
  return { windowId: window.id, width: size.width, height: size.height, png: png.toString('base64') };
})()`

// execute is bound to the already-owned producer's main inspector, never a renderer or global screen.
export async function waitForBeforePanel({ probe, wait, execute, evidenceDirectory, receipt }) {
  const snapshot = async () => {
    const value = await probe()
    const normalized = {}
    for (const key of probeFields) {
      if (typeof value?.[key] === 'boolean') normalized[key] = value[key]
    }
    receipt.before.uiProbe = normalized
    return normalized.connected === true
  }
  try {
    await wait('visible-google-connections', snapshot)
  } catch (error) {
    try {
      if (receipt.timedOut?.phase === 'visible-google-connections') {
        const capture = await execute(captureExpression)
        if (
          !capture ||
          !Number.isSafeInteger(capture.windowId) ||
          capture.windowId <= 0 ||
          !Number.isSafeInteger(capture.width) ||
          !Number.isSafeInteger(capture.height) ||
          capture.width <= 0 ||
          capture.height <= 0 ||
          capture.width > 4096 ||
          capture.height > 4096 ||
          typeof capture.png !== 'string' ||
          capture.png.length > 4 * Math.ceil((16 * 1024 * 1024) / 3) ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(capture.png)
        )
          throw new Error('invalid capture')
        const image = Buffer.from(capture.png, 'base64')
        if (
          image.length < 8 ||
          image.length > 16 * 1024 * 1024 ||
          !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new Error('invalid PNG')
        }
        await writeFile(join(evidenceDirectory, 'before-panel-unasserted.png'), image, {
          mode: 0o600,
          flag: 'wx',
        })
        receipt.before.failureImage = {
          file: 'before-panel-unasserted.png',
          windowId: capture.windowId,
          googleConnectionsPanelAsserted: false,
        }
      }
    } catch {
      receipt.before.failureImage = { outcome: 'unavailable' }
    }
    throw error
  }
}

// Self-contained so the hosted runner can install this in the paused signed app.
// Verified at dev.275 and HEAD: preload/index.ts -> main/ipc.ts -> trpc-call.ts;
// renderer lib/cap-client.ts sends cap.run mutations, not google.* procedure paths.
export function observeUpgradeUiRequests(ipcMain, fixtureRemote) {
  const records = []
  const lifecycle = []
  let sequence = 0
  const originalHandle = ipcMain.handle
  ipcMain.handle = function (channel, listener, ...registrationArgs) {
    if (channel !== 'holi:trpc') {
      return originalHandle.call(this, channel, listener, ...registrationArgs)
    }
    return originalHandle.call(
      this,
      channel,
      function (...args) {
        const op = args[1]
        const isVaultOpen =
          op?.path === 'vault.open' &&
          op?.type === 'mutation' &&
          op?.input?.remote === fixtureRemote
        const capability =
          op?.path === 'cap.run' &&
          op?.type === 'mutation' &&
          ['google.status', 'google.allAccounts'].includes(op?.input?.name)
            ? op.input.name
            : null
        if ((!capability && !isVaultOpen) || records.length + lifecycle.length >= 20)
          return listener.apply(this, args)
        const order = ++sequence
        const record = isVaultOpen
          ? { event: 'vault.open', result: 'pending', order, startOrder: order }
          : {
              event: 'google-request',
              capability,
              fixtureVaultMatch: op.input.remote === fixtureRemote,
              result: 'pending',
              order,
              startOrder: order,
            }
        if (isVaultOpen) lifecycle.push(record)
        else records.push(record)
        const finish = (value, failure) => {
          // Observation must never replace a handler outcome, even for an unexpected shape.
          try {
            if (record.completionOrder === undefined) record.completionOrder = ++sequence
            if (isVaultOpen) {
              record.result = failure ?? (value?.ok === true ? 'success' : 'envelope-error')
              return
            }
            record.result =
              failure ??
              (value?.ok === true ? 'success' : value?.ok === false ? 'envelope-error' : 'unknown')
            if (record.result === 'envelope-error') {
              record.code = [
                'BAD_REQUEST',
                'UNAUTHORIZED',
                'FORBIDDEN',
                'NOT_FOUND',
                'CONFLICT',
                'PRECONDITION_FAILED',
                'TIMEOUT',
                'INTERNAL_SERVER_ERROR',
                'METHOD_NOT_SUPPORTED',
                'TOO_MANY_REQUESTS',
              ].includes(value.code)
                ? value.code
                : 'other'
              if (record.code === 'BAD_REQUEST') {
                // dev.275 and HEAD registry refusals survive router cap.run and toEnvelope.
                // This does not distinguish an absent door from a stale lease/lifetime.
                record.refusalClass =
                  value.message === 'no such method: ' + capability ? 'method-unavailable' : 'other'
              }
            }
            if (record.result === 'success') {
              if (capability === 'google.status') {
                record.accountPresent = value.data?.account != null
                record.needsReconnect = value.data?.needsReconnect === true
              } else {
                record.currentAccountPresent = value.data?.current != null
              }
            }
          } catch {
            record.result = 'unknown'
          }
        }
        let result
        try {
          result = listener.apply(this, args)
        } catch (error) {
          finish(null, 'throw')
          throw error
        }
        if (result instanceof Promise) {
          // Observe settlement without replacing the original promise or its rejection.
          Promise.prototype.then.call(
            result,
            (value) => finish(value),
            () => finish(null, 'rejection'),
          )
        } else {
          finish(result)
        }
        return result
      },
      ...registrationArgs,
    )
  }
  return () =>
    [...records, ...lifecycle].sort((a, b) => a.order - b.order).map((record) => ({ ...record }))
}

// Persist while the inspector is live, including when the original observation throws.
// The workflow error remains authoritative if diagnostics cannot be collected.
export async function captureUpgradeUiRequests({ execute, receipt, persist }) {
  try {
    receipt.uiCapabilityRequests = await execute('globalThis.__holi565?.uiRequests?.() ?? []')
    receipt.uiCapabilityCapture = 'captured'
  } catch {
    receipt.uiCapabilityCapture = 'unavailable'
  }
  await persist()
}
