/**
 * The vault's pages: what it is and where it lives (General), who can see it
 * (Members), how its notes read (Editor) and what a commit does (Commits).
 */
import { useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect, useState } from "react"
import {
  EDITOR_FONTS,
  VAULT_SETTING_DEFAULTS,
  syncLabel,
  type Collaborator,
  type EditorFont,
  type SyncLabel,
} from "@holi/shared"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Switch } from "@/components/ui/switch"
import { trpc } from "@/lib/trpc"
import { settingDescriptorsAtom } from "@/state/plugins"
import {
  activeRemoteAtom,
  retrySyncAtom,
  syncStateAtom,
  vaultsAtom,
} from "@/state/vaults"
import { ExternalLinkIcon, FolderOpenIcon } from "lucide-react"

import {
  OptionSelect,
  Segmented,
  SettingsCard,
  SettingsRow,
  SettingsRowsLoading,
  type Choice,
} from "./settings-kit"
import { useVaultSettings } from "./use-vault-settings"

const githubUrl = (path: string) => `https://github.com/${path}`

const SYNC_BADGE: Record<
  SyncLabel["tone"],
  "success-light" | "info-light" | "warning-light"
> = {
  quiet: "success-light",
  busy: "info-light",
  warn: "warning-light",
}

// ── General ──

export function GeneralPage() {
  const remote = useAtomValue(activeRemoteAtom)
  const entry = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  const sync = syncLabel(useAtomValue(syncStateAtom))
  const retrySync = useSetAtom(retrySyncAtom)

  if (entry === undefined) {
    return (
      <SettingsCard title="Vault" description="The vault open in this window.">
        <SettingsRowsLoading rows={3} label="Reading the vault" />
      </SettingsCard>
    )
  }

  return (
    <SettingsCard
      title="Vault"
      description="A vault is a GitHub repository, kept in step with a copy on this machine."
    >
      <SettingsRow title="Name" description="The repository's name.">
        <span className="text-sm font-medium">{entry.name}</span>
      </SettingsRow>
      <SettingsRow
        title="Repository"
        description="Where the vault lives, and who it is shared with."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void window.holi.openExternal(githubUrl(entry.remote))}
        >
          {entry.remote}
          <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
        </Button>
      </SettingsRow>
      <SettingsRow
        title="On this machine"
        description={<span className="break-all">{entry.path}</span>}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void window.holi.openPath(entry.path)}
        >
          <FolderOpenIcon data-icon="inline-start" aria-hidden="true" />
          Show folder
        </Button>
      </SettingsRow>
      <SettingsRow
        title="Sync"
        description="Your edits are committed and pushed as you work, and others' are pulled in."
      >
        <div className="flex items-center gap-2">
          <Badge variant={SYNC_BADGE[sync.tone]}>{sync.text}</Badge>
          {sync.tone === "warn" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retrySync()}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsCard>
  )
}

// ── Members ──

type MembersState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; visibility: string; collaborators: Collaborator[] }

export function MembersPage() {
  const remote = useAtomValue(activeRemoteAtom)
  const [state, setState] = useState<MembersState>({ kind: "loading" })

  const read = useCallback(() => {
    if (remote === null) return () => {}
    let live = true
    setState({ kind: "loading" })
    trpc.github.collaborators
      .query({ remote })
      .then(
        ({ visibility, collaborators }) =>
          live && setState({ kind: "ready", visibility, collaborators })
      )
      // Ordinary (offline, not on GitHub, a token without the scope): say so
      // rather than show an empty list, which would read as "nobody else".
      .catch(
        (error: unknown) =>
          live &&
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          })
      )
    return () => {
      live = false
    }
  }, [remote])

  useEffect(() => read(), [read])

  const manage =
    remote === null ? null : (
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void trpc.github.openCollaboratorSettings.mutate({ remote })
        }
      >
        Manage on GitHub
        <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
      </Button>
    )

  return (
    <SettingsCard
      title="Members"
      description="Who can open this vault. GitHub decides; Holi shows what it says."
      action={manage}
    >
      {state.kind === "loading" ? (
        <SettingsRowsLoading rows={2} label="Reading the members" />
      ) : state.kind === "error" ? (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">
              GitHub did not list who has access.
            </span>
            <span className="text-muted-foreground text-xs break-words">
              {state.message}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => read()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <SettingsRow
            title="Visibility"
            description="A public vault can be read by anyone on GitHub."
          >
            <Badge
              variant={
                state.visibility === "public" ? "warning-light" : "secondary"
              }
            >
              {state.visibility}
            </Badge>
          </SettingsRow>
          {state.collaborators.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyTitle>Only you, so far</EmptyTitle>
                <EmptyDescription>
                  Invite people on GitHub and they can clone this vault in Holi.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>{manage}</EmptyContent>
            </Empty>
          ) : (
            state.collaborators.map((person) => (
              <SettingsRow
                key={person.accountId}
                title={
                  <span className="flex items-center gap-2">
                    <Avatar className="size-6">
                      <AvatarImage src={person.avatarUrl} alt="" />
                      <AvatarFallback className="text-xs">
                        {person.login.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {person.login}
                  </span>
                }
              >
                <Badge variant="outline">{person.permission}</Badge>
              </SettingsRow>
            ))
          )}
        </>
      )}
    </SettingsCard>
  )
}

// ── Editor ──

const FONT_LABEL: Record<EditorFont, string> = {
  serif: "Serif",
  sans: "Sans",
  mono: "Mono",
}

const FONTS: readonly Choice<EditorFont>[] = EDITOR_FONTS.map((font) => ({
  value: font,
  label: FONT_LABEL[font],
}))

export function EditorPage() {
  const { resolved, write } = useVaultSettings()

  return (
    <SettingsCard
      title="Writing"
      description="How notes read and what the editor does as you type."
    >
      {resolved === null ? (
        <SettingsRowsLoading rows={3} label="Reading the settings" />
      ) : (
        <>
          <SettingsRow
            title="Notes are set in"
            description="Prose only. Code and frontmatter stay monospaced. Shared with the vault."
          >
            <Segmented
              label="Notes are set in"
              value={resolved.editorFont}
              choices={FONTS}
              onChange={(font) => void write("editorFont", font, "committed")}
            />
          </SettingsRow>
          <SettingsRow
            title="Keep a daily note"
            description="A fresh note each morning, with yesterday's filed away. In a shared vault everyone writes the same one."
            htmlFor="settings-daily-notes"
          >
            <Switch
              id="settings-daily-notes"
              checked={resolved.dailyNotes}
              onCheckedChange={(on) =>
                void write("dailyNotes", on, "committed")
              }
            />
          </SettingsRow>
          <SettingsRow
            title="Space asks the agent"
            description="Space on an empty line starts an ask for the agent, with the note as context. On this machine only."
            htmlFor="settings-space-asks"
          >
            <Switch
              id="settings-space-asks"
              checked={resolved.spaceAsksAgent}
              onCheckedChange={(on) =>
                void write("spaceAsksAgent", on, "local")
              }
            />
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  )
}

// ── Commits ──

const MB = 1024 * 1024

export function CommitsPage() {
  const { resolved, write } = useVaultSettings()
  const descriptors = useAtomValue(settingDescriptorsAtom)
  const limit = descriptors.find((d) => d.key === "maxCommittedFileBytes")
  const hooks = descriptors.find((d) => d.key === "hooks")
  const sizes: Choice<string>[] =
    limit?.control.kind === "choice"
      ? limit.control.options.map((option) => ({
          value: String(option.value),
          label: option.label,
        }))
      : []
  const toggles = hooks?.control.kind === "group" ? hooks.control.toggles : []

  if (resolved === null) {
    return (
      <SettingsCard title="Saving" description="What happens to each commit.">
        <SettingsRowsLoading rows={3} label="Reading the settings" />
      </SettingsCard>
    )
  }

  const current = String(resolved.maxCommittedFileBytes)
  // A hand-written size none of the options name still shows as itself.
  const sizeChoices = sizes.some((size) => size.value === current)
    ? sizes
    : [
        ...sizes,
        {
          value: current,
          label: `${Math.round(resolved.maxCommittedFileBytes / MB)} MB`,
        },
      ]

  return (
    <>
      <SettingsCard
        title="Saving"
        description="Your work is committed and pushed as you go. These apply to everyone in the vault."
      >
        <SettingsRow
          title="Largest file to commit"
          description="Anything bigger is left out and reported, rather than pushed to everyone. GitHub refuses files over 100 MB."
          htmlFor="settings-max-file"
        >
          <OptionSelect
            id="settings-max-file"
            label="Largest file to commit"
            value={current}
            choices={sizeChoices}
            onChange={(bytes) =>
              void write("maxCommittedFileBytes", Number(bytes), "committed")
            }
          />
        </SettingsRow>
      </SettingsCard>
      <SettingsCard
        title="Tidy on every commit"
        description="Each runs as your work is saved. None can stop a save."
      >
        {toggles.map((toggle) => {
          const block = resolved.hooks ?? VAULT_SETTING_DEFAULTS.hooks
          const id = `settings-hook-${toggle.key}`
          return (
            <SettingsRow
              key={toggle.key}
              title={toggle.label}
              description={toggle.explanation}
              htmlFor={id}
            >
              <Switch
                id={id}
                checked={block[toggle.key] === true}
                // The whole block: a patch naming one transform must not read
                // as an answer about the others.
                onCheckedChange={(on) =>
                  void write(
                    "hooks",
                    { ...block, [toggle.key]: on },
                    "committed"
                  )
                }
              />
            </SettingsRow>
          )
        })}
      </SettingsCard>
    </>
  )
}
