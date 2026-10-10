/**
 * The Community plugins section of the settings tab
 * (docs/features/community-plugins.md). Two scopes, kept apart as the Google
 * section keeps them: whether a plugin runs in **this vault** is the vault's
 * `plugins:` switch and its pin, shared with everyone in it; what is
 * **installed on this machine**, and agreed to, is this person's alone.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useState } from 'react'
import { SettingsHeading, SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { openDialogAtom, trpc } from '@/plugin-api'
import { Button, Switch } from '@/primitives'
import { askToRun, installAndAsk, type InstallFlow } from './install-flow'
import { PluginSearch } from './PluginSearch'
import { communityCap, refreshRows, rowsAtom, type PluginRow } from './state'

/** A row's state, in words. */
const STATUS: Record<PluginRow['status'], string> = {
  'not-installed': 'Not installed on this machine',
  'pin-differs': 'This machine has another version',
  'needs-consent': 'Waiting for you to allow it',
  'needs-setup': 'Not set up yet',
  'setup-failed': 'Setup failed',
  ready: 'Ready',
}

const versionOf = (row: PluginRow) => row.install?.version ?? row.pin?.version ?? ''

/** Turn a plugin on or off for the vault: its `plugins.<id>` switch, beside
 *  the vault's other plugins, and its pin when it is a release. */
async function setOn(remote: string, row: PluginRow, on: boolean): Promise<void> {
  if (on && row.install?.kind === 'release' && row.pin?.commit !== row.install.commit)
    await communityCap.pin(remote, { id: row.id })
  if (on && row.install?.kind === 'dev') await communityCap.skills(remote, { id: row.id })
  const settings = await trpc.settings.read.query({ remote })
  await trpc.settings.write.mutate({
    remote,
    committedJson: JSON.stringify({ plugins: { ...settings.plugins.vault, [row.id]: on } }),
  })
}

export function PluginsSettings({ remote }: { remote: string }): React.JSX.Element {
  const store = useStore()
  const openDialog = useSetAtom(openDialogAtom)
  const rows = useAtomValue(rowsAtom)?.rows ?? []
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const flow: InstallFlow = {
    remote,
    store,
    openDialog: (render) => openDialog({ id: 'plugin', size: 'md', render }),
  }

  const act = async (fn: () => Promise<string | null | void>) => {
    setBusy(true)
    setError(null)
    try {
      const message = await fn()
      if (typeof message === 'string') setError(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      await refreshRows(remote, store)
    }
  }

  /** The one next step a row needs before it can run here. */
  const nextStep = (row: PluginRow) => {
    switch (row.status) {
      case 'not-installed':
      case 'pin-differs':
        return row.pin === null ? null : (
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void act(() =>
                installAndAsk(flow, { repo: row.pin!.repo, version: row.pin!.version, id: row.id }),
              )
            }
          >
            Install {row.pin.version}
          </Button>
        )
      case 'needs-consent':
      case 'needs-setup':
      case 'setup-failed':
        return (
          <Button size="xs" disabled={busy} onClick={() => askToRun(flow, row)}>
            {row.status === 'setup-failed' ? 'Run setup again…' : 'Review and allow…'}
          </Button>
        )
      case 'ready':
        return row.install?.kind === 'dev' && row.setup !== null ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => askToRun(flow, row)}>
            Run setup
          </Button>
        ) : null
    }
  }

  return (
    <section>
      <SettingsHeading
        title="This vault"
        blurb="Plugins this vault uses, for everyone in it. Each person installs and allows them on their own machine."
      />
      {rows.length === 0 ? (
        <SettingsNote>No community plugins yet. Add one below.</SettingsNote>
      ) : (
        <SettingsList>
          {rows.map((row) => (
            <SettingsRow
              key={row.id}
              label={`${row.name} ${versionOf(row)}`}
              description={
                <>
                  {row.description !== '' && <>{row.description} </>}
                  {STATUS[row.status]}
                  {row.install?.kind === 'dev' && <> · from {row.install.folder}</>}
                </>
              }
              control={
                <span className="flex items-center gap-2">
                  {nextStep(row)}
                  <Switch
                    aria-label={`Use ${row.name} in this vault`}
                    checked={row.on}
                    disabled={busy || (row.install === null && !row.on)}
                    onCheckedChange={(on) => void act(() => setOn(remote, row, on))}
                  />
                </span>
              }
            />
          ))}
        </SettingsList>
      )}

      <SettingsHeading
        title="On this machine"
        blurb="What is installed here. Removing one keeps the vault's pin, so it is offered again."
      />
      {rows.filter((r) => r.install !== null).length === 0 ? (
        <SettingsNote>Nothing installed.</SettingsNote>
      ) : (
        <SettingsList>
          {rows
            .filter((r) => r.install !== null)
            .map((row) => (
              <SettingsRow
                key={row.id}
                label={row.name}
                description={
                  row.install?.kind === 'release'
                    ? `${row.install.repo} ${row.install.version}`
                    : `Folder ${row.install?.folder}`
                }
                control={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void act(() => communityCap.remove(remote, { id: row.id }))}
                  >
                    Remove
                  </Button>
                }
              />
            ))}
        </SettingsList>
      )}

      <AddPlugin flow={flow} busy={busy} act={act} />
      {error !== null && <p className="mt-2 text-[11px] text-amber-400">{error}</p>}
    </section>
  )
}

function AddPlugin({
  flow,
  busy,
  act,
}: {
  flow: InstallFlow
  busy: boolean
  act: (fn: () => Promise<string | null | void>) => Promise<void>
}): React.JSX.Element {
  const addFolder = async () => {
    const folder = await window.holi.chooseFolder()
    if (folder === null) return
    await communityCap.installFolder(flow.remote, { folder })
  }

  return (
    <>
      <SettingsHeading
        title="Add a plugin"
        blurb="A plugin is a GitHub repository with the holi-plugin topic. Search by name, or type owner/repo."
      />
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PluginSearch
            remote={flow.remote}
            disabled={busy}
            onChoose={(c) =>
              void act(() => installAndAsk(flow, { repo: c.repo, version: c.latest }))
            }
          />
        </div>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act(addFolder)}>
          Use a folder…
        </Button>
      </div>
    </>
  )
}
