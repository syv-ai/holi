import { createOwnedProcesses } from './owned-processes.mjs'

/**
 * Inspect and click an exact macOS notification through Accessibility.
 * Requires Automation/Accessibility permission for the invoking process. It
 * never falls back to dispatching a DOM, Electron, or Notification callback.
 */
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
    on textAttribute(element, key)
      tell application "System Events"
        try
          return value of attribute key of element as text
        on error
          return ""
        end try
      end tell
    end textAttribute
    tell application "System Events"
      set deadline to (current date) + ${Math.ceil(timeoutMs / 1000)}
      set ownMatches to 0
      repeat
        repeat with p in (every application process whose name is "UserNotificationCenter" or name is "NotificationCenter" or name is "${escapeAppleScript(appName)}")
          try
            repeat with w in every window of p
              repeat with candidate in ({w} & (entire contents of w))
                set candidateRole to my textAttribute(candidate, "AXRole")
                set candidateSubrole to my textAttribute(candidate, "AXSubrole")
                if candidateRole is "AXDialog" or candidateRole is "AXSheet" or (candidateRole is "AXWindow" and candidateSubrole is "AXSystemDialog") then
                  set buttonCount to 0
                  set allowButton to missing value
                  set denyFound to false
                  set exactPrompt to false
                  set nestedDialog to false
                  repeat with uiControl in (entire contents of candidate)
                    set itemRole to my textAttribute(uiControl, "AXRole")
                    if itemRole is "AXDialog" or itemRole is "AXSheet" then set nestedDialog to true
                    set labelText to my textAttribute(uiControl, "AXTitle")
                    set valueText to my textAttribute(uiControl, "AXValue")
                    set ownPrompt to "“${escapeAppleScript(appName)}” Would Like to Send You Notifications"
                    set ownPlainPrompt to quote & "${escapeAppleScript(appName)}" & quote & " Would Like to Send You Notifications"
                    if labelText is ownPrompt or valueText is ownPrompt or labelText is ownPlainPrompt or valueText is ownPlainPrompt then set exactPrompt to true
                    if itemRole is "AXButton" then
                      set buttonCount to buttonCount + 1
                      if labelText is "Allow" then set allowButton to uiControl
                      if labelText is "Don't Allow" or labelText is "Don’t Allow" then set denyFound to true
                    end if
                  end repeat
                  if exactPrompt then set ownMatches to ownMatches + 1
                  if exactPrompt and not nestedDialog and buttonCount is 2 and allowButton is not missing value and denyFound then
                    click allowButton
                    return "owned-app-consent-clicked"
                  end if
                end if
              end repeat
            end repeat
          end try
        end repeat
        if (current date) > deadline then error "owned notification consent dialog not found; ownMatches=" & ownMatches
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
