import { createOwnedProcesses } from './owned-processes.mjs'

/**
 * Inspect and click an exact macOS notification through Accessibility.
 * Requires Automation/Accessibility permission for the invoking process. It
 * never falls back to dispatching a DOM, Electron, or Notification callback.
 */
export async function clickNativeBanner({ appName, title, timeoutMs = 12_000 }) {
  if (typeof appName !== 'string' || !appName || typeof title !== 'string' || !title)
    throw new TypeError('appName and title are required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
    throw new RangeError('timeoutMs must be between 1 and 90000')
  if (process.platform !== 'darwin') throw new Error('native banner inspection requires macOS')
  const script = `
    tell application "System Events"
      set deadline to (current date) + ${Math.ceil(timeoutMs / 1000)}
      repeat
        set matches to {}
        repeat with p in (every process whose name is "NotificationCenter")
          try
            set matches to (entire contents of (window 1 of p))
            repeat with e in matches
              try
                if (value of attribute "AXTitle" of e as text) is "${escapeAppleScript(title)}" and (value of attribute "AXDescription" of e as text) contains "${escapeAppleScript(appName)}" then
                  click e
                  return "clicked"
                end if
              end try
            end repeat
          end try
        end repeat
        if (current date) > deadline then error "exact notification title not found in Accessibility tree"
        delay 0.25
      end repeat
    end tell`
  const processes = createOwnedProcesses()
  try {
    const result = await processes.run('/usr/bin/osascript', ['-e', script], {
      timeoutMs: timeoutMs + 2000,
    })
    return result.output.trim()
  } finally {
    await processes.stopAll()
  }
}

function escapeAppleScript(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/[\r\n]/g, ' ')
}
