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
        set observedWindows to 0
        set observedTitles to 0
        set observedValues to 0
        set observedAppParents to 0
        repeat with p in (every process whose name is "NotificationCenter")
          repeat with w in (every window of p)
            set observedWindows to observedWindows + 1
            try
              repeat with e in (entire contents of w)
                set ownTitle to ""
                set ownValue to ""
                try
                  set ownTitle to value of attribute "AXTitle" of e as text
                end try
                try
                  set ownValue to value of attribute "AXValue" of e as text
                end try
                if ownTitle is "${escapeAppleScript(title)}" then set observedTitles to observedTitles + 1
                if ownValue is "${escapeAppleScript(title)}" then set observedValues to observedValues + 1
                if ownTitle is "${escapeAppleScript(title)}" or ownValue is "${escapeAppleScript(title)}" then
                  try
                    set parentElement to value of attribute "AXParent" of e
                    if (value of attribute "AXDescription" of parentElement as text) contains "${escapeAppleScript(appName)}" then
                      set observedAppParents to observedAppParents + 1
                      click parentElement
                      return "clicked"
                    end if
                  end try
                end if
              end repeat
            end try
          end repeat
        end repeat
        if (current date) > deadline then error "exact notification not found: windows=" & observedWindows & ", titleMatches=" & observedTitles & ", valueMatches=" & observedValues & ", appParents=" & observedAppParents
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
