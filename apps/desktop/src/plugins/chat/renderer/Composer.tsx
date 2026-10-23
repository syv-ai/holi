/**
 * Where you write to Claude Code: where it works (the vault and its branch),
 * the text, and under it the model and its effort, how much it may do
 * without asking, and send. `/` opens Claude Code's commands and skills for
 * the vault, `@` the vault's documents. Enter sends, Shift+Enter starts a new
 * line, and while a turn runs the send button stops it.
 *
 * Ported from MonoCode's `features/sessions/ui/Composer.tsx`, `ModelPicker`
 * and `AccessPicker` (https://github.com/hardbeat920/monocode), MIT License,
 * Copyright (c) 2026 Nick; see NOTICE.md. Holi's changes: shadcn's input
 * group in place of MonoCode's own box; the choices are the ones Claude Code
 * takes on its command line (`--model`, `--effort`, `--permission-mode`),
 * and the permission choices are its own modes, every one of which still
 * asks; no attachments, since a chat sends text.
 */
import { useAtomValue, useSetAtom } from "jotai"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  GitBranchIcon,
  ShieldCheckIcon,
  SquareIcon,
} from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { isHiddenPath } from "@holi/shared"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  activeRemoteAtom,
  cn,
  snapshotAtom,
  snapshotLoadedAtom,
  vaultsAtom,
} from "@/plugin-api"
import {
  EFFORTS,
  modelLabel,
  PERMISSION_MODES,
  type ChatCommand,
  type Effort,
  type PermissionMode,
} from "../shared/chat"
import {
  mentionTokenAt,
  mentionValue,
  rankCommands,
  rankPaths,
  replaceToken,
  slashTokenAt,
  type RankedPath,
  type Token,
} from "./composer-tokens"
import { CommandMenu, MentionMenu } from "./ComposerMenus"
import {
  branchAtom,
  commandsAtom,
  loadBranchAtom,
  loadCommandsAtom,
} from "./state/chats"

/** The models offered: Claude Code's own aliases, which follow its releases
 *  without Holi keeping a list of ids. */
const MODELS: readonly { value: string | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
]

export interface ComposerChoice {
  model: string | null
  effort: Effort | null
  mode: PermissionMode
}

/** The real ellipsis, as the house writes it. */
export const COMPOSER_PLACEHOLDER =
  "Ask, build, / for commands, @ for references…"

/** The vault's name as the vault switcher shows it. */
export function useVaultName(): string {
  const remote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  return (
    vaults.find((vault) => vault.remote === remote)?.name ??
    remote?.split("/")[1] ??
    "this vault"
  )
}

/** The model and its effort, as the picker's button reads: "Opus 5.5 ·
 *  Medium". `ran` is the model the last turn ran on, which names an alias
 *  ("opus") or Claude Code's default precisely. */
export function choiceLabel(choice: ComposerChoice, ran?: string): string {
  const alias = choice.model
  const model =
    ran !== undefined && (alias === null || ran.includes(alias))
      ? modelLabel(ran)
      : alias === null
        ? "Default"
        : modelLabel(alias)
  const effort = EFFORTS.find((e) => e.value === choice.effort)?.label
  return effort === undefined ? model : `${model} · ${effort}`
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  choice,
  onChoice,
  ranModel,
  autoFocus,
  error,
  large = false,
}: {
  value: string
  onChange(value: string): void
  onSend(): void
  /** Stops the turn in flight; without it a busy composer only waits. */
  onStop?(): void
  /** A turn is running, or a message is on its way. */
  busy: boolean
  choice: ComposerChoice
  onChoice?(choice: ComposerChoice): void
  /** The model the last turn ran on, for the picker's label. */
  ranModel?: string
  autoFocus?: boolean
  error?: string | null
  /** The new-session page's composer: a taller field. */
  large?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const vaultName = useVaultName()
  const branch = useAtomValue(branchAtom)
  const loadBranch = useSetAtom(loadBranchAtom)
  const commandsState = useAtomValue(commandsAtom)
  const loadCommands = useSetAtom(loadCommandsAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const snapshotLoaded = useAtomValue(snapshotLoadedAtom)

  /** The token the caret is in, and the one Escape closed (so it stays
   *  closed until the caret leaves it). */
  const [slash, setSlash] = useState<Token | null>(null)
  const [mention, setMention] = useState<Token | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  /** Where the caret goes once a pick has re-rendered the text. */
  const caretAfter = useRef<number | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  useEffect(() => {
    void loadBranch()
  }, [loadBranch])
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || caretAfter.current === null) return
    el.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  }, [value])

  const slashOpen = slash !== null && dismissed !== slash.start
  const mentionOpen =
    !slashOpen && mention !== null && dismissed !== mention.start

  useEffect(() => {
    if (slashOpen) void loadCommands()
  }, [slashOpen, loadCommands])

  const commands: ChatCommand[] = useMemo(() => {
    if (!slashOpen) return []
    const list =
      commandsState.status === "ready" || commandsState.status === "loading"
        ? (commandsState.list ?? [])
        : []
    return rankCommands(list, slash?.query ?? "")
  }, [slashOpen, commandsState, slash?.query])

  /** The vault's documents, most recently changed first. */
  const recent = useMemo(
    () =>
      snapshot.docs
        .filter((doc) => !isHiddenPath(doc.path))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((doc) => doc.path),
    [snapshot.docs]
  )
  const paths: RankedPath[] = useMemo(
    () => (mentionOpen ? rankPaths(recent, mention?.query ?? "") : []),
    [mentionOpen, recent, mention?.query]
  )

  const rowCount = slashOpen ? commands.length : mentionOpen ? paths.length : 0
  useEffect(() => {
    setActive(0)
  }, [slash?.query, mention?.query, slashOpen, mentionOpen])

  /** Read the token under the caret after any edit or caret move. */
  function syncTokens(el: HTMLTextAreaElement) {
    const at = el.selectionStart ?? el.value.length
    const nextSlash = slashTokenAt(el.value, at)
    const nextMention = nextSlash ? null : mentionTokenAt(el.value, at)
    setSlash(nextSlash)
    setMention(nextMention)
    const start = nextSlash?.start ?? nextMention?.start ?? null
    if (start !== dismissed) setDismissed(null)
  }

  function pickCommand(command: ChatCommand) {
    if (slash === null) return
    const next = replaceToken(value, slash, "/", command.name)
    caretAfter.current = next.caret
    setSlash(null)
    onChange(next.text)
    ref.current?.focus()
  }

  function pickPath(row: RankedPath) {
    if (mention === null) return
    const next = replaceToken(value, mention, "@", mentionValue(row.path))
    caretAfter.current = next.caret
    setMention(null)
    onChange(next.text)
    ref.current?.focus()
  }

  function send() {
    if (value.trim() === "" || busy) return
    setSlash(null)
    setMention(null)
    onSend()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return
    if (slashOpen || mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        if (rowCount === 0) return
        const step = e.key === "ArrowDown" ? 1 : -1
        setActive((i) => (i + step + rowCount) % rowCount)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setDismissed((slashOpen ? slash : mention)?.start ?? null)
        return
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        const command = slashOpen ? commands[active] : undefined
        const path = mentionOpen ? paths[active] : undefined
        if (command !== undefined) {
          e.preventDefault()
          pickCommand(command)
          return
        }
        if (path !== undefined) {
          e.preventDefault()
          pickPath(path)
          return
        }
        if (e.key === "Tab") return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const set = (next: Partial<ComposerChoice>) =>
    onChoice?.({ ...choice, ...next })
  const pickable = onChoice !== undefined
  const modeLabel =
    PERMISSION_MODES.find((m) => m.value === choice.mode)?.label ?? "Ask first"
  const canSend = value.trim() !== "" && !busy
  const modelText = choiceLabel(choice, ranModel)

  return (
    <div data-composer="" className="relative flex flex-col gap-2">
      {slashOpen ? (
        <div className="absolute inset-x-0 bottom-full z-30 mb-2">
          <CommandMenu
            commands={commands}
            query={slash?.query ?? ""}
            active={active}
            loading={
              commandsState.status === "loading" ||
              commandsState.status === "idle"
            }
            error={
              commandsState.status === "error" ? commandsState.message : null
            }
            onRetry={() => void loadCommands(true)}
            onActive={setActive}
            onPick={pickCommand}
          />
        </div>
      ) : mentionOpen ? (
        <div className="absolute inset-x-0 bottom-full z-30 mb-2">
          <MentionMenu
            paths={paths}
            query={mention?.query ?? ""}
            active={active}
            loading={!snapshotLoaded}
            onActive={setActive}
            onPick={pickPath}
          />
        </div>
      ) : null}

      <InputGroup className="bg-background dark:bg-background">
        {/* Where Claude Code works: the vault's clone, on its branch. */}
        <InputGroupAddon align="block-start" className="gap-3">
          <InputGroupText className="text-xs">
            <FolderGit2Icon aria-hidden="true" className="size-3.5" />
            {vaultName}
          </InputGroupText>
          {branch !== null ? (
            <InputGroupText className="text-xs">
              <GitBranchIcon aria-hidden="true" className="size-3.5" />
              {branch}
            </InputGroupText>
          ) : null}
        </InputGroupAddon>

        <InputGroupTextarea
          ref={ref}
          rows={large ? 3 : 1}
          value={value}
          placeholder={COMPOSER_PLACEHOLDER}
          aria-label="Message Claude Code"
          aria-expanded={slashOpen || mentionOpen}
          aria-autocomplete="list"
          className={cn("max-h-56 text-sm", large ? "min-h-20" : "min-h-10")}
          onChange={(e) => {
            onChange(e.target.value)
            syncTokens(e.target)
          }}
          onSelect={(e) => syncTokens(e.currentTarget)}
          onClick={(e) => syncTokens(e.currentTarget)}
          onBlur={() => {
            setSlash(null)
            setMention(null)
          }}
          onKeyDown={onKeyDown}
        />

        <InputGroupAddon align="block-end" className="gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!pickable}>
              <InputGroupButton size="xs" aria-label={`Model: ${modelText}`}>
                {modelText}
                <ChevronDownIcon aria-hidden="true" />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={choice.model ?? ""}
                onValueChange={(v) => set({ model: v === "" ? null : v })}
              >
                {MODELS.map((m) => (
                  <DropdownMenuRadioItem key={m.label} value={m.value ?? ""}>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Effort</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={choice.effort ?? ""}
                onValueChange={(v) =>
                  set({ effort: v === "" ? null : (v as Effort) })
                }
              >
                <DropdownMenuRadioItem value="">Default</DropdownMenuRadioItem>
                {EFFORTS.map((e) => (
                  <DropdownMenuRadioItem key={e.value} value={e.value}>
                    {e.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!pickable}>
              <InputGroupButton
                size="xs"
                aria-label={`Before it acts: ${modeLabel}`}
              >
                <ShieldCheckIcon aria-hidden="true" />
                {modeLabel}
                <ChevronDownIcon aria-hidden="true" />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel>Before it acts</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={choice.mode}
                onValueChange={(v) => set({ mode: v as PermissionMode })}
              >
                {PERMISSION_MODES.map((m) => (
                  <DropdownMenuRadioItem key={m.value} value={m.value}>
                    <span className="flex flex-col gap-0.5">
                      {m.label}
                      <span className="text-muted-foreground text-xs">
                        {m.hint}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              {busy && onStop !== undefined ? (
                <InputGroupButton
                  variant="secondary"
                  size="icon-xs"
                  aria-label="Stop"
                  className="ms-auto"
                  onClick={onStop}
                >
                  <SquareIcon aria-hidden="true" className="fill-current" />
                </InputGroupButton>
              ) : busy ? (
                <InputGroupButton
                  variant="secondary"
                  size="icon-xs"
                  aria-label="Sending"
                  className="ms-auto"
                  disabled
                >
                  <Spinner aria-hidden="true" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  variant="default"
                  size="icon-xs"
                  aria-label="Send"
                  className="ms-auto"
                  disabled={!canSend}
                  onClick={send}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </InputGroupButton>
              )}
            </TooltipTrigger>
            <TooltipContent>{busy ? "Stop" : "Send"}</TooltipContent>
          </Tooltip>
        </InputGroupAddon>
      </InputGroup>
      {error != null && error !== "" ? (
        <p role="alert" className="text-destructive px-1 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
