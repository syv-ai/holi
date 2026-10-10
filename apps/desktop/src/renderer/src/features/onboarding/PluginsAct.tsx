/**
 * The ritual's plugins act: what this vault runs on top of notes, tasks and
 * sync, chosen once, at birth.
 *
 * **Renders the build's plugins; does not know them.** Each row is a plugin's
 * own `PluginInfo`, so a new plugin shows up here by existing. Which are on is
 * `enabledPlugins` over the answer so far, the same rule the app runs by.
 *
 * Only choosing happens here. Setting a plugin up (connecting Google, having
 * Claude Code) is per machine and happens where the plugin is used.
 */
import { enabledPlugins, type PluginInfo, type PluginSettings } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { installedPluginsAtom } from '@/state/plugins'
import { Switch } from '@/primitives'

interface Props {
  plugins: PluginSettings
  onChange: (info: PluginInfo, on: boolean) => void
}

export function PluginsAct({ plugins, onChange }: Props) {
  const infos = useAtomValue(installedPluginsAtom).map((p) => p.info)
  const on = enabledPlugins(plugins, infos)
  return (
    <div className="obrit-plugins">
      {infos.map((info) => {
        const running = on.has(info.id)
        return (
          <label key={info.id} className="obrit-plugin" data-plugin={info.id}>
            <span className="obrit-plugin-name">{info.label}</span>
            <Switch
              checked={running}
              onCheckedChange={(next) => onChange(info, next)}
              aria-label={info.label}
            />
            {info.description !== undefined && (
              <span className="obrit-plugin-desc">{info.description}</span>
            )}
            {!running && info.whenOff !== undefined && (
              <span className="obrit-plugin-off">Off: {info.whenOff}</span>
            )}
          </label>
        )
      })}
    </div>
  )
}
