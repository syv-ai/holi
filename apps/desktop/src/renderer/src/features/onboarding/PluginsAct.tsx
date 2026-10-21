/**
 * The ritual's plugins act: what this vault runs on top of notes, tasks and
 * sync, chosen once, at birth.
 *
 * **Renders the build's plugins; does not know them.** Each row is a plugin's
 * own `PluginInfo`, so a new plugin shows up here by existing. Which are on is
 * `resolvePlugins` over the answer so far, the same rule the app runs by, so
 * a plugin whose `requires` are off shows off, cannot be switched, and says
 * what it needs.
 *
 * Only choosing happens here. Setting a plugin up (connecting Google, having
 * Claude Code) is per machine and happens where the plugin is used.
 */
import { pluginLabels, resolvePlugins, type PluginInfo, type PluginSettings } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { installedPluginsAtom } from '@/state/plugins'
import { OptionCard, pluginMark } from '@/composites'
import { Badge } from '@/primitives'

interface Props {
  plugins: PluginSettings
  onChange: (info: PluginInfo, on: boolean) => void
}

/**
 * A card per plugin (`OptionCard`, after ReUI's `settings-1`), two to a row,
 * each with its mark: the brand where it plugs into one, Holi's glyph where
 * it is Holi's own (`composites/marks.tsx`). "Off by default" is a badge, so
 * an unticked card that was never on reads differently from one turned off.
 */
export function PluginsAct({ plugins, onChange }: Props) {
  const infos = useAtomValue(installedPluginsAtom).map((p) => p.info)
  const { running: on, status } = resolvePlugins(plugins, infos)
  return (
    <div className="obrit-cards grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
      {infos.map((info) => {
        const running = on.has(info.id)
        const st = status.get(info.id)
        const needs = st?.kind === 'needs' ? st.missing : []
        return (
          <OptionCard
            key={info.id}
            data-plugin={info.id}
            // An odd one out at the end takes the whole row rather than
            // leaving a hole beside it.
            className="sm:last:odd:col-span-2"
            mark={pluginMark(info.id)}
            title={info.label}
            badge={
              !info.default && (
                <Badge variant="outline" radius="full">
                  Optional
                </Badge>
              )
            }
            description={info.description}
            note={
              needs.length > 0
                ? `Needs ${pluginLabels(needs, infos)}`
                : !running && info.whenOff !== undefined
                  ? `Off: ${info.whenOff}`
                  : undefined
            }
            checked={running}
            disabled={needs.length > 0}
            onCheckedChange={(next) => onChange(info, next)}
          />
        )
      })}
    </div>
  )
}
