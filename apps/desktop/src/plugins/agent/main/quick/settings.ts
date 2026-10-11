/**
 * The quick agent's settings: this machine's, not any vault's, so a file in
 * Holi's data directory (`quick-agent.json`), never `.holi/settings/`.
 *
 * - `enabled`: the global keys are registered, and the panel and the dock
 *   loaded. Off until a person turns it on: the keys are taken from every
 *   other app on the machine.
 * - `hotkey`: the key for a new prompt, in Holi's glyphs (`⌘J`). With the
 *   dock's, the keys in Holi a person can choose, because they are taken from
 *   every other app on the machine.
 * - `dockHotkey`: the key for the dock, with the keyboard (`⌃⌘J`). Never the
 *   same as `hotkey`: Settings refuses that, and a file that says it is read
 *   with another dock key.
 * - `autoApprove`: quick agents run in Claude Code's auto mode. Off, they
 *   follow the vault's own permission mode, like any other session.
 * - `instructions`: quick agents are told how the panel works, after Claude
 *   Code's own system prompt (`claude/quick.ts`). Off, they get none.
 * - `accessibilityAsked`: Holi has explained the Accessibility permission
 *   once, on a first press, and never does again.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { join } from 'node:path'
import { jsonFileStore, type JsonFileStore } from '../../../../main/plugin-api'
import { DEFAULT_DOCK_HOTKEY, DEFAULT_QUICK_HOTKEY, toAccelerator } from '../../shared/hotkey'

export interface QuickSettings {
  enabled: boolean
  hotkey: string
  dockHotkey: string
  autoApprove: boolean
  instructions: boolean
  accessibilityAsked: boolean
}

export const DEFAULT_QUICK_SETTINGS: QuickSettings = {
  enabled: false,
  hotkey: DEFAULT_QUICK_HOTKEY,
  dockHotkey: DEFAULT_DOCK_HOTKEY,
  autoApprove: false,
  instructions: false,
  accessibilityAsked: false,
}

const isHotkey = (v: unknown): v is string => typeof v === 'string' && toAccelerator(v) !== null

/** What is on disk, checked key by key: a hand edit gone wrong costs that key. */
export function parseQuickSettings(raw: unknown): QuickSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const hotkey = isHotkey(r['hotkey']) ? r['hotkey'] : DEFAULT_QUICK_SETTINGS.hotkey
  // One key cannot be both: the dock's gives way to the prompt's, and takes
  // its default, or the prompt key's default when the prompt key is that.
  const fallback = hotkey === DEFAULT_DOCK_HOTKEY ? DEFAULT_QUICK_HOTKEY : DEFAULT_DOCK_HOTKEY
  const dockHotkey =
    isHotkey(r['dockHotkey']) && r['dockHotkey'] !== hotkey ? r['dockHotkey'] : fallback
  return {
    enabled: r['enabled'] === true,
    hotkey,
    dockHotkey,
    autoApprove: r['autoApprove'] === true,
    instructions: r['instructions'] === true,
    accessibilityAsked: r['accessibilityAsked'] === true,
  }
}

export const quickSettingsStore = (userData: string): JsonFileStore<QuickSettings> =>
  jsonFileStore(join(userData, 'quick-agent.json'), parseQuickSettings, { cache: true })
