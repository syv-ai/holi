/**
 * The Community plugins section of the settings tab
 * (docs/features/community-plugins.md). Two scopes, kept apart as the Google
 * section keeps them: whether a plugin runs in **this vault** is the vault's
 * `plugins:` switch and its pin, shared with everyone in it; what is
 * **installed on this machine**, and agreed to, is this person's alone.
 */
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { SettingsHeading, SettingsList, SettingsNote, SettingsRow } from '@/composites/settings-ui'
import { closePluginDialogAtom, openDialogAtom } from '@/plugin-api'
import { communityCap, setPluginSwitch } from './community-cap'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { askToRun, installAndAsk, updatePlugin, type InstallFlow } from './install-flow'
import { PluginSearch } from './plugin-search'
import { refreshRows, refreshUpdates, rowsAtom, updatesAtom, type PluginRow } from './state'

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

function BusyLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <span className="relative">
      <span className={busy ? 'opacity-0' : undefined}>{children}</span>
      {busy && (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <Spinner />
        </span>
      )}
    </span>
  )
}

/** Turn a plugin on or off for the vault: its `plugins.<id>` switch, beside
 *  the vault's other plugins, and its pin when it is a release. */
async function setOn(remote: string, row: PluginRow, on: boolean): Promise<void> {
  if (on && row.install?.kind === 'release' && row.pin?.commit !== row.install.commit)
    await communityCap.pin(remote, { id: row.id })
  if (on && row.install?.kind === 'dev') await communityCap.skills(remote, { id: row.id })
  await setPluginSwitch(remote, row.id, on)
}

/** Once a plugin added here is set up, use it in this vault too: settings is
 *  always inside an open vault, and installing from it is asking for that.
 *  One already on stays as the vault has it. */
async function turnOnHere(remote: string, id: string): Promise<void> {
  const row = (await communityCap.list(remote)).find((r) => r.id === id)
  if (row !== undefined && !row.on) await setOn(remote, row, true)
}

export function PluginsSettings({
  remote,
  visible = true,
}: {
  remote: string
  visible?: boolean
}): React.JSX.Element {
  const store = useStore()
  const openDialog = useSetAtom(openDialogAtom)
  const closePluginDialog = useSetAtom(closePluginDialogAtom)
  const visibleRef = useRef(visible)
  const dialogRenderer = useRef<((close: () => void) => React.ReactNode) | null>(null)
  visibleRef.current = visible
  const rows = useAtomValue(rowsAtom)?.rows ?? []
  const updates = useAtomValue(updatesAtom)

  // Opening the section asks GitHub now rather than trusting the hourly check.
  useEffect(() => {
    if (visible) {
      void refreshUpdates(remote, store, true)
      return
    }
    if (dialogRenderer.current !== null) closePluginDialog(dialogRenderer.current)
    dialogRenderer.current = null
  }, [remote, store, visible, closePluginDialog])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const actionLock = useRef(false)

  const flow: InstallFlow = {
    remote,
    store,
    openDialog: (render) => {
      if (!visibleRef.current) return
      dialogRenderer.current = render
      openDialog({ id: 'plugin', size: 'md', render })
    },
  }

  const act = async (id: string, fn: () => Promise<string | null | void>) => {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true)
    setActing(id)
    setError(null)
    try {
      const message = await fn()
      if (typeof message === 'string') setError(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      actionLock.current = false
      setBusy(false)
      setActing(null)
      await refreshRows(remote, store)
    }
  }

  /** The one next step a row needs before it can run here. */
  const nextStep = (row: PluginRow) => {
    switch (row.status) {
      case 'not-installed':
      case 'pin-differs':
        // Either side can be the one wanted: this machine's release (an
        // update, once allowed, pinned for everyone) or the vault's.
        return (
          <span className="flex items-center gap-2">
            {row.install?.kind === 'release' && (
              <Button
                size="xs"
                disabled={busy}
                onClick={() =>
                  void act(`${row.id}:pin`, async () =>
                    askToRun(flow, row, () => communityCap.pin(remote, { id: row.id })),
                  )
                }
              >
                <BusyLabel busy={acting === `${row.id}:pin`}>
                  Use {row.install.version} in this vault…
                </BusyLabel>
              </Button>
            )}
            {row.pin !== null && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act(`${row.id}:install`, () =>
                    installAndAsk(flow, {
                      repo: row.pin!.repo,
                      path: row.pin!.path,
                      version: row.pin!.version,
                      id: row.id,
                    }),
                  )
                }
              >
                <BusyLabel busy={acting === `${row.id}:install`}>
                  Install {row.pin.version}
                </BusyLabel>
              </Button>
            )}
          </span>
        )
      case 'needs-consent':
      case 'needs-setup':
      case 'setup-failed':
        return (
          <Button
            size="xs"
            disabled={busy}
            onClick={() => void act(`${row.id}:setup`, async () => askToRun(flow, row))}
          >
            <BusyLabel busy={acting === `${row.id}:setup`}>
              {row.status === 'setup-failed' ? 'Run setup again…' : 'Review and allow…'}
            </BusyLabel>
          </Button>
        )
      case 'ready':
        return row.install?.kind === 'dev' && row.setup !== null ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(`${row.id}:setup`, async () => askToRun(flow, row))}
          >
            <BusyLabel busy={acting === `${row.id}:setup`}>Run setup</BusyLabel>
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
                  {row.check?.ok === false ? (
                    <span className="text-amber-400">{row.check.hint}</span>
                  ) : (
                    STATUS[row.status]
                  )}
                  {row.install?.kind === 'dev' && <> · from {row.install.folder}</>}
                  {row.commandsNote !== null && (
                    <span className="text-amber-400"> {row.commandsNote}</span>
                  )}
                </>
              }
              control={
                <span className="flex items-center gap-2">
                  {updates[row.id] !== undefined && row.status === 'ready' && (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        void act(`${row.id}:update`, () =>
                          updatePlugin(flow, row, updates[row.id]!),
                        )
                      }
                    >
                      <BusyLabel busy={acting === `${row.id}:update`}>
                        Update to {updates[row.id]}…
                      </BusyLabel>
                    </Button>
                  )}
                  {row.check?.ok === false && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          `${row.id}:check`,
                          async () => void (await communityCap.check(remote, { id: row.id })),
                        )
                      }
                    >
                      <BusyLabel busy={acting === `${row.id}:check`}>Check again</BusyLabel>
                    </Button>
                  )}
                  {nextStep(row)}
                  <Switch
                    aria-label={`Use ${row.name} in this vault`}
                    checked={row.on}
                    disabled={busy || (row.install === null && !row.on)}
                    onCheckedChange={(on) =>
                      void act(`${row.id}:switch`, () => setOn(remote, row, on))
                    }
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
                    onClick={() =>
                      void act(`${row.id}:remove`, () =>
                        communityCap.remove(remote, { id: row.id }),
                      )
                    }
                  >
                    <BusyLabel busy={acting === `${row.id}:remove`}>Remove</BusyLabel>
                  </Button>
                }
              />
            ))}
        </SettingsList>
      )}

      <AddPlugin flow={flow} busy={busy} acting={acting} visible={visible} act={act} />
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-pretty break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

function AddPlugin({
  flow,
  busy,
  acting,
  visible,
  act,
}: {
  flow: InstallFlow
  busy: boolean
  acting: string | null
  visible: boolean
  act: (id: string, fn: () => Promise<string | null | void>) => Promise<void>
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
        blurb="Plugins live in GitHub repositories with the holi-plugin topic, one at the root or several in folders. Search by name, or type owner/repo."
      />
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PluginSearch
            remote={flow.remote}
            disabled={busy}
            visible={visible}
            onChoose={(c) =>
              void act('add:install', () =>
                installAndAsk(flow, { repo: c.repo, path: c.path, version: c.latest }, (row) =>
                  turnOnHere(flow.remote, row.id),
                ),
              )
            }
          />
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          aria-label="Use a folder…"
          onClick={() => void act('add:folder', addFolder)}
        >
          <BusyLabel busy={acting === 'add:folder'}>Use a folder…</BusyLabel>
        </Button>
      </div>
    </>
  )
}
