/**
 * Settings → Updates (docs/features/updates.md): updating Holi on this
 * machine, with each release's notes, then where the open vault's skills
 * stand against this release.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button, Checkbox } from '@/primitives'
import { ExternalLink, SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { openSkillsStatusAtom, updateSkillsAtom } from '@/state/skills'
import type { ReleaseNotesAnswer } from '../../../../main/updates/release-notes'
import { DescriptorSection } from './DescriptorSection'
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
  setUpdateChannelAtom,
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
  const setChannel = useSetAtom(setUpdateChannelAtom)
  const supported = status?.supported === true

  const action = !supported ? null : status.state === 'ready' ? (
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
      {status?.availableVersion != null && status.availableVersion !== status.version && (
        <ReleaseNotesRow
          key={status.availableVersion}
          version={status.availableVersion}
          label={`What’s new in Holi ${status.availableVersion}`}
        />
      )}
      {status !== null && status.version !== '' && (
        <ReleaseNotesRow
          key={status.version}
          version={status.version}
          label={`Holi ${status.version}, the version you have`}
        />
      )}
      <SettingsRow
        label="Dev prereleases"
        description="Opt in to development releases. Turning this off checks for and downloads the latest stable release, even if it is older than the version you have; restart to install it."
        control={
          <Checkbox
            aria-label="Dev prereleases"
            disabled={!supported}
            checked={status?.channel === 'dev'}
            onCheckedChange={(v) => void setChannel(v === true ? 'dev' : 'stable')}
          />
        }
      />
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

function OpenAtLoginRow(): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    void trpc.app.loginItem.query().then((r) => setOpen(r.openAtLogin))
  }, [])
  return (
    <SettingsRow
      label="Open at login"
      description="Start Holi in the menu bar when you log in, its window out of sight, so reminders and sync work from the start."
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

/**
 * One release's notes, fetched from its GitHub release when first shown.
 * GitHub writes them as Markdown; they are shown as text, headings and list
 * items picked out, never as HTML.
 */
function ReleaseNotesRow({ version, label }: { version: string; label: string }) {
  const [open, setOpen] = useState(false)
  // undefined: not asked yet. GitHub not answering is asked again on the
  // next opening, so hiding and showing the notes is the retry.
  const [answer, setAnswer] = useState<ReleaseNotesAnswer | undefined>(undefined)
  const toggle = () => {
    if (open && answer?.kind === 'unreachable') setAnswer(undefined)
    setOpen((o) => !o)
  }
  useEffect(() => {
    if (!open || answer !== undefined) return
    let live = true
    trpc.updates.notes
      .query({ version })
      .then((a) => live && setAnswer(a))
      .catch(() => live && setAnswer({ kind: 'unreachable' }))
    return () => {
      live = false
    }
  }, [open, answer, version])

  return (
    <SettingsRow
      label={label}
      control={
        <Button variant="secondary" size="xs" onClick={toggle}>
          {open ? 'Hide notes' : 'Release notes'}
        </Button>
      }
    >
      {open &&
        (answer === undefined ? (
          <SettingsNote>Loading…</SettingsNote>
        ) : answer.kind === 'unreachable' ? (
          <SettingsNote>Could not reach GitHub, try again.</SettingsNote>
        ) : answer.kind === 'none' ? (
          <SettingsNote>GitHub has no notes for this version.</SettingsNote>
        ) : (
          <div className="space-y-2">
            <NotesText body={answer.notes.body} />
            <ExternalLink
              url={answer.notes.url}
              onOpen={() => void window.holi.openExternal(answer.notes.url)}
            >
              {answer.notes.name} on GitHub
            </ExternalLink>
          </div>
        ))}
    </SettingsRow>
  )
}

/** Markdown notes as text: `#` lines as headings, `*` and `-` lines as items,
 *  emphasis markers dropped. */
function NotesText({ body }: { body: string }): React.JSX.Element {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/\*\*|__/g, '').trimEnd())
    .filter((line) => line.trim() !== '')
  if (lines.length === 0) return <SettingsNote>No notes for this version.</SettingsNote>
  return (
    <div className="max-h-64 space-y-1 overflow-auto text-[11px] text-muted-foreground">
      {lines.map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line)
        if (heading !== null) {
          return (
            <p key={i} className="pt-1 font-medium text-foreground">
              {heading[1]}
            </p>
          )
        }
        const item = /^\s*[*-]\s+(.*)$/.exec(line)
        return (
          <p key={i} className={item !== null ? 'break-words pl-3 -indent-2' : 'break-words'}>
            {item !== null ? `• ${item[1]}` : line}
          </p>
        )
      })}
    </div>
  )
}

/**
 * Where the open vault's skills and hooks stand against this release, and
 * whether the vault takes them on open (`autoUpdateSkills`).
 */
export function VaultSkillsSection(): React.JSX.Element {
  const status = useAtomValue(openSkillsStatusAtom)
  const update = useSetAtom(updateSkillsAtom)
  const pending = status?.pending.length ?? 0
  return (
    <>
      <SettingsList>
        <SettingsRow
          label={
            status === null
              ? 'Loading…'
              : pending === 0
                ? 'Skills and hooks are up to date'
                : `This version of Holi has ${pending} newer ${pending === 1 ? 'file' : 'files'} for this vault`
          }
          description={
            status === null
              ? undefined
              : status.release === null
                ? 'Holi has not written this vault’s skills on this machine.'
                : `Last brought in by Holi ${status.release}.`
          }
          control={
            pending > 0 ? (
              <Button size="xs" onClick={() => void update()}>
                Update skills
              </Button>
            ) : undefined
          }
        />
      </SettingsList>
      <DescriptorSection section="updates" />
    </>
  )
}
