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
import {
  Braces,
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

/** lucide `LucideIcon` and simple-icons `IconType` are both forwardRef exotic
 *  components; `ComponentType<any>` is the common slot that accepts either. The
 *  render below only ever passes `size` + `color`, which both honour. */
type IconCmp = ComponentType<any>

/** A page with the Acrobat curl cut out of it, from svgrepo.com (#501303).
 *  Not in simple-icons; `size` and `color` as the library glyphs take them. */
function PdfIcon({ size = 14, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1920 1920" fill={color} aria-hidden="true">
      <g fillRule="evenodd">
        <path d="M1185.46.034V564.74h564.705v1355.294H168.99V.034h1016.47ZM900.508 677.68c-16.829 0-31.963 7.567-42.918 21.007-49.807 59.972-31.398 193.016-18.748 272.075 2.823 17.958.452 36.141-7.228 52.518l-107.86 233.223c-7.905 16.942-20.555 30.608-36.592 39.53-68.104 37.835-182.287 89.675-196.066 182.626-4.97 30.268 5.082 56.357 28.574 79.85 15.925 15.133 35.238 22.7 56.245 22.7 81.43 0 132.819-71.717 188.273-148.517 24.62-34.221 61.666-55.229 102.437-60.876 76.349-10.503 167.83-32.527 223.172-46.983 27.897-7.341 56.358-5.534 83.802 3.162 48.565 15.586 66.975 25.073 122.768 25.073 50.371 0 84.818-11.746 101.534-34.447 13.44-16.828 16.715-39.53 10.164-65.619-11.858-42.804-2.033-89.675-133.044-89.675-29.365 0-57.94 2.824-81.77 6.099-36.819 4.97-73.299-10.955-97.016-40.885-32.301-40.546-65.167-88.433-87.981-123.219-16.151-24.508-21.572-53.986-16.264-83.124 15.473-84.706 18.41-147.615-23.492-206.683-17.619-25.186-41.223-37.835-67.99-37.835Zm397.903-660.808 434.936 434.937h-434.936V16.873Z" />
        <path d="M791.057 1297.943c92.273-43.37 275.916-65.28 275.916-65.28-92.386-88.998-145.92-215.04-145.92-215.04-43.257 126.607-119.718 264.282-129.996 280.32" />
      </g>
    </svg>
  )
}

/** [glyph, colour] by whole file name, for the dotfiles an extension lookup
 *  cannot reach (`.gitignore` has no extension: its only dot leads the name).
 *  Git red is the Git mark's own. */
const BY_NAME: Record<string, [IconCmp, string]> = {
  '.gitignore': [SiGit, '#de4c36'],
  '.gitattributes': [SiGit, '#de4c36'],
  '.gitmodules': [SiGit, '#de4c36'],
}

/** [glyph, colour] per extension. Colours are dark-friendly, loosely tracking
 *  each type's identity (JS yellow, TS/CSS blue, Rust orange, …). */
const BY_EXT: Record<string, [IconCmp, string]> = {
  // `FileText`, not simple-icons' wide "M↓" mark, which is nearly twice the
  // width of the square glyphs beside it. Also the `@`-mention list's glyph.
  md: [FileText, '#6b9fff'],
  markdown: [FileText, '#6b9fff'],
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
  pdf: [PdfIcon, '#ef5350'],
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
  const [Icon, color] = BY_NAME[base] ?? BY_EXT[ext] ?? [File, '#90a4ae']
  return <Icon size={14} color={color} />
}
