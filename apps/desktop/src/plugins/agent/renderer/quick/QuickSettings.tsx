/**
 * The quick agent's settings section (docs/features/quick-agent.md): this
 * machine's, not the vault's, so nothing here writes into the vault.
 *
 * - Whether the global hotkeys are on: off until the person turns them on.
 * - Which keys: the one that opens a new agent at the pointer and the one
 *   that opens the dock with the keyboard. The only keys in Holi a person
 *   picks, because they are taken from every other app while Holi is not in
 *   front. Recorded by pressing them.
 * - How a quick agent runs, each the person's own choice and off until
 *   chosen: Claude Code's auto mode, and the panel's instructions.
 * - Whether Holi may read the selection in other apps (macOS's
 *   Accessibility permission), with the way to grant it.
 */
import { useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_DOCK_HOTKEY, DEFAULT_QUICK_HOTKEY, hotkeyFromEvent } from '../../shared/hotkey'
import type { QuickSettingsPatch } from '../../shared/quick'
import { agentCap } from '../agent-cap'
import { quickSettingsAtom } from './keys'
import { SettingsHeading, SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { activeRemoteAtom } from '@/plugin-api'
import { Button, Checkbox, Kbd } from '@/primitives'

/** The two keys, by their settings' names. */
type KeyName = 'hotkey' | 'dockHotkey'

export function QuickSettings(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  // Shared with the main window's dock key (`keys.ts`), so a key changed here
  // is the key it answers.
  const [state, setState] = useAtom(quickSettingsAtom)
  /** The key being recorded, if one is. */
  const [recording, setRecording] = useState<KeyName | null>(null)
  /** What went wrong, under the key row it was about (the first for the
   *  switch). */
  const [error, setError] = useState<{ on: KeyName; message: string } | null>(null)

  const load = useCallback(async () => {
    if (remote === null) return
    setState(await agentCap.quickSettings(remote).catch(() => null))
  }, [remote, setState])

  useEffect(() => {
    void load()
    // The permission is granted in System Settings, outside Holi: coming back
    // to the window is when it may have changed.
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  const change = useCallback(
    async (patch: QuickSettingsPatch, on: KeyName = 'hotkey') => {
      if (remote === null) return
      setError(null)
      try {
        setState(await agentCap.setQuickSettings(remote, patch))
      } catch (err) {
        setError({ on, message: err instanceof Error ? err.message : String(err) })
      }
    },
    [remote, setState],
  )

  // Recording: the next key with a modifier is the key; esc gives up. Main
  // refuses one key for both, and says so under the row being changed.
  useEffect(() => {
    if (recording === null) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const spec = hotkeyFromEvent(e)
      if (spec === null) return
      setRecording(null)
      void change(recording === 'hotkey' ? { hotkey: spec } : { dockHotkey: spec }, recording)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, change])

  const enabled = state?.enabled === true

  /** A key's row: the key as it is, and the recorder that changes it. */
  const keyRow = (name: KeyName, label: string, description: string) => {
    const value =
      name === 'hotkey'
        ? (state?.hotkey ?? DEFAULT_QUICK_HOTKEY)
        : (state?.dockHotkey ?? DEFAULT_DOCK_HOTKEY)
    const conflict = name === 'hotkey' ? state?.conflict : state?.dockConflict
    const now = recording === name
    return (
      <SettingsRow
        label={label}
        description={
          now ? 'Press the key, with ⌘, ⌃ or ⌥. Esc keeps the one you have.' : description
        }
        control={
          <div className="flex items-center gap-2">
            <Kbd className="inline-flex h-6 min-w-9 items-center justify-center px-2 text-xs">
              {now ? '…' : value}
            </Kbd>
            <Button
              variant="secondary"
              size="xs"
              disabled={state === null || !enabled}
              onClick={() => setRecording(now ? null : name)}
            >
              {now ? 'Cancel' : 'Change'}
            </Button>
          </div>
        }
      >
        {conflict === true && (
          <SettingsNote className="text-agent-failed">
            Another app already uses {value}. Pick another key.
          </SettingsNote>
        )}
        {error?.on === name && (
          <SettingsNote className="text-agent-failed">{error.message}</SettingsNote>
        )}
      </SettingsRow>
    )
  }

  return (
    <section>
      <SettingsHeading
        title="From any app"
        blurb="A hotkey opens a small panel at the pointer in whatever app you are in. Type a task and an agent starts on it, as a dot in a slim dock at the edge of the screen that turns orange when it needs you. Settings for this Mac."
      />
      <SettingsList>
        <SettingsRow
          label="Hotkey"
          description="Off until you turn it on. Pressed in any other app, the key opens the quick panel; inside Holi it keeps its own meaning."
          control={
            <Checkbox
              aria-label="Quick agent hotkey"
              disabled={state === null}
              checked={enabled}
              onCheckedChange={(v) => void change({ enabled: v === true })}
            />
          }
        />
        {keyRow(
          'hotkey',
          'Key',
          'A new agent at the pointer. Holi takes this key from every other app while it is not the app in front.',
        )}
        {keyRow(
          'dockHotkey',
          'Dock key',
          'The dock with the keyboard, on the agent that most needs you; ↑ ↓ step through the others. Taken from other apps the same way.',
        )}
        <SettingsRow
          label="Approve safe actions"
          description="Quick agents run in Claude Code's auto mode: what it judges safe goes ahead, and the rest still asks. Off, they follow the vault's own permission mode, and a permission prompt shows in the panel."
          control={
            <Checkbox
              aria-label="Approve safe actions"
              disabled={state === null}
              checked={state?.autoApprove === true}
              onCheckedChange={(v) => void change({ autoApprove: v === true })}
            />
          }
        />
        <SettingsRow
          label="Panel instructions"
          description="A few lines after Claude Code's own system prompt: work on its own, ask only with question cards, and keep the answer to a sentence or two. Off, a quick agent is told nothing extra."
          control={
            <Checkbox
              aria-label="Panel instructions"
              disabled={state === null}
              checked={state?.instructions === true}
              onCheckedChange={(v) => void change({ instructions: v === true })}
            />
          }
        />
        <SettingsRow
          label="Selection from other apps"
          description={
            state?.accessibility === true
              ? 'Allowed. What you have selected comes along with the task, until you remove it.'
              : 'Holi can bring what you have selected in the app you are in. macOS asks you to allow it once, under Privacy & Security, Accessibility.'
          }
          control={
            state?.accessibility === true ? undefined : (
              <Button
                variant="secondary"
                size="xs"
                disabled={state === null || remote === null}
                onClick={() => {
                  if (remote !== null) void agentCap.requestAccessibility(remote).then(() => load())
                }}
              >
                Allow…
              </Button>
            )
          }
        />
      </SettingsList>
    </section>
  )
}
