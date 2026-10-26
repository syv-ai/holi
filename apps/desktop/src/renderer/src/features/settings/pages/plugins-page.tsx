/**
 * Which plugins the vault runs: a switch per plugin this build has, writing
 * `plugins` in the committed `.holi/settings/plugins.yaml`, then each running
 * plugin's own settings about plugins (`within: 'plugins'`, the community
 * plugins it installs) as cards of their own.
 *
 * Turning one off stops it at once, and whatever requires it, so the switch
 * asks first while any of those has something to lose (its `leaveGuard`, the
 * agent's busy sessions).
 */
import { useAtomValue } from "jotai"
import { useEffect, useState } from "react"
import {
  PLUGINS_LOCAL_FILE,
  optionalPlugins,
  pluginLabels,
  resolvePlugins,
  type PluginInfo,
} from "@holi/shared"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/reui/badge"
import { pluginMark } from "@/composites"
import { Switch } from "@/components/ui/switch"
import { trpc } from "@/lib/trpc"
import type { SettingsSection } from "@/plugin-api/types"
import { installedPluginsAtom, leaveReasonByPluginAtom } from "@/state/plugins"
import { activeRemoteAtom } from "@/state/vaults"

import { SettingsCard, SettingsRow, SettingsRowsLoading } from "../settings-kit"
import { useVaultSettings } from "../use-vault-settings"

export function PluginsPage({
  nested,
  remote,
}: {
  /** Running plugins' settings about plugins, each drawn as its own card. */
  nested: readonly SettingsSection[]
  remote: string
}) {
  return (
    <>
      <PluginSwitches />
      {nested.map(({ id, label, description, Component }) => (
        <SettingsCard key={id} title={label} description={description}>
          <div className="py-3">
            <Component remote={remote} />
          </div>
        </SettingsCard>
      ))}
    </>
  )
}

function PluginSwitches() {
  const { resolved, write } = useVaultSettings()
  const installed = useAtomValue(installedPluginsAtom)
  const reasons = useAtomValue(leaveReasonByPluginAtom)
  const remote = useAtomValue(activeRemoteAtom)
  /** A turn-off waiting on its question: the write, and what it would cost. */
  const [asking, setAsking] = useState<{
    vault: Record<string, boolean>
    off: PluginInfo
    reasons: string[]
  } | null>(null)

  // Main's answer to why a running plugin did not start, read again after
  // every write: the write starts and stops what it changed before it returns.
  const [failures, setFailures] = useState<Record<string, string>>({})
  const plugins = resolved?.plugins
  useEffect(() => {
    if (remote === null) return
    let live = true
    trpc.settings.pluginFailures
      .query({ remote })
      .then((found) => live && setFailures(found))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [remote, plugins])

  const infos = installed.map((plugin) => plugin.info)

  if (plugins === undefined) {
    return (
      <SettingsCard title="Plugins" description="What this vault runs.">
        <SettingsRowsLoading rows={4} label="Reading the plugins" />
      </SettingsCard>
    )
  }

  const { running, status } = resolvePlugins(plugins, infos)

  const flip = (info: PluginInfo, on: boolean) => {
    const vault = { ...plugins.vault, [info.id]: on }
    const after = resolvePlugins({ ...plugins, vault }, infos).running
    const lost = [...running].flatMap((id) => {
      const reason = after.has(id) ? undefined : reasons.get(id)
      return reason === undefined ? [] : [reason]
    })
    if (lost.length > 0) setAsking({ vault, off: info, reasons: lost })
    else void write("plugins", vault, "committed")
  }

  return (
    <SettingsCard
      title="Built in"
      description="Everyone who clones the vault gets the same ones. Turning one off stops it at once."
    >
      {optionalPlugins(infos).map((info) => {
        const st = status.get(info.id)
        const failure = running.has(info.id) ? failures[info.id] : undefined
        const id = `settings-plugin-${info.id}`
        const notes = [
          st?.kind === "needs"
            ? `Needs ${pluginLabels(st.missing, infos)}, so it is not running.`
            : null,
          st?.kind === "off-here"
            ? `Off on this machine, in ${PLUGINS_LOCAL_FILE}.`
            : null,
        ].filter((note) => note !== null)
        return (
          <SettingsRow
            key={info.id}
            title={info.label}
            mark={pluginMark(info.id)}
            htmlFor={id}
            align="start"
            titleAddon={
              failure !== undefined ? (
                <Badge variant="destructive-light">Did not start</Badge>
              ) : st?.kind === "needs" || st?.kind === "off-here" ? (
                <Badge variant="secondary">Not running</Badge>
              ) : null
            }
            description={
              <span className="flex flex-col gap-1">
                {info.description ? <span>{info.description}</span> : null}
                {notes.map((note) => (
                  <span key={note} className="text-xs">
                    {note}
                  </span>
                ))}
                {failure !== undefined ? (
                  <span className="text-destructive text-xs break-words">
                    {failure}
                  </span>
                ) : null}
              </span>
            }
          >
            <Switch
              id={id}
              // The vault's answer. This machine's own off is the note.
              checked={plugins.vault[info.id] ?? info.default}
              onCheckedChange={(on) => flip(info, on)}
            />
          </SettingsRow>
        )
      })}

      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off {asking?.off.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.reasons.join(" ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (asking !== null) {
                  void write("plugins", asking.vault, "committed")
                }
                setAsking(null)
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
