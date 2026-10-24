/**
 * The document's find bar, after VS Code's: it floats at the top right of the
 * page, over the text, and drives `document-find.ts`. Typing moves the
 * selection to the first match from where the caret was; Enter and ⌘G step
 * forward, ⇧Enter and ⇧⌘G back; Escape closes it and gives the editor back
 * with the match selected. The arrow opens a replace row.
 */
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import type { Editor } from "@tiptap/react"
import { TextSelection } from "@tiptap/pm/state"
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
import {
  findNext,
  findPrev,
  replaceAll,
  replaceNext,
  setSearchState,
} from "prosemirror-search"

import { ShortcutKeys } from "@/components/blocks/rich-text-editor-2/components/rich-text-toolbar"
import { useRichTextSelector } from "@/components/blocks/rich-text-editor-2/components/rich-text-state"
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

import { findCount, findQuery, type FindOptions } from "./document-find"

/** What a ⌘F hands the bar: a new `token` refocuses its field, and `text`,
 *  when the selection was one line, becomes the query. */
export interface FindRequest {
  token: number
  text: string | null
}

export function DocumentFindBar({
  editor,
  request,
  onClose,
}: {
  editor: Editor
  request: FindRequest
  onClose: () => void
}) {
  const [options, setOptions] = useState<FindOptions>({
    search: request.text ?? "",
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    replace: "",
  })
  const [replacing, setReplacing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where the caret was when the bar opened: typing finds from here. */
  const anchor = useRef(editor.state.selection.from)

  const count = useRichTextSelector(editor, (current) =>
    current ? findCount(current.state) : { total: 0, current: null }
  )
  const query = findQuery(options)
  const editable = useRichTextSelector(
    editor,
    (current) => current?.isEditable ?? false
  )

  // Each ⌘F: the selection's line, if any, and the field to type in.
  useEffect(() => {
    anchor.current = editor.state.selection.from
    if (request.text !== null) {
      const text = request.text
      setOptions((current) => ({ ...current, search: text }))
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editor, request])

  // The query in force follows the bar; a new one selects its first match
  // from the anchor, wrapping, and scrolls to it.
  useEffect(() => {
    if (editor.isDestroyed) return
    const { state } = editor
    const next = findQuery(options)
    const tr = setSearchState(state.tr, next)
    if (next.valid) {
      const hit =
        next.findNext(state, anchor.current) ?? next.findNext(state, 0)
      if (hit) {
        tr.setSelection(
          TextSelection.create(state.doc, hit.from, hit.to)
        ).scrollIntoView()
      }
    }
    editor.view.dispatch(tr)
  }, [editor, options])

  // Closing clears the highlights.
  useEffect(
    () => () => {
      if (editor.isDestroyed) return
      editor.view.dispatch(
        setSearchState(editor.state.tr, findQuery({ ...EMPTY_OPTIONS }))
      )
    },
    [editor]
  )

  const run = (command: typeof findNext) =>
    command(editor.state, editor.view.dispatch)

  function close() {
    onClose()
    editor.commands.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (mod && !event.altKey && key === "f") {
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus()
      inputRef.current?.select()
    } else if (mod && !event.altKey && key === "g") {
      event.preventDefault()
      event.stopPropagation()
      run(event.shiftKey ? findPrev : findNext)
    }
  }

  function handleFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    run(event.shiftKey ? findPrev : findNext)
  }

  function handleReplaceKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    run(event.metaKey || event.ctrlKey ? replaceAll : replaceNext)
  }

  const invalid = options.regexp && options.search !== "" && !query.valid
  const status =
    options.search === ""
      ? ""
      : count.total === 0
        ? "No results"
        : count.current === null
          ? `${count.total} ${count.total === 1 ? "result" : "results"}`
          : `${count.current} of ${count.total}`
  const none = count.total === 0

  const set = (patch: Partial<FindOptions>) =>
    setOptions((current) => ({ ...current, ...patch }))

  return (
    <Card size="sm" className="p-1" onKeyDown={handleKeyDown}>
      <div role="search" aria-label="Find in document" className="flex gap-1">
        <BarButton
          label={replacing ? "Hide replace" : "Show replace"}
          onClick={() => setReplacing((open) => !open)}
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
                onChange={(event) => set({ search: event.target.value })}
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
                  onPressedChange={(caseSensitive) => set({ caseSensitive })}
                >
                  <CaseSensitiveIcon />
                </OptionToggle>
                <OptionToggle
                  label="Match whole word"
                  pressed={options.wholeWord}
                  onPressedChange={(wholeWord) => set({ wholeWord })}
                >
                  <WholeWordIcon />
                </OptionToggle>
                <OptionToggle
                  label="Use regular expression"
                  pressed={options.regexp}
                  onPressedChange={(regexp) => set({ regexp })}
                >
                  <RegexIcon />
                </OptionToggle>
              </InputGroupAddon>
            </InputGroup>
            <BarButton
              label="Previous match"
              shortcut={["shift", "mod", "G"]}
              disabled={none}
              onClick={() => run(findPrev)}
            >
              <ArrowUpIcon />
            </BarButton>
            <BarButton
              label="Next match"
              shortcut={["mod", "G"]}
              disabled={none}
              onClick={() => run(findNext)}
            >
              <ArrowDownIcon />
            </BarButton>
            <BarButton label="Close" shortcut={["Esc"]} onClick={close}>
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
                  onChange={(event) => set({ replace: event.target.value })}
                  onKeyDown={handleReplaceKeyDown}
                />
              </InputGroup>
              <BarButton
                label="Replace"
                shortcut={["⏎"]}
                disabled={none}
                onClick={() => run(replaceNext)}
              >
                <ReplaceIcon />
              </BarButton>
              <BarButton
                label="Replace all"
                shortcut={["mod", "⏎"]}
                disabled={none}
                onClick={() => run(replaceAll)}
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

const EMPTY_OPTIONS: FindOptions = {
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
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
