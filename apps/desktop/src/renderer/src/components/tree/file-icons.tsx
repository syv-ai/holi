/**
 * VS Code-style per-type file icons for the tree — a recognizable glyph in a
 * type colour, so a `.json` reads yellow, a `.ts` blue, an image teal, at a
 * glance. Still inline SVG (no icon-font dependency), but colour-carrying rather
 * than monochrome: the type is the signal, distinct from the row's
 * selection/open tint (which colours the text, not these).
 *
 * The mapping is by extension and independent of `fileKind` (which is coarser,
 * for choosing an editor). Unmapped extensions fall back to a neutral file.
 */
import type { JSX } from 'react'
import {
  BracesIcon,
  CodeIcon,
  ConfigIcon,
  DocIcon,
  FileIcon,
  ImageIcon,
  MarkdownIcon,
  PdfIcon,
  TableIcon,
} from './icons'

type Glyph = () => JSX.Element

/** [glyph, colour] per extension. Colours track VS Code's Seti palette loosely. */
const BY_EXT: Record<string, [Glyph, string]> = {
  md: [MarkdownIcon, '#6b9fff'],
  markdown: [MarkdownIcon, '#6b9fff'],
  json: [BracesIcon, '#f5c542'],
  jsonc: [BracesIcon, '#f5c542'],
  js: [CodeIcon, '#f5c542'],
  jsx: [CodeIcon, '#f5c542'],
  mjs: [CodeIcon, '#f5c542'],
  cjs: [CodeIcon, '#f5c542'],
  ts: [CodeIcon, '#4fc3f7'],
  tsx: [CodeIcon, '#4fc3f7'],
  py: [CodeIcon, '#4fc3f7'],
  go: [CodeIcon, '#4fc3f7'],
  rb: [CodeIcon, '#ef5350'],
  rs: [CodeIcon, '#ff8a65'],
  sh: [CodeIcon, '#a5d6a7'],
  bash: [CodeIcon, '#a5d6a7'],
  sql: [CodeIcon, '#b388ff'],
  html: [CodeIcon, '#ff7043'],
  htm: [CodeIcon, '#ff7043'],
  css: [CodeIcon, '#42a5f5'],
  scss: [CodeIcon, '#42a5f5'],
  less: [CodeIcon, '#42a5f5'],
  yaml: [ConfigIcon, '#b388ff'],
  yml: [ConfigIcon, '#b388ff'],
  toml: [ConfigIcon, '#b388ff'],
  ini: [ConfigIcon, '#b388ff'],
  env: [ConfigIcon, '#b388ff'],
  conf: [ConfigIcon, '#b388ff'],
  xml: [ConfigIcon, '#b388ff'],
  csv: [TableIcon, '#66bb6a'],
  tsv: [TableIcon, '#66bb6a'],
  xls: [TableIcon, '#66bb6a'],
  xlsx: [TableIcon, '#66bb6a'],
  ods: [TableIcon, '#66bb6a'],
  doc: [DocIcon, '#4a90d9'],
  docx: [DocIcon, '#4a90d9'],
  odt: [DocIcon, '#4a90d9'],
  rtf: [DocIcon, '#4a90d9'],
  pages: [DocIcon, '#4a90d9'],
  ppt: [DocIcon, '#ff7043'],
  pptx: [DocIcon, '#ff7043'],
  key: [DocIcon, '#ff7043'],
  pdf: [PdfIcon, '#ef5350'],
  png: [ImageIcon, '#26a69a'],
  jpg: [ImageIcon, '#26a69a'],
  jpeg: [ImageIcon, '#26a69a'],
  gif: [ImageIcon, '#26a69a'],
  webp: [ImageIcon, '#26a69a'],
  bmp: [ImageIcon, '#26a69a'],
  ico: [ImageIcon, '#26a69a'],
  avif: [ImageIcon, '#26a69a'],
  svg: [ImageIcon, '#ffb74d'],
  txt: [FileIcon, '#b0bec5'],
  log: [FileIcon, '#b0bec5'],
  zip: [FileIcon, '#cfa06a'],
  tar: [FileIcon, '#cfa06a'],
  gz: [FileIcon, '#cfa06a'],
}

/** The tinted, type-appropriate leaf icon for a vault file path. */
export function fileIconFor(path: string): JSX.Element {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  const [Glyph, color] = BY_EXT[ext] ?? [FileIcon, '#90a4ae']
  return (
    <span style={{ color }}>
      <Glyph />
    </span>
  )
}
