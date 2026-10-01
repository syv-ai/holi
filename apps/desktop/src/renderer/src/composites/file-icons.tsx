/**
 * VS Code-style per-type file icons for the tree — a recognizable glyph in a
 * type colour, so a `.json` reads yellow, a `.ts` blue, a `.typ` teal at a
 * glance. Real technology glyphs from simple-icons where one exists (Markdown,
 * JSON, JavaScript, TypeScript, Python, Typst, …), with lucide fallbacks for the
 * generic kinds (plain file, image, spreadsheet, archive).
 *
 * Every glyph draws through `<Icon size="sm">` in `currentColor`. The type
 * colour is a `text-file-*` token class; the hues themselves are the
 * `--file-*` tokens in `index.css`, a curated dark-friendly palette. The colour
 * is the type signal, distinct from the row's text tint.
 *
 * The mapping is by extension and independent of `fileKind` (which is coarser,
 * for choosing an editor). Unmapped extensions fall back to a neutral file.
 */
import type { JSX } from 'react'
import { fileKind, type TaskStatus } from '@holi/shared'
import {
  Braces,
  Circle,
  CircleCheck,
  CircleDot,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Image,
  Presentation,
  Settings2,
  Table,
} from 'lucide-react'
import {
  SiCss,
  SiDotenv,
  SiGit,
  SiGnubash,
  SiGo,
  SiGraphql,
  SiHtml5,
  SiJavascript,
  SiJupyter,
  SiLess,
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
import { Icon, type IconGlyph } from '@/primitives'

/** A page with the Acrobat curl cut out of it, from svgrepo.com (#501303).
 *  Not in simple-icons; filled with `currentColor`, sized by `<Icon>`. */
function PdfIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1920 1920" fill="currentColor" aria-hidden="true">
      <g fillRule="evenodd">
        <path d="M368.99 0H1085.46Q1185.46 0 1185.46 100V414.74Q1185.46 564.74 1335.46 564.74H1550.165Q1750.165 564.74 1750.165 764.74V1720Q1750.165 1920 1550.165 1920H368.99Q168.99 1920 168.99 1720V200Q168.99 0 368.99 0ZM900.508 677.68c-16.829 0-31.963 7.567-42.918 21.007-49.807 59.972-31.398 193.016-18.748 272.075 2.823 17.958.452 36.141-7.228 52.518l-107.86 233.223c-7.905 16.942-20.555 30.608-36.592 39.53-68.104 37.835-182.287 89.675-196.066 182.626-4.97 30.268 5.082 56.357 28.574 79.85 15.925 15.133 35.238 22.7 56.245 22.7 81.43 0 132.819-71.717 188.273-148.517 24.62-34.221 61.666-55.229 102.437-60.876 76.349-10.503 167.83-32.527 223.172-46.983 27.897-7.341 56.358-5.534 83.802 3.162 48.565 15.586 66.975 25.073 122.768 25.073 50.371 0 84.818-11.746 101.534-34.447 13.44-16.828 16.715-39.53 10.164-65.619-11.858-42.804-2.033-89.675-133.044-89.675-29.365 0-57.94 2.824-81.77 6.099-36.819 4.97-73.299-10.955-97.016-40.885-32.301-40.546-65.167-88.433-87.981-123.219-16.151-24.508-21.572-53.986-16.264-83.124 15.473-84.706 18.41-147.615-23.492-206.683-17.619-25.186-41.223-37.835-67.99-37.835ZM1298.4 116.9Q1298.4 16.9 1369.1 87.6L1662.6 381.1Q1733.3 451.8 1633.3 451.8H1398.4Q1298.4 451.8 1298.4 351.8Z" />
        <path d="M791.057 1297.943c92.273-43.37 275.916-65.28 275.916-65.28-92.386-88.998-145.92-215.04-145.92-215.04-43.257 126.607-119.718 264.282-129.996 280.32" />
      </g>
    </svg>
  )
}

/** [glyph, colour class] by whole file name, for the dotfiles an extension lookup
 *  cannot reach (`.gitignore` has no extension: its only dot leads the name).
 *  Git reads red, as its own mark does. */
const BY_NAME: Record<string, [IconGlyph, string]> = {
  '.gitignore': [SiGit, 'text-file-red'],
  '.gitattributes': [SiGit, 'text-file-red'],
  '.gitmodules': [SiGit, 'text-file-red'],
}

/** [glyph, colour class] per extension. Colours are dark-friendly, loosely tracking
 *  each type's identity (JS yellow, TS/CSS blue, Rust orange, …). */
const BY_EXT: Record<string, [IconGlyph, string]> = {
  // `FileText`, not simple-icons' wide "M↓" mark, which is nearly twice the
  // width of the square glyphs beside it. Also the `@`-mention list's glyph.
  md: [FileText, 'text-file-blue'],
  markdown: [FileText, 'text-file-blue'],
  mdx: [SiMdx, 'text-file-yellow'],
  json: [Braces, 'text-file-yellow'],
  jsonc: [Braces, 'text-file-yellow'],
  js: [SiJavascript, 'text-file-yellow'],
  mjs: [SiJavascript, 'text-file-yellow'],
  cjs: [SiJavascript, 'text-file-yellow'],
  jsx: [SiReact, 'text-file-sky'],
  ts: [SiTypescript, 'text-file-sky'],
  tsx: [SiReact, 'text-file-sky'],
  py: [SiPython, 'text-file-sky'],
  ipynb: [SiJupyter, 'text-file-orange'],
  go: [SiGo, 'text-file-sky'],
  rb: [SiRuby, 'text-file-red'],
  rs: [SiRust, 'text-file-orange'],
  sh: [SiGnubash, 'text-file-green'],
  bash: [SiGnubash, 'text-file-green'],
  sql: [SiSqlite, 'text-file-purple'],
  graphql: [SiGraphql, 'text-file-pink'],
  gql: [SiGraphql, 'text-file-pink'],
  html: [SiHtml5, 'text-file-orange'],
  htm: [SiHtml5, 'text-file-orange'],
  css: [SiCss, 'text-file-blue'],
  scss: [SiSass, 'text-file-pink'],
  sass: [SiSass, 'text-file-pink'],
  less: [SiLess, 'text-file-blue'],
  yaml: [SiYaml, 'text-file-purple'],
  yml: [SiYaml, 'text-file-purple'],
  toml: [SiToml, 'text-file-purple'],
  env: [SiDotenv, 'text-file-yellow'],
  xml: [SiXml, 'text-file-green'],
  typ: [SiTypst, 'text-file-teal'],
  ini: [Settings2, 'text-file-purple'],
  conf: [Settings2, 'text-file-purple'],
  csv: [Table, 'text-file-green'],
  tsv: [Table, 'text-file-green'],
  xls: [FileSpreadsheet, 'text-file-green'],
  xlsx: [FileSpreadsheet, 'text-file-green'],
  ods: [FileSpreadsheet, 'text-file-green'],
  doc: [FileText, 'text-file-blue'],
  docx: [FileText, 'text-file-blue'],
  odt: [FileText, 'text-file-blue'],
  rtf: [FileText, 'text-file-blue'],
  pages: [FileText, 'text-file-blue'],
  ppt: [Presentation, 'text-file-orange'],
  pptx: [Presentation, 'text-file-orange'],
  key: [Presentation, 'text-file-orange'],
  pdf: [PdfIcon, 'text-file-red'],
  png: [Image, 'text-file-teal'],
  jpg: [Image, 'text-file-teal'],
  jpeg: [Image, 'text-file-teal'],
  gif: [Image, 'text-file-teal'],
  webp: [Image, 'text-file-teal'],
  bmp: [Image, 'text-file-teal'],
  ico: [Image, 'text-file-teal'],
  avif: [Image, 'text-file-teal'],
  svg: [Image, 'text-file-orange'],
  txt: [File, 'text-file-grey'],
  log: [File, 'text-file-grey'],
  zip: [FileArchive, 'text-file-tan'],
  tar: [FileArchive, 'text-file-tan'],
  gz: [FileArchive, 'text-file-tan'],
}

/**
 * The leaf icon for a vault file path. An icon from `.holi/settings/icons.yaml`
 * replaces the type glyph; it is validated to be exactly one emoji upstream.
 */
export function fileIconFor(path: string, icon?: string): JSX.Element {
  // `text-sm` (14px) matches the glyphs. `leading-none` centres it: the default
  // line box is taller than the slot.
  if (icon) return <span className="text-sm leading-none">{icon}</span>

  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  const [glyph, colour] = BY_NAME[base] ?? BY_EXT[ext] ?? [File, 'text-file-grey']
  return <Icon icon={glyph} size="sm" className={colour} />
}

/** A task file's glyph, keyed to its status: an empty circle for todo, a
 *  dotted one for doing, a checked one for done.
 *
 *  **The colours are the `--task-*` tokens, not hex**, the same ones the
 *  editor's task orbs use, so a vault theme recolours both at once. */
export function TaskIcon({ status }: { status: TaskStatus }) {
  if (status === 'done') return <Icon icon={CircleCheck} size="sm" className="text-task-done" />
  if (status === 'doing') return <Icon icon={CircleDot} size="sm" className="text-task-doing" />
  return <Icon icon={Circle} size="sm" className="text-task-todo" />
}

/**
 * What a file is called wherever it is listed: the tree and the tabs
 * (`docs/features/file-tree.md`). A note is the unmarked thing and drops its
 * `.md`; anything else keeps its extension. A folder document (an app) is
 * named by its claim instead.
 */
export function pathLabel(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return fileKind(path) === 'markdown' ? base.replace(/\.md$/i, '') : base
}

/**
 * What a file leads with, by the same rule: the vault icon map's emoji first,
 * then a task's status, nothing for a note, and the type glyph for anything
 * else. `null` is a note's empty slot.
 */
export function pathGlyph(
  path: string,
  { emoji, task }: { emoji?: string; task?: TaskStatus } = {},
): JSX.Element | null {
  if (emoji) return fileIconFor(path, emoji)
  if (task) return <TaskIcon status={task} />
  if (fileKind(path) === 'markdown') return null
  return fileIconFor(path)
}
