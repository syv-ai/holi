/**
 * VS Code-style per-type file icons for the tree — a recognizable glyph in a
 * type colour, so a `.json` reads yellow, a `.ts` blue, a `.typ` teal at a
 * glance. Real technology glyphs from simple-icons where one exists (Markdown,
 * JSON, JavaScript, TypeScript, Python, Typst, …), with lucide fallbacks for the
 * generic kinds (plain file, image, spreadsheet, archive).
 *
 * Colours are a curated, dark-friendly palette — NOT each brand's own hex, since
 * several (JSON is black, TOML brown) would vanish on the dark UI. The colour is
 * the type signal; it is passed to the glyph, distinct from the row's text tint.
 *
 * The mapping is by extension and independent of `fileKind` (which is coarser,
 * for choosing an editor). Unmapped extensions fall back to a neutral file.
 */
import type { ComponentType, JSX } from 'react'
import { Braces, File, FileArchive, FileSpreadsheet, FileText, Image, Presentation, Settings2, Table } from 'lucide-react'
import {
  SiCss,
  SiDotenv,
  SiGnubash,
  SiGo,
  SiGraphql,
  SiHtml5,
  SiJavascript,
  SiJupyter,
  SiLess,
  SiMarkdown,
  SiMdx,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiSqlite,
  SiToml,
  SiTypescript,
  SiTypst,
  SiXml,
  SiYaml,
} from '@icons-pack/react-simple-icons'

/** lucide `LucideIcon` and simple-icons `IconType` are both forwardRef exotic
 *  components; `ComponentType<any>` is the common slot that accepts either. The
 *  render below only ever passes `size` + `color`, which both honour. */
type IconCmp = ComponentType<any>

/** [glyph, colour] per extension. Colours are dark-friendly, loosely tracking
 *  each type's identity (JS yellow, TS/CSS blue, Rust orange, …). */
const BY_EXT: Record<string, [IconCmp, string]> = {
  md: [SiMarkdown, '#6b9fff'],
  markdown: [SiMarkdown, '#6b9fff'],
  mdx: [SiMdx, '#f9ac00'],
  json: [Braces, '#f5c542'],
  jsonc: [Braces, '#f5c542'],
  js: [SiJavascript, '#f5c542'],
  mjs: [SiJavascript, '#f5c542'],
  cjs: [SiJavascript, '#f5c542'],
  jsx: [SiReact, '#61dafb'],
  ts: [SiTypescript, '#4fc3f7'],
  tsx: [SiReact, '#61dafb'],
  py: [SiPython, '#4fc3f7'],
  ipynb: [SiJupyter, '#ff8a65'],
  go: [SiGo, '#29b6f6'],
  rb: [SiRuby, '#ef5350'],
  rs: [SiRust, '#ff8a65'],
  sh: [SiGnubash, '#a5d6a7'],
  bash: [SiGnubash, '#a5d6a7'],
  sql: [SiSqlite, '#b388ff'],
  graphql: [SiGraphql, '#e535ab'],
  gql: [SiGraphql, '#e535ab'],
  html: [SiHtml5, '#ff7043'],
  htm: [SiHtml5, '#ff7043'],
  css: [SiCss, '#42a5f5'],
  scss: [SiSass, '#e57399'],
  sass: [SiSass, '#e57399'],
  less: [SiLess, '#42a5f5'],
  yaml: [SiYaml, '#b388ff'],
  yml: [SiYaml, '#b388ff'],
  toml: [SiToml, '#b388ff'],
  env: [SiDotenv, '#f5c542'],
  xml: [SiXml, '#8bc34a'],
  typ: [SiTypst, '#26c6da'],
  ini: [Settings2, '#b388ff'],
  conf: [Settings2, '#b388ff'],
  csv: [Table, '#66bb6a'],
  tsv: [Table, '#66bb6a'],
  xls: [FileSpreadsheet, '#66bb6a'],
  xlsx: [FileSpreadsheet, '#66bb6a'],
  ods: [FileSpreadsheet, '#66bb6a'],
  doc: [FileText, '#4a90d9'],
  docx: [FileText, '#4a90d9'],
  odt: [FileText, '#4a90d9'],
  rtf: [FileText, '#4a90d9'],
  pages: [FileText, '#4a90d9'],
  ppt: [Presentation, '#ff7043'],
  pptx: [Presentation, '#ff7043'],
  key: [Presentation, '#ff7043'],
  pdf: [FileText, '#ef5350'],
  png: [Image, '#26a69a'],
  jpg: [Image, '#26a69a'],
  jpeg: [Image, '#26a69a'],
  gif: [Image, '#26a69a'],
  webp: [Image, '#26a69a'],
  bmp: [Image, '#26a69a'],
  ico: [Image, '#26a69a'],
  avif: [Image, '#26a69a'],
  svg: [Image, '#ffb74d'],
  txt: [File, '#b0bec5'],
  log: [File, '#b0bec5'],
  zip: [FileArchive, '#cfa06a'],
  tar: [FileArchive, '#cfa06a'],
  gz: [FileArchive, '#cfa06a'],
}

/**
 * The leaf icon for a vault file path.
 *
 * An icon from `.holi/icons.json` wins outright: the whole point of the feature
 * is to override the type glyph, so the two never appear together. `icon` is
 * already validated to be exactly one emoji when the map is resolved — nothing
 * longer can reach here and stretch the row.
 */
export function fileIconFor(path: string, icon?: string): JSX.Element {
  // `text-sm` is 14px — the same size the glyphs are rendered at. Measured
  // against them in the running app: 13px reads thin next to the filled `.md`
  // badge, and 15px+ crowds the row. `leading-none` is what centres it, since
  // the default line box is taller than the slot.
  if (icon) return <span className="text-sm leading-none">{icon}</span>

  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  const [Icon, color] = BY_EXT[ext] ?? [File, '#90a4ae']
  return <Icon size={14} color={color} />
}
