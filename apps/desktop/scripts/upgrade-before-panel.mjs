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
