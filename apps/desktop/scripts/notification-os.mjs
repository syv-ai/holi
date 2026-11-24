import { createOwnedProcesses } from './owned-processes.mjs'

/**
 * Inspect and click an exact macOS notification through Accessibility.
 * Requires Automation/Accessibility permission for the invoking process. It
 * never falls back to dispatching a DOM, Electron, or Notification callback.
 */
export async function assertMacDesktopAvailable({ signal } = {}) {
  if (process.platform !== 'darwin') throw new Error('desktop availability requires macOS')
  signal?.throwIfAborted()
  const processes = createOwnedProcesses()
  try {
    let output
    try {
      const result = await processes.run('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], {
        timeoutMs: 5000,
        signal,
        label: 'macOS desktop availability check',
      })
      output = result.output
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error('unable to determine macOS desktop availability: ioreg query failed', {
        cause: error,
      })
    }
    signal?.throwIfAborted()
    const matches = [...output.matchAll(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)\b/g)]
    if (matches.length !== 1)
      throw new Error('unable to determine macOS desktop availability: session lock state is missing or ambiguous')
    if (matches[0][1] === 'Yes')
      throw new Error('macOS desktop is locked; unlock the desktop and rerun the notification fixture')
  } finally {
    await processes.stopAll()
  }
}

export async function clickNativeBanner({ appName, title, timeoutMs = 12_000, signal }) {
  if (typeof appName !== 'string' || !appName || typeof title !== 'string' || !title)
    throw new TypeError('appName and title are required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
    throw new RangeError('timeoutMs must be between 1 and 90000')
  signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('native banner inspection requires macOS')
  const script = `
    tell application "System Events"
      set deadline to (current date) + ${Math.ceil(timeoutMs / 1000)}
      repeat
        set observedWindows to 0
        set observedTitles to 0
        set observedValues to 0
        set observedAppParents to 0
        repeat with p in (every process whose name is "NotificationCenter" or name is "UserNotificationCenter")
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
  const processes = createOwnedProcesses({ signal })
  try {
    const result = await processes.run('/usr/bin/osascript', ['-e', script], {
      timeoutMs: timeoutMs + 2000,
    })
    return result.output.trim()
  } finally {
    await processes.stopAll()
  }
}

export async function allowNativeNotificationPermission({ appName, timeoutMs = 12_000, signal }) {
  if (typeof appName !== 'string' || !appName) throw new TypeError('appName is required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000)
    throw new RangeError('invalid permission timeout')
  signal?.throwIfAborted()
  if (process.platform !== 'darwin')
    throw new Error('native notification permission requires macOS')
  const script = `
    on attr(e,k)
      tell application "System Events"
        try
          return value of attribute k of e as text
        on error
          return ""
        end try
      end tell
    end attr
    set deadline to (current date) + ${Math.ceil(timeoutMs / 1000)}
    tell application "System Events"
      repeat
        repeat with p in (application processes whose name is "NotificationCenter")
          repeat with w in windows of p
            set children to entire contents of w
            set ownedPrompt to false
            set cards to 0
            set targetCard to missing value
            set nestedDialog to false
            repeat with e in children
              set valueText to my attr(e,"AXValue")
              set roleText to my attr(e,"AXRole")
              if roleText is "AXDialog" or roleText is "AXSheet" then set nestedDialog to true
              if valueText is "“${escapeAppleScript(appName)}” Notifications" then set ownedPrompt to true
              if my attr(e,"AXSubrole") is "AXNotificationCenterAlert" then
                set cards to cards + 1
                set targetCard to contents of e
              end if
            end repeat
            set windowRole to my attr(w,"AXSubrole")
            if ownedPrompt and cards is 1 and windowRole is "AXSystemDialog" and not nestedDialog then
              set allowAction to missing value
              set denyAction to missing value
              repeat with a in (actions of targetCard)
                set actionLabel to paragraph 1 of (name of a as text)
                if actionLabel is "Name:Allow" then set allowAction to contents of a
                if actionLabel is "Name:Don’t Allow" or actionLabel is "Name:Don't Allow" then set denyAction to contents of a
              end repeat
              if allowAction is not missing value and denyAction is not missing value then
                perform allowAction
                return "owned-app-consent-clicked"
              end if
            end if
          end repeat
        end repeat
        if (current date) > deadline then error "owned notification consent dialog not found"
        delay 0.2
      end repeat
    end tell`
  const processes = createOwnedProcesses({ signal })
  try {
    return (
      await processes.run('/usr/bin/osascript', ['-e', script], { timeoutMs: timeoutMs + 2000 })
    ).output.trim()
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
