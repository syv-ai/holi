/**
 * Updating Holi itself (docs/features/updates.md): the version you run, where
 * the updater has got to, a "Check now", and whether Holi checks on its own.
 * Beside it, whether Holi opens at login, the other property of this machine's
 * app.
 *
 * A property of this machine's app, not of the open vault, so it sits with
 * Account at the end of the rail and writes nothing into the vault.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button, Checkbox } from '@/primitives'
import { SettingsList, SettingsNote, SettingsRow } from '@/composites'
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
  updateHeadline,
  updateStatusAtom,
} from '@/state/updates'

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago". */
export function checkedAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export function UpdatesSection(): React.JSX.Element {
  const status = useAtomValue(updateStatusAtom)
  const check = useSetAtom(checkForUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const install = useSetAtom(installUpdateAtom)
  const setEnabled = useSetAtom(setAutoUpdateAtom)
  const supported = status?.supported === true

  const action =
    status === null || !supported ? null : status.state === 'ready' ? (
      <Button size="xs" onClick={() => void install()}>
        Restart to update
      </Button>
    ) : status.state === 'available' && status.lastError !== null ? (
      <Button variant="secondary" size="xs" onClick={() => void retry()}>
        Try again
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="xs"
        disabled={status.state !== 'idle'}
        onClick={() => void check()}
      >
        Check now
      </Button>
    )

  return (
    <SettingsList>
      <SettingsRow
        label={updateHeadline(status)}
        description={
          status === null
            ? undefined
            : [
                status.version === '' ? null : `You have Holi ${status.version}.`,
                status.lastCheckAt === null
                  ? null
                  : `Last checked ${checkedAgo(status.lastCheckAt)}.`,
              ]
                .filter((s) => s !== null)
                .join(' ') || undefined
        }
        control={action ?? undefined}
      >
        {status?.lastError != null && (
          <SettingsNote className="break-words">{status.lastError}</SettingsNote>
        )}
      </SettingsRow>
      <SettingsRow
        label="Update automatically"
        description="Check every few hours and download new versions in the background. An update installs when you quit Holi or choose Restart to update."
        control={
          <Checkbox
            aria-label="Update automatically"
            disabled={!supported}
            checked={status?.enabled === true}
            onCheckedChange={(v) => void setEnabled(v === true)}
          />
        }
      />
      <OpenAtLoginRow />
    </SettingsList>
  )
}

/**
 * Whether Holi opens at login, in the menu bar with its window out of sight:
 * reminders fire and the quick agent's hotkey works only while Holi runs.
 */
function OpenAtLoginRow(): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    void trpc.app.loginItem.query().then((r) => setOpen(r.openAtLogin))
  }, [])
  return (
    <SettingsRow
      label="Open at login"
      description="Start Holi in the menu bar when you log in, its window out of sight, so reminders and the quick agent's hotkey work from the start."
      control={
        <Checkbox
          aria-label="Open at login"
          disabled={open === null}
          checked={open === true}
          onCheckedChange={(v) =>
            void trpc.app.setLoginItem
              .mutate({ openAtLogin: v === true })
              .then((r) => setOpen(r.openAtLogin))
          }
        />
      }
    />
  )
}
