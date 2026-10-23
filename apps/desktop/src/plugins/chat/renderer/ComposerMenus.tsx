/**
 * The composer's two menus, opened by what is typed: `/` lists what Claude
 * Code runs as a command in the vault, `@` lists the vault's documents. The
 * caret stays in the composer; its arrow keys, Enter and Tab pick and Escape
 * closes (`Composer.tsx`), and the pointer picks too.
 *
 * Ported from MonoCode's `features/skills/ui/SkillPicker.tsx` and
 * `features/sessions/ui/FileMentionPicker.tsx`
 * (https://github.com/hardbeat920/monocode), MIT License, Copyright (c) 2026
 * Nick; see NOTICE.md. Holi's changes: shadcn's popover surface instead of
 * MonoCode's own, the rows' scope as words, and the loading, empty and error
 * states every list here has.
 */
import {
  FileTextIcon,
  SlashIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react"
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/plugin-api"
import type { ChatCommand } from "../shared/chat"
import type { RankedPath } from "./composer-tokens"

/** MonoCode's hover rule: a row follows the pointer only once it has really
 *  moved, so a list scrolling under a still pointer does not steal the
 *  keyboard's row. */
function usePointerRows(active: number, rows: unknown) {
  const activeRef = useRef<HTMLButtonElement>(null)
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false })
  const fromPointer = useRef(false)

  useEffect(() => {
    pointer.current.allow = false
  }, [rows])

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false
      return
    }
    pointer.current.allow = false
    activeRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [active])

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y)
      return
    pointer.current = { x: e.clientX, y: e.clientY, allow: true }
  }
  const enter = (index: number, onActive: (i: number) => void) => {
    if (!pointer.current.allow) return
    fromPointer.current = true
    onActive(index)
  }
  return { activeRef, onMouseMove, enter }
}

/** The menus' surface: shadcn's popover, standing above the composer. */
function MenuSurface({
  label,
  children,
  footer,
}: {
  label: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div
      data-slot="composer-menu"
      aria-label={label}
      className="bg-popover text-popover-foreground ring-foreground/10 flex flex-col overflow-hidden rounded-lg text-sm shadow-md ring-1"
    >
      {children}
      {footer}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-3 py-2.5 text-xs">{children}</p>
}

function MenuSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-1 p-1">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-8 motion-reduce:animate-none" />
      ))}
    </div>
  )
}

/** Where a command comes from, in words. */
const SCOPE_LABEL: Record<ChatCommand["scope"], string> = {
  vault: "Vault",
  user: "Yours",
  plugin: "Plugin",
  builtin: "Claude Code",
}

const KIND_ICON = {
  skill: SparklesIcon,
  command: SlashIcon,
  builtin: TerminalIcon,
} as const

export function CommandMenu({
  commands,
  query,
  active,
  loading,
  error,
  onRetry,
  onActive,
  onPick,
}: {
  commands: ChatCommand[]
  query: string
  active: number
  loading: boolean
  error: string | null
  onRetry: () => void
  onActive: (index: number) => void
  onPick: (command: ChatCommand) => void
}) {
  const rows = usePointerRows(active, commands)
  return (
    <MenuSurface label="Commands and skills">
      {loading && commands.length === 0 && error === null ? (
        <MenuSkeleton label="Loading commands" />
      ) : commands.length === 0 ? (
        <Hint>
          {query.trim()
            ? "No matching commands or skills. Keep typing to send it as text."
            : "No commands yet. Add one to .claude/commands or a skill to .claude/skills."}
        </Hint>
      ) : (
        <div
          role="listbox"
          aria-label="Commands and skills"
          onMouseMove={rows.onMouseMove}
          className="flex max-h-[min(280px,40vh)] flex-col overflow-y-auto overscroll-contain p-1"
        >
          {commands.map((command, index) => {
            const highlighted = index === active
            const Glyph = KIND_ICON[command.kind]
            return (
              <button
                key={`${command.scope}:${command.name}`}
                ref={highlighted ? rows.activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                data-active={highlighted || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => rows.enter(index, onActive)}
                onClick={() => onPick(command)}
                className="data-active:bg-accent data-active:text-accent-foreground flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none"
              >
                <Glyph
                  aria-hidden="true"
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">
                      /{command.name}
                    </span>
                    <span className="text-muted-foreground ms-auto shrink-0 text-xs">
                      {SCOPE_LABEL[command.scope]}
                    </span>
                  </span>
                  {command.description ? (
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {command.description}
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {error !== null && (
        // Not a failure the person has to deal with: the built-ins above
        // still run. Quiet, at the menu's foot, and only while it is open.
        <div
          role="status"
          className="border-border flex items-center gap-2 border-t px-3 py-2"
        >
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            Couldn’t load this vault’s commands. Showing the built-ins.
          </p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}
    </MenuSurface>
  )
}

/** A name with the matched letters in the foreground. */
function MatchText({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>
  const hit = new Set(positions)
  return (
    <>
      {[...text].map((ch, i) => (
        <span
          key={i}
          className={hit.has(i) ? "text-foreground font-medium" : undefined}
        >
          {ch}
        </span>
      ))}
    </>
  )
}

export function MentionMenu({
  paths,
  query,
  active,
  loading,
  onActive,
  onPick,
}: {
  paths: RankedPath[]
  query: string
  active: number
  loading: boolean
  onActive: (index: number) => void
  onPick: (path: RankedPath) => void
}) {
  const rows = usePointerRows(active, paths)
  return (
    <MenuSurface label="Vault documents">
      {loading ? (
        <MenuSkeleton label="Loading documents" />
      ) : paths.length === 0 ? (
        <Hint>
          {query.trim()
            ? "No document matches. Keep typing to send it as text."
            : "This vault has no documents yet."}
        </Hint>
      ) : (
        <div
          role="listbox"
          aria-label="Vault documents"
          onMouseMove={rows.onMouseMove}
          className="flex max-h-[min(280px,40vh)] flex-col overflow-y-auto overscroll-contain p-1"
        >
          {paths.map((row, index) => {
            const highlighted = index === active
            return (
              <button
                key={row.path}
                ref={highlighted ? rows.activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                data-active={highlighted || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => rows.enter(index, onActive)}
                onClick={() => onPick(row)}
                className="data-active:bg-accent data-active:text-accent-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-start outline-none"
              >
                <FileTextIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-4 shrink-0"
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    query.trim() !== "" && "text-muted-foreground"
                  )}
                >
                  <MatchText text={row.name} positions={row.positions} />
                </span>
                {row.folder ? (
                  <span className="text-muted-foreground max-w-[45%] min-w-0 truncate text-xs">
                    {row.folder}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </MenuSurface>
  )
}
