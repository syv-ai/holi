/**
 * What a document's editor runs: the rich-text block's preset and table,
 * plus what a vault's markdown needs and the block lacks: wiki-links, images
 * that load from the vault, raw HTML kept verbatim, and the markdown codec.
 *
 * Text alignment is left out: markdown has no way to say it, so it would look
 * applied and vanish on the next open.
 */
import Image from "@tiptap/extension-image"
import { mergeAttributes, Node } from "@tiptap/react"

import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-2/components/rich-text-extensions"
import { vaultAssetUrl } from "@/lib/vault-asset"

import { AgentTrigger } from "./agent-trigger"
import { DocumentFind } from "./document-find"
import { AGENT_MARKER, DocumentMarkdown } from "./markdown"
import { MultiCursor } from "./multi-cursor"
import { WikiLink } from "./wiki-link"

/** `src` as written in the file, resolved against the document's folder for
 *  display only: the markdown keeps the path it had. */
function displaySrc(src: string, folder: string): string {
  if (/^(https?:|data:|holi-vault:)/.test(src)) return src
  const parts = (src.startsWith("/") ? src.slice(1) : `${folder}/${src}`)
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  const resolved: string[] = []
  for (const part of parts) {
    if (part === "..") resolved.pop()
    else resolved.push(decodeURI(part))
  }
  return vaultAssetUrl(resolved.join("/"))
}

const DocumentImage = Image.extend<{ folder: string }>({
  addOptions() {
    return { ...this.parent!(), folder: "" }
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src: displaySrc(String(HTMLAttributes.src ?? ""), this.options.folder),
        class: "max-w-full rounded-md",
      }),
    ]
  },
})

/** A block of raw HTML from the file, shown as its source and written back
 *  unchanged. */
export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  markdownTokenName: "html",
  addAttributes() {
    return { html: { default: "" } }
  },
  parseHTML() {
    return [{ tag: "pre[data-html-block]" }]
  },
  renderHTML({ node }) {
    // The agent's marker shows as where it is writing, not as a comment: a
    // live dot and a label over lines in the shape of the text to come,
    // framed as the region the agent will replace. Plain DOM, since the
    // editor draws it; the lines are `Skeleton`'s look. Its motion is
    // opacity and a small ping, both still under reduced motion, and the
    // selection ring the caret leaves on it after sending stays off.
    if (String(node.attrs.html).trim() === AGENT_MARKER) {
      const line = (width: string) => [
        "div",
        { class: `bg-primary/15 h-2.5 rounded-full ${width}` },
      ]
      return [
        "div",
        {
          "data-html-block": "",
          "data-agent-marker": "",
          role: "status",
          "aria-label": "Sonnet is writing here",
          class:
            "not-prose border-primary/30 bg-primary/5 my-3 flex flex-col gap-3 rounded-lg border border-dashed px-4 py-3 [&.ProseMirror-selectednode]:outline-none",
        },
        [
          "div",
          {
            class: "text-primary flex items-center gap-2 text-sm font-medium",
            "aria-hidden": "true",
          },
          [
            "span",
            { class: "relative flex size-2 shrink-0" },
            [
              "span",
              {
                class:
                  "bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none",
              },
            ],
            [
              "span",
              { class: "bg-primary relative inline-flex size-2 rounded-full" },
            ],
          ],
          ["span", {}, "Sonnet is writing here…"],
        ],
        [
          "div",
          {
            class:
              "flex animate-pulse flex-col gap-2 motion-reduce:animate-none",
            "aria-hidden": "true",
          },
          line("w-11/12"),
          line("w-4/5"),
          line("w-3/5"),
        ],
      ]
    }
    return [
      "pre",
      {
        "data-html-block": "",
        class:
          "text-muted-foreground bg-muted rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap",
      },
      node.attrs.html,
    ]
  },
  parseMarkdown(token) {
    // Inline HTML (a `<br>` in a sentence) stays text; only a block is a node.
    if (!token.block) return { type: "text", text: token.raw ?? "" }
    return { type: "htmlBlock", attrs: { html: (token.raw ?? "").trimEnd() } }
  },
  renderMarkdown(node) {
    return node.attrs?.html ?? ""
  },
})

export function createDocumentExtensions({
  folder,
  placeholder,
  onOpenLink,
  onAgentTrigger,
  promptContainer = null,
}: {
  /** The document's folder, vault-relative: relative images resolve here. */
  folder: string
  placeholder: string
  onOpenLink: (target: string) => void
  /** Space on an empty line: open the agent prompt at `pos`. */
  onAgentTrigger?: (pos: number) => void
  /** Where the view renders the agent prompt, placed on its line. */
  promptContainer?: HTMLElement | null
}) {
  return [
    ...createRichTextExtensions({ placeholder }).filter(
      (extension) => extension.name !== "textAlign"
    ),
    WikiLink.configure({ onOpen: onOpenLink }),
    DocumentImage.configure({ folder }),
    HtmlBlock,
    AgentTrigger.configure({
      onTrigger: onAgentTrigger ?? (() => undefined),
      container: promptContainer,
    }),
    DocumentMarkdown,
    // ⌘F's find bar highlights through this; ⌘D adds the next occurrence.
    DocumentFind,
    MultiCursor,
  ]
}
