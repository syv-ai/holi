/**
 * This machine's pages: how the window looks (Appearance), the app's own
 * updates and start (Updates), and who is signed in (Account).
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { trpc } from "@/lib/trpc"
import { colorSchemeAtom, writeColorSchemeAtom } from "@/state/color-scheme"
import { sessionAtom, signOutAtom } from "@/state/session"
import {
  checkForUpdateAtom,
  installUpdateAtom,
  retryUpdateDownloadAtom,
  setAutoUpdateAtom,
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

export function UpdatesPage() {
  const status = useAtomValue(updateStatusAtom)
  const check = useSetAtom(checkForUpdateAtom)
  const retry = useSetAtom(retryUpdateDownloadAtom)
  const install = useSetAtom(installUpdateAtom)
  const setEnabled = useSetAtom(setAutoUpdateAtom)
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

  return (
    <SettingsCard title="Updates" description="Holi itself, on this machine.">
      <SettingsRow
        title={updateHeadline(status)}
        description={
          status === null || status.version === ""
            ? undefined
            : `You have Holi ${status.version}.${status.lastError ? ` ${status.lastError}` : ""}`
        }
      >
        {action}
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
