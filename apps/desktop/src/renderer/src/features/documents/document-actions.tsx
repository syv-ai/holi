/**
 * The document's menu, after the rich-text block's page actions: the page's
 * layout (full width, small text), a Holi link to the document
 * (docs/features/holi-links.md) and Copy as Markdown or HTML, then Create
 * vault app. Copy Holi link and Create vault app are the actions a note's row
 * menu in the file tree has too, drawn from one definition (`NOTE_ACTIONS`).
 * Narrow panes offer the heading-link action here because the block gutter is
 * not laid out there; wider panes keep it beside the heading.
 * A copy confirms in place on its item; only a failure toasts.
 */
import type { Editor } from '@tiptap/react'
import {
  ArrowLeftRightIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  FileTextIcon,
  HashIcon,
  MoreHorizontalIcon,
  TypeIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NOTE_ACTIONS } from '@/state/document-runs'
import { useRichTextSelector } from './rich-text/rich-text-state'

import { useCopied } from './use-copied'

const { copyLink: COPY_LINK, createVaultApp: CREATE_VAULT_APP } = NOTE_ACTIONS

type CopyFormat = 'markdown' | 'html' | 'link' | 'heading-link'

export interface DocumentActionsProps {
  editor: Editor | null
  /** The file as it is saved: Copy as Markdown copies this, frontmatter and all. */
  markdown: () => string
  fullWidth: boolean
  smallText: boolean
  onFullWidthChange: (fullWidth: boolean) => void
  onSmallTextChange: (smallText: boolean) => void
  /** Null while an agent run is already going, there is no agent, this
   *  machine's agent is not yet known, or the note cannot have an app. */
  onCreateVaultApp: (() => void) | null
  /** The document's Holi link; null for a file a teammate could not open
   *  (a local file). */
  holiLink?: (() => string) | null
  /** The current heading's Holi link; null for an unlinkable document. */
  headingLink?: (() => string | null) | null
  compact?: boolean
}

export function DocumentActions({
  editor,
  markdown,
  fullWidth,
  smallText,
  onFullWidthChange,
  onSmallTextChange,
  onCreateVaultApp,
  holiLink = null,
  headingLink = null,
  compact = false,
}: DocumentActionsProps) {
  const { copied, copy } = useCopied<CopyFormat>()
  const currentHeadingLink = useRichTextSelector(editor, (current) =>
    current && headingLink ? headingLink() : null,
  )

  function copyAs(format: CopyFormat) {
    if (!editor) return
    const value =
      format === 'html' ? editor.getHTML() : format === 'link' ? holiLink?.() : markdown()
    void copy(format, value)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Document actions">
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuCheckboxItem
            checked={fullWidth}
            onCheckedChange={onFullWidthChange}
            onSelect={(event) => event.preventDefault()}
          >
            <ArrowLeftRightIcon aria-hidden="true" />
            Full width
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={smallText}
            onCheckedChange={onSmallTextChange}
            onSelect={(event) => event.preventDefault()}
          >
            <TypeIcon aria-hidden="true" />
            Small text
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {headingLink && compact ? (
            <DropdownMenuItem
              onSelect={(event) => event.preventDefault()}
              disabled={!editor || !currentHeadingLink}
              onClick={() => void copy('heading-link', currentHeadingLink)}
            >
              {copied === 'heading-link' ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <HashIcon aria-hidden="true" />
              )}
              {copied === 'heading-link' ? 'Copied' : 'Copy link to heading'}
            </DropdownMenuItem>
          ) : null}
          {holiLink ? (
            // Stays open, so the swap to Copied is seen where it was clicked.
            <DropdownMenuItem
              onSelect={(event) => event.preventDefault()}
              disabled={!editor}
              onClick={() => copyAs('link')}
            >
              {copied === 'link' ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <COPY_LINK.icon aria-hidden="true" />
              )}
              {copied === 'link' ? 'Copied' : COPY_LINK.label}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!editor}>
              <CopyIcon aria-hidden="true" />
              Copy as
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                onClick={() => copyAs('markdown')}
              >
                {copied === 'markdown' ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <FileTextIcon aria-hidden="true" />
                )}
                {copied === 'markdown' ? 'Copied' : 'Markdown'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => event.preventDefault()}
                onClick={() => copyAs('html')}
              >
                {copied === 'html' ? (
                  <CheckIcon aria-hidden="true" />
                ) : (
                  <CodeIcon aria-hidden="true" />
                )}
                {copied === 'html' ? 'Copied' : 'HTML'}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={onCreateVaultApp === null} onClick={() => onCreateVaultApp?.()}>
          <CREATE_VAULT_APP.icon aria-hidden="true" />
          {CREATE_VAULT_APP.label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
