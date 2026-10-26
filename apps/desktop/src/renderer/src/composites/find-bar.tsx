/**
 * The find bar, after VS Code's, for whichever editor drives it: the
 * document's (`document-view/document-find-bar.tsx`, ProseMirror) and a code
 * file's (`file-view/code-find-bar.tsx`, CodeMirror). It floats at the top
 * right of the text and holds only what is typed and toggled; the editor's
 * own bar finds, counts and replaces. Enter and ⌘G step forward, ⇧Enter and
 * ⇧⌘G back; Escape closes it. The arrow opens a replace row, where Enter
 * replaces and ⌘Enter replaces all.
 */
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RegexIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react"

import { ShortcutKeys } from "@/features/documents/rich-text/rich-text-toolbar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Toggle } from "@/components/ui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface FindOptions {
  search: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  replace: string
}

export const EMPTY_FIND_OPTIONS: FindOptions = {
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
}

/** What a ⌘F hands a bar: a new `token` refocuses its field, and `text`,
 *  when the selection was one line, becomes the query. */
export interface FindRequest {
  token: number
  text: string | null
}

/** How many matches there are, and which one (1-based) the selection is on. */
export interface FindCount {
  total: number
  current: number | null
}

export function FindBar({
  label,
  inputRef,
  options,
  onOptionsChange,
  count,
  invalid,
  editable,
  replacing,
  onReplacingChange,
  onNext,
  onPrev,
  onReplace,
  onReplaceAll,
  onClose,
}: {
  /** The search region's name, "Find in document". */
  label: string
  inputRef: Ref<HTMLInputElement>
  options: FindOptions
  onOptionsChange: (patch: Partial<FindOptions>) => void
  count: FindCount
  /** The regular expression does not compile. */
  invalid: boolean
  /** Replace is offered only where the text can change. */
  editable: boolean
  replacing: boolean
  onReplacingChange: (open: boolean) => void
  onNext: () => void
  onPrev: () => void
  onReplace: () => void
  onReplaceAll: () => void
  onClose: () => void
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (mod && !event.altKey && key === "f") {
      event.preventDefault()
      event.stopPropagation()
      const input = event.currentTarget.querySelector<HTMLInputElement>(
        "input[aria-label='Find']"
      )
      input?.focus()
      input?.select()
    } else if (mod && !event.altKey && key === "g") {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) onPrev()
      else onNext()
    }
  }

  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (event.shiftKey) onPrev()
    else onNext()
  }

  function handleReplaceKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (event.metaKey || event.ctrlKey) onReplaceAll()
    else onReplace()
  }

  const status =
    options.search === ""
      ? ""
      : count.total === 0
        ? "No results"
        : count.current === null
          ? `${count.total} ${count.total === 1 ? "result" : "results"}`
          : `${count.current} of ${count.total}`
  const none = count.total === 0

  return (
    <Card size="sm" className="p-1" onKeyDown={handleKeyDown}>
      <div role="search" aria-label={label} className="flex gap-1">
        <BarButton
          label={replacing ? "Hide replace" : "Show replace"}
          onClick={() => onReplacingChange(!replacing)}
          aria-expanded={replacing}
          disabled={!editable}
        >
          {replacing ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </BarButton>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1">
            <InputGroup className="w-72">
              <InputGroupInput
                ref={inputRef}
                aria-label="Find"
                placeholder="Find"
                value={options.search}
                aria-invalid={invalid || undefined}
                onChange={(event) =>
                  onOptionsChange({ search: event.target.value })
                }
                onKeyDown={handleFieldKeyDown}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText
                  role="status"
                  aria-live="polite"
                  className="text-xs tabular-nums"
                >
                  {status}
                </InputGroupText>
                <OptionToggle
                  label="Match case"
                  pressed={options.caseSensitive}
                  onPressedChange={(caseSensitive) =>
                    onOptionsChange({ caseSensitive })
                  }
                >
                  <CaseSensitiveIcon />
                </OptionToggle>
                <OptionToggle
                  label="Match whole word"
                  pressed={options.wholeWord}
                  onPressedChange={(wholeWord) =>
                    onOptionsChange({ wholeWord })
                  }
                >
                  <WholeWordIcon />
                </OptionToggle>
                <OptionToggle
                  label="Use regular expression"
                  pressed={options.regexp}
                  onPressedChange={(regexp) => onOptionsChange({ regexp })}
                >
                  <RegexIcon />
                </OptionToggle>
              </InputGroupAddon>
            </InputGroup>
            <BarButton
              label="Previous match"
              shortcut={["shift", "mod", "G"]}
              disabled={none}
              onClick={onPrev}
            >
              <ArrowUpIcon />
            </BarButton>
            <BarButton
              label="Next match"
              shortcut={["mod", "G"]}
              disabled={none}
              onClick={onNext}
            >
              <ArrowDownIcon />
            </BarButton>
            <BarButton label="Close" shortcut={["Esc"]} onClick={onClose}>
              <XIcon />
            </BarButton>
          </div>
          {replacing && editable ? (
            <div className="flex items-center gap-1">
              <InputGroup className="w-72">
                <InputGroupInput
                  aria-label="Replace"
                  placeholder="Replace"
                  value={options.replace}
                  onChange={(event) =>
                    onOptionsChange({ replace: event.target.value })
                  }
                  onKeyDown={handleReplaceKeyDown}
                />
              </InputGroup>
              <BarButton
                label="Replace"
                shortcut={["⏎"]}
                disabled={none}
                onClick={onReplace}
              >
                <ReplaceIcon />
              </BarButton>
              <BarButton
                label="Replace all"
                shortcut={["mod", "⏎"]}
                disabled={none}
                onClick={onReplaceAll}
              >
                <ReplaceAllIcon />
              </BarButton>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

function BarButton({
  label,
  shortcut,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
  label: string
  shortcut?: readonly string[]
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

function OptionToggle({
  label,
  pressed,
  onPressedChange,
  children,
}: {
  label: string
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          size="sm"
          aria-label={label}
          pressed={pressed}
          onPressedChange={onPressedChange}
        >
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
