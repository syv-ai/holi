/**
 * This machine's pages: how the window looks (Appearance), the app's own
 * updates, each release's notes and start, with where the open vault's skills
 * stand against this release (Updates), and who is signed in (Account).
 */
import { useAtomValue, useSetAtom } from "jotai"
import { useEffect, useId, useState } from "react"
import type { ColorScheme, WindowGlass } from "@holi/shared"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
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
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Field, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { MarkdownText, openableUrl } from "@/composites"
import { trpc } from "@/lib/trpc"
import { colorSchemeAtom, writeColorSchemeAtom } from "@/state/color-scheme"
import { sessionAtom, signOutAtom } from "@/state/session"
import {
  dismissSkillsNoticeAtom,
  mergeSkillsConflictsAtom,
  openSkillsStatusAtom,
  skillsNoticeAtom,
  updateSkillsAtom,
} from "@/state/skills"
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
  setUpdateChannelAtom,
  updateHeadline,
  updateStatusAtom,
} from "@/state/updates"
import { windowGlassAtom, writeWindowGlassAtom } from "@/state/window-glass"
import {
  BlendIcon,
  ExternalLinkIcon,
  MonitorIcon,
  MoonIcon,
  SquareDashedIcon,
  SquareIcon,
  SunIcon,
} from "lucide-react"

import {
  Segmented,
  SettingsCard,
  SettingsRow,
  type Choice,
} from "./settings-kit"
import { useVaultSettings } from "./use-vault-settings"

// ── Appearance ──

const THEMES: readonly Choice<ColorScheme>[] = [
  { value: "light", label: "Light", icon: <SunIcon aria-hidden="true" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon aria-hidden="true" /> },
  {
    value: "system",
    label: "System",
    icon: <MonitorIcon aria-hidden="true" />,
  },
]

const GLASSES: readonly Choice<WindowGlass>[] = [
  {
    value: "clear",
    label: "Clear",
    icon: <SquareDashedIcon aria-hidden="true" />,
  },
  {
    value: "frosted",
    label: "Frosted",
    icon: <BlendIcon aria-hidden="true" />,
  },
  { value: "solid", label: "Solid", icon: <SquareIcon aria-hidden="true" /> },
]

/** The window is glass only on a Mac. Read at render: `main.tsx` stamps the
 *  platform after the modules load. */
function isMac() {
  return document.documentElement.dataset.platform === "mac"
}

export function AppearancePage() {
  // The same atoms the profile menu's toggles write: one setting, two doors.
  const scheme = useAtomValue(colorSchemeAtom)
  const setScheme = useSetAtom(writeColorSchemeAtom)
  const glass = useAtomValue(windowGlassAtom)
  const setGlass = useSetAtom(writeWindowGlassAtom)
  // The arcade is the open vault's machine-local file, like Space-to-ask.
  const { resolved, write } = useVaultSettings()

  return (
    <SettingsCard
      title="Window"
      description="How Holi looks on this machine. Your teammates keep their own."
    >
      <SettingsRow
        title="Theme"
        description="Light, dark, or whatever your system is set to."
      >
        <Segmented
          label="Theme"
          value={scheme}
          choices={THEMES}
          onChange={(next) => void setScheme(next)}
        />
      </SettingsRow>
      {isMac() ? (
        <SettingsRow
          title="Transparency"
          description="How much of the desktop shows through the window."
        >
          <Segmented
            label="Transparency"
            value={glass}
            choices={GLASSES}
            onChange={(next) => void setGlass(next)}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Arcade on the New tab"
        description="Your Holis play a small game behind an empty tab: they file papers in the outbox, and you can take over with the arrow keys."
        htmlFor="settings-grid-arcade"
      >
        <Switch
          id="settings-grid-arcade"
          disabled={resolved === null}
          checked={resolved?.gridArcade ?? true}
          onCheckedChange={(on) => void write("gridArcade", on, "local")}
        />
      </SettingsRow>
      <SettingsRow
        title="Fold the sidebar in Mail and Calendar"
        description="Mail or Calendar in front folds the files sidebar to its rail, and leaving gives it back. ⌘B opens it either way."
        htmlFor="settings-fold-sidebar"
      >
        <Switch
          id="settings-fold-sidebar"
          disabled={resolved === null}
          checked={resolved?.foldSidebarForApps ?? true}
          onCheckedChange={(on) =>
            void write("foldSidebarForApps", on, "local")
          }
        />
      </SettingsRow>
    </SettingsCard>
  )
}

// ── Updates ──

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago". */
export function checkedAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "yesterday" : `${days}d ago`
}

export function UpdatesPage() {
  const status = useAtomValue(updateStatusAtom)
  const check = useSetAtom(checkForUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const install = useSetAtom(installUpdateAtom)
  const setEnabled = useSetAtom(setAutoUpdateAtom)
  const setChannel = useSetAtom(setUpdateChannelAtom)
  const supported = status?.supported === true

  const action = !supported ? null : status.state === "ready" ? (
    <Button size="sm" onClick={() => void install()}>
      Restart to update
    </Button>
  ) : status.state === "available" && status.lastError !== null ? (
    <Button variant="outline" size="sm" onClick={() => void retry()}>
      Retry
    </Button>
  ) : (
    <Button
      variant="outline"
      size="sm"
      disabled={status.state !== "idle"}
      onClick={() => void check()}
    >
      Check now
    </Button>
  )

  const described =
    status === null
      ? undefined
      : [
          status.version === "" ? null : `You have Holi ${status.version}.`,
          status.lastCheckAt === null
            ? null
            : `Last checked ${checkedAgo(status.lastCheckAt)}.`,
          status.lastError,
        ]
          .filter((part) => part !== null && part !== "")
          .join(" ") || undefined

  return (
    <div className="flex flex-col gap-8">
    <SettingsCard title="Updates" description="Holi itself, on this machine.">
      <SettingsRow title={updateHeadline(status)} description={described}>
        {action}
      </SettingsRow>
      {status?.availableVersion != null &&
      status.availableVersion !== status.version ? (
        <ReleaseNotesRow
          key={status.availableVersion}
          version={status.availableVersion}
          title={`What’s new in Holi ${status.availableVersion}`}
        />
      ) : null}
      {status !== null && status.version !== "" ? (
        <ReleaseNotesRow
          key={status.version}
          version={status.version}
          title={`Holi ${status.version}, the version you have`}
        />
      ) : null}
      <SettingsRow
        title="Dev prereleases"
        description="Development releases instead of stable ones. Turning this off downloads the latest stable release, even when it is older than yours; restart to install it."
        htmlFor="settings-dev-channel"
      >
        <Switch
          id="settings-dev-channel"
          disabled={!supported}
          checked={status?.channel === "dev"}
          onCheckedChange={(on) => void setChannel(on ? "dev" : "stable")}
        />
      </SettingsRow>
      <SettingsRow
        title="Update automatically"
        description="Download new versions in the background. One installs when you quit Holi."
        htmlFor="settings-auto-update"
      >
        <Switch
          id="settings-auto-update"
          disabled={!supported}
          checked={status?.enabled === true}
          onCheckedChange={(on) => void setEnabled(on)}
        />
      </SettingsRow>
      <OpenAtLoginRow />
    </SettingsCard>
    <VaultSkillsCard />
    </div>
  )
}

type NotesAnswer = Awaited<ReturnType<typeof trpc.updates.notes.query>>

/**
 * One release's notes, from its GitHub release, asked for when first shown
 * and shown formatted but never as HTML (`MarkdownText`). GitHub not
 * answering is asked again on the next opening.
 */
function ReleaseNotesRow({ version, title }: { version: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState<NotesAnswer | undefined>(undefined)
  useEffect(() => {
    if (!open || answer !== undefined) return
    let live = true
    trpc.updates.notes
      .query({ version })
      .then((found) => live && setAnswer(found))
      .catch(() => live && setAnswer({ kind: "unreachable" }))
    return () => {
      live = false
    }
  }, [open, answer, version])

  const url =
    answer?.kind === "found" ? openableUrl(answer.notes.url) : null
  return (
    <SettingsRow title={title}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Release notes
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Unanswered is asked again when shown again.
          if (!next && answer?.kind === "unreachable") setAnswer(undefined)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Holi {version}</DialogTitle>
            <DialogDescription>
              {answer?.kind === "found" ? answer.notes.name : "Release notes"}
            </DialogDescription>
          </DialogHeader>
          {answer === undefined ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Loading notes">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : answer.kind === "unreachable" ? (
            <p className="text-muted-foreground text-sm">
              GitHub did not answer. Close this and try again.
            </p>
          ) : answer.kind === "none" ? (
            <p className="text-muted-foreground text-sm">
              GitHub has no notes for this version.
            </p>
          ) : answer.notes.body.trim() === "" ? (
            <p className="text-muted-foreground text-sm">No notes for this version.</p>
          ) : (
            <MarkdownText
              body={answer.notes.body}
              className="text-muted-foreground flex max-h-96 flex-col gap-2 overflow-auto text-sm"
            />
          )}
          {url !== null ? (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => void window.holi.openExternal(url)}
            >
              <ExternalLinkIcon data-icon="inline-start" aria-hidden="true" />
              {answer?.kind === "found" ? answer.notes.name : "The release"} on GitHub
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
    </SettingsRow>
  )
}

/**
 * Where the open vault's skills and hooks stand against this release, what
 * the update on open did, and whether the vault takes them on open
 * (`autoUpdateSkills`, committed, so a team answers it once).
 */
function VaultSkillsCard() {
  const status = useAtomValue(openSkillsStatusAtom)
  const notice = useAtomValue(skillsNoticeAtom)
  const update = useSetAtom(updateSkillsAtom)
  const merge = useSetAtom(mergeSkillsConflictsAtom)
  const dismiss = useSetAtom(dismissSkillsNoticeAtom)
  const { resolved, write } = useVaultSettings()
  const [busy, setBusy] = useState(false)
  const pending = status?.pending.length ?? 0

  const run = async (what: () => Promise<void>) => {
    setBusy(true)
    try {
      await what()
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title="This vault’s skills"
      description="The skills and hooks Holi gave the vault's agent, against this release."
    >
      {status === null ? (
        <SettingsRow title={<Skeleton className="h-4 w-48" />} />
      ) : (
        <SettingsRow
          title={
            pending === 0
              ? "Skills and hooks are up to date"
              : `This version of Holi has ${pending} newer ${pending === 1 ? "file" : "files"} for this vault`
          }
          description={
            status.release === null
              ? "Holi has not written this vault’s skills on this machine."
              : `Last brought in by Holi ${status.release}.`
          }
        >
          {pending > 0 ? (
            <Button size="sm" disabled={busy} onClick={() => void run(update)}>
              Update skills
            </Button>
          ) : null}
        </SettingsRow>
      )}
      {notice !== null ? (
        <SettingsRow
          title="Updated when the vault opened"
          description={
            notice.changed.length > 0
              ? `${notice.summary} ${notice.changed.join(", ")}`
              : notice.summary
          }
        >
          <div className="flex gap-2">
            {notice.conflicts !== null ? (
              <Button size="sm" disabled={busy} onClick={() => void run(merge)}>
                Merge with the agent
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => dismiss()}>
              Done
            </Button>
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Update skills automatically"
        description="Bring a new release's skills in when the vault opens, after it has synced. Saved in the vault, so it is the whole team's answer."
        htmlFor="settings-auto-skills"
      >
        <Switch
          id="settings-auto-skills"
          disabled={resolved === null}
          checked={resolved?.autoUpdateSkills === true}
          onCheckedChange={(on) =>
            void write("autoUpdateSkills", on, "committed")
          }
        />
      </SettingsRow>
    </SettingsCard>
  )
}

function OpenAtLoginRow() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    trpc.app.loginItem
      .query()
      .then((answer) => live && setOpen(answer.openAtLogin))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return (
    <SettingsRow
      title="Open at login"
      description="Start Holi out of sight when you log in, so reminders and sync work from the start."
      htmlFor="settings-open-at-login"
    >
      <Switch
        id="settings-open-at-login"
        disabled={open === null}
        checked={open === true}
        onCheckedChange={(on) =>
          void trpc.app.setLoginItem
            .mutate({ openAtLogin: on })
            .then((answer) => setOpen(answer.openAtLogin))
        }
      />
    </SettingsRow>
  )
}

// ── Account ──

export function AccountPage() {
  const viewer = useAtomValue(sessionAtom)
  const [confirming, setConfirming] = useState(false)
  const name = viewer?.name ?? viewer?.login ?? ""

  return (
    <SettingsCard
      title="GitHub account"
      description="Holi reads and writes your vaults as this account."
    >
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <Avatar className="size-8">
              <AvatarImage src={viewer?.avatarUrl} alt="" />
              <AvatarFallback className="text-xs">
                {name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{name}</span>
              <span className="text-muted-foreground truncate text-xs font-normal">
                @{viewer?.login}
              </span>
            </span>
          </span>
        }
      >
        <div className="flex items-center gap-2">
          {viewer?.login ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.holi.openExternal(
                  `https://github.com/${viewer.login}`
                )
              }
            >
              Profile
              <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Sign out
          </Button>
        </div>
      </SettingsRow>
      <SignOutConfirm open={confirming} onOpenChange={setConfirming} />
    </SettingsCard>
  )
}

function SignOutConfirm({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const signOut = useSetAtom(signOutAtom)
  const [deleteClones, setDeleteClones] = useState(false)
  /** Vaults holding commits GitHub does not have yet, asked when it opens. */
  const [unpushed, setUnpushed] = useState<{ remote: string; ahead: number }[]>(
    []
  )
  const id = useId()

  useEffect(() => {
    if (!open) return
    let live = true
    setDeleteClones(false)
    setUnpushed([])
    trpc.vaults.unpushed
      .query()
      .then((found) => live && setUnpushed(found.filter((v) => v.ahead > 0)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [open])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            Holi forgets your GitHub credential and stops syncing. Your vaults
            stay on this machine unless you choose otherwise.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal">
          <Checkbox
            id={id}
            checked={deleteClones}
            onCheckedChange={(next) => setDeleteClones(next === true)}
          />
          <FieldLabel htmlFor={id} className="font-normal">
            Also move the vaults on this machine to the Trash
          </FieldLabel>
        </Field>
        {unpushed.length > 0 ? (
          <p className="text-destructive text-sm">
            {unpushed
              .map(
                (v) =>
                  `${v.remote} has ${v.ahead} ${v.ahead === 1 ? "commit" : "commits"} GitHub does not have yet`
              )
              .join("; ")}
            .
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void signOut({ deleteClones })}
          >
            Sign out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
