/**
 * The `plugins` row's switches: one per installed plugin, what it is and adds,
 * why it is not running, and why it did not start.
 *
 * Turning a plugin off stops it at once, and with it whatever requires it, so
 * the switch asks first while any of those has something to lose (its
 * `leaveGuard`, the agent's busy sessions): before the write, not after.
 *
 * A plugin that did not start says so with main's own message, and while the
 * agent runs, offers a background session to find out why.
 */
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'
import {
  PLUGINS_LOCAL_FILE,
  pluginLabels,
  resolvePlugins,
  type PluginInfo,
  type PluginSettings,
} from '@holi/shared'
import { Button, Checkbox } from '@/primitives'
import { LeaveConfirm } from '@/components/LeaveConfirm'
import { trpc } from '@/lib/trpc'
import type { RendererPlugin } from '@/plugin-api/types'
import { useAgentService } from '@/state/agent-service'
import { agentPluginIdAtom, leaveReasonByPluginAtom } from '@/state/plugins'
import { activeRemoteAtom } from '@/state/vaults'

export function PluginSwitches({
  value,
  installed,
  adds,
  onChange,
}: {
  value: PluginSettings
  installed: readonly RendererPlugin[]
  /** What each plugin adds to Holi, read off its contributions. */
  adds: (plugin: RendererPlugin) => string[]
  /** The vault's whole answer, as the flag group sends its block. */
  onChange: (vault: Record<string, boolean>) => void
}): React.JSX.Element {
  const infos = installed.map((p) => p.info)
  const { running, status } = resolvePlugins(value, infos)
  const reasons = useAtomValue(leaveReasonByPluginAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const agent = useAgentService()
  const agentPlugin = useAtomValue(agentPluginIdAtom)
  /** A turn-off waiting on its question: the write, and what it would cost. */
  const [asking, setAsking] = useState<{
    vault: Record<string, boolean>
    off: PluginInfo
    reasons: string[]
  } | null>(null)

  // Main's answer, read again after every write: the write starts and stops
  // what it changed before it returns.
  const [failures, setFailures] = useState<Record<string, string>>({})
  useEffect(() => {
    if (remote === null) return
    let live = true
    void trpc.settings.pluginFailures
      .query({ remote })
      .then((f) => live && setFailures(f))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [remote, value])

  const flip = (info: PluginInfo, on: boolean) => {
    const vault = { ...value.vault, [info.id]: on }
    const after = resolvePlugins({ ...value, vault }, infos).running
    const lost = [...running].flatMap((id) => {
      const reason = after.has(id) ? undefined : reasons.get(id)
      return reason === undefined ? [] : [reason]
    })
    if (lost.length > 0) setAsking({ vault, off: info, reasons: lost })
    else onChange(vault)
  }

  const diagnose = (info: PluginInfo, message: string) =>
    void agent?.start({
      name: `Why ${info.label} did not start`,
      prompt:
        `Holi's ${info.label} plugin did not start in this vault. The error was: ${message}\n\n` +
        "Find out why, from this vault's files and its plugin settings " +
        '(`.holi/settings/plugins.yaml` and `plugins.local.yaml`), and tell me what to ' +
        'change. Do not change anything yet.',
    })

  return (
    <div className="flex flex-col gap-3">
      {installed.map((plugin) => {
        const { info } = plugin
        const st = status.get(info.id)
        const needs = st?.kind === 'needs' ? st.missing : []
        const added = adds(plugin)
        const failure = running.has(info.id) ? failures[info.id] : undefined
        return (
          <div key={info.id} className="flex flex-col gap-0.5">
            <label className="flex items-start gap-2.5">
              <Checkbox
                className="mt-0.5"
                // The vault's answer. This machine's own off is the note.
                checked={value.vault[info.id] ?? info.default}
                onCheckedChange={(next) => flip(info, next === true)}
                aria-label={info.label}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>
                  <span className="text-xs">{info.label}</span>
                  {info.description !== undefined && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {info.description}
                    </span>
                  )}
                </span>
                {added.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    Adds {added.join(' · ')}
                  </span>
                )}
                {info.whenOff !== undefined && (
                  <span className="text-[11px] text-muted-foreground">Off: {info.whenOff}</span>
                )}
                {needs.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    Needs {pluginLabels(needs, infos)}, so it is not running.
                  </span>
                )}
                {st?.kind === 'off-here' && (
                  <span className="text-[11px] text-muted-foreground">
                    Off on this machine, in {PLUGINS_LOCAL_FILE}.
                  </span>
                )}
              </span>
            </label>
            {failure !== undefined && (
              // Beside the switch's label, not inside it: a click on Diagnose
              // must not flip the switch.
              <span className="flex flex-wrap items-center gap-x-2 pl-6.5 text-[11px] text-destructive">
                Did not start: {failure}
                {agent !== null && agentPlugin !== null && failures[agentPlugin] === undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-plugin-diagnose={info.id}
                    onClick={() => diagnose(info, failure)}
                  >
                    Diagnose
                  </Button>
                )}
              </span>
            )}
          </div>
        )
      })}
      {asking !== null && (
        <LeaveConfirm
          intent="turn-off"
          subject={asking.off.label}
          reasons={asking.reasons}
          onConfirm={() => {
            onChange(asking.vault)
            setAsking(null)
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  )
}
