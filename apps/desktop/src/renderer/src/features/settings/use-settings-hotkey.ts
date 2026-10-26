/**
 * ⌘, (Ctrl+, off a Mac) opens Settings, as it does in every Mac app.
 *
 * **A renderer keydown, not a menu accelerator**: the app menu has no
 * Settings item, and an accelerator fires before the page sees the key, which
 * `state/commands.ts` keeps for ⌘W alone. A key a focused widget already
 * handled (`defaultPrevented`) is left to it.
 */
import { useSetAtom } from "jotai"
import { useEffect } from "react"

import { matchHotkey } from "@/lib/hotkey"
import { openSettingsAtom } from "@/state/settings-section"

const SETTINGS_HOTKEY = "⌘,"

export function useSettingsHotkey(): void {
  const open = useSetAtom(openSettingsAtom)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchHotkey(event, SETTINGS_HOTKEY)) return
      event.preventDefault()
      open()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
}
