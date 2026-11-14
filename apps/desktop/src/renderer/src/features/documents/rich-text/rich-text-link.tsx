import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { editorActivity, useEditorActivity } from '@/hooks/use-editor-activity'
import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'

import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Field, FieldError } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RichTextSnapshot } from './rich-text-state'
import { ShortcutKeys } from '@/composites/shortcut-keys'
import { keepEditorFocus } from './rich-text-toolbar'
import { setRichTextBubble } from './rich-text-bubble-bar'
import { LinkIcon, CheckIcon, Link2OffIcon, ExternalLinkIcon, PencilIcon } from 'lucide-react'

const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/

/** A typed address as an href, or null when it is not a web, mail or phone link. */
function normalizeHref(value: string) {
  const href = value.trim()

  if (/^(https?:\/\/|mailto:|tel:)\S+$/i.test(href)) return href
  if (BARE_DOMAIN.test(href)) return `https://${href}`
  return null
}

function removeLink(editor: Editor | null) {
  editor?.chain().focus().extendMarkRange('link').unsetLink().run()
}

interface LinkFormProps {
  editor: Editor | null
  href: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onDone: () => void
  draft: string
  setDraft: (draft: string) => void
}

function LinkForm({ editor, href, inputRef, onDone, draft, setDraft }: LinkFormProps) {
  const activity = useEditorActivity(editor)
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  function apply() {
    // Enter on an empty field is a no-op, not an error.
    if (!activity.focused || !draft.trim()) return

    const next = normalizeHref(draft)

    if (!editor || !next) {
      setInvalid(true)
      return
    }

    const { empty } = editor.state.selection

    // With nothing selected, the address becomes the link text itself.
    if (empty && !editor.isActive('link')) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: draft.trim(),
          marks: [{ type: 'link', attrs: { href: next } }],
        })
        .run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: next }).run()
    }

    onDone()
  }

  return (
    <div>
      <Field data-invalid={invalid || undefined}>
        <InputGroup>
          <InputGroupAddon>
            <LinkIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={draft}
            placeholder="Paste or type a link"
            aria-label="Link address"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                apply()
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            {/* Announced disabled, never natively disabled: a native one
              dims the whole field with it. */}
            <InputGroupButton
              size="icon-xs"
              aria-label="Apply link"
              aria-disabled={!draft.trim()}
              onClick={apply}
            >
              <CheckIcon aria-hidden="true" />
            </InputGroupButton>
            {href ? (
              <InputGroupButton
                size="icon-xs"
                aria-label="Remove link"
                onClick={() => {
                  removeLink(editor)
                  onDone()
                }}
              >
                <Link2OffIcon aria-hidden="true" />
              </InputGroupButton>
            ) : null}
          </InputGroupAddon>
        </InputGroup>
        {invalid ? (
          <FieldError id={errorId}>Enter a web address, like example.com</FieldError>
        ) : null}
      </Field>
    </div>
  )
}

interface RichTextLinkPopoverProps {
  editor: Editor | null
  state: RichTextSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RichTextLinkPopover({
  editor,
  state,
  open,
  onOpenChange,
}: RichTextLinkPopoverProps) {
  const activity = useEditorActivity(editor)
  const [draft, setDraft] = useState(state.link ?? '')
  const [draftTarget, setDraftTarget] = useState('')
  const target = editor
    ? `${editor.state.selection.from}:${editor.state.selection.to}:${state.link ?? ''}`
    : ''
  // Suspension keeps this target's draft; a different passage starts from its own link.
  if (open && target !== draftTarget) {
    setDraftTarget(target)
    setDraft(state.link ?? '')
  }
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger asChild>
          <span className="flex">
            <PopoverTrigger asChild>
              <Toggle
                size="icon"
                aria-label="Link"
                pressed={state.link !== null}
                disabled={!state.canFormat}
                onMouseDown={keepEditorFocus}
                data-toolbar-item=""
              >
                <LinkIcon aria-hidden="true" />
              </Toggle>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Link
          <ShortcutKeys keys={['mod', 'K']} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (activity.focused) inputRef.current?.focus()
        }}
        align="start"
        aria-label="Link"
        className="w-80"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (activity.focused) editor?.view.focus()
        }}
      >
        {/* The field may unmount; its draft belongs to this passage, not the portal. */}
        <LinkForm
          editor={editor}
          href={state.link}
          draft={draft}
          setDraft={setDraft}
          inputRef={inputRef}
          onDone={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

const BUBBLE_OPTIONS = { placement: 'bottom-start', offset: 6 } as const

function showAtLink({ editor, element }: { editor: Editor; element: HTMLElement }) {
  return (
    editorActivity(editor).focused &&
    editor.isEditable &&
    editor.isActive('link') &&
    (editor.view.hasFocus() || element.contains(document.activeElement))
  )
}

interface RichTextLinkBubbleProps {
  editor: Editor
  onEdit: () => void
}

/** Surfaces the address under the caret, which the text alone never shows. */
export function RichTextLinkBubble({ editor, onEdit }: RichTextLinkBubbleProps) {
  const activity = useEditorActivity(editor)
  useEffect(() => {
    if (!activity.focused && !editor.isDestroyed)
      setRichTextBubble(editor, 'richTextLinkBubble', 'hide')
  }, [activity, activity.focused, editor])
  const href = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current.isActive('link')
        ? ((current.getAttributes('link').href as string | undefined) ?? null)
        : null,
  })
  // Stored JSON skips Link's own check, so only a vetted address goes live.
  const safeHref = href ? normalizeHref(href) : null

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="richTextLinkBubble"
      shouldShow={showAtLink}
      options={BUBBLE_OPTIONS}
      className="z-50"
    >
      {/* One outline group: the address, then its two actions. */}
      <ButtonGroup aria-label="Link">
        {safeHref ? (
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground max-w-64 min-w-0 font-normal"
            asChild
          >
            <a href={safeHref} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon aria-hidden="true" />
              <span className="truncate">{safeHref.replace(/^https?:\/\//, '')}</span>
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Edit link" onClick={onEdit}>
              <PencilIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit link</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Remove link"
              onClick={() => removeLink(editor)}
            >
              <Link2OffIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove link</TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </BubbleMenu>
  )
}
