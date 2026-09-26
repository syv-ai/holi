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
import { appName, fileKind, isAppBundlePath, type TaskStatus } from '@holi/shared'
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
        <path d="M368.99 0H1085.46Q1185.46 0 1185.46 100V414.74Q1185.46 564.74 1335.46 564.74H1550.165Q1750.165 564.74 1750.165 764.74V1720Q1750.165 1920 1550.165 1920H368.99Q168.99 1920 168.99 1720V200Q168.99 0 368.99 0ZM900.508 677.68c-16.829 0-31.963 7.567-42.918 21.007-49.807 59.972-31.398 193.016-18.748 272.075 2.823 17.958.452 36.141-7.228 52.518l-107.86 233.223c-7.905 16.942-20.555 30.608-36.592 39.53-68.104 37.835-182.287 89.675-196.066 182.626-4.97 30.268 5.082 56.357 28.574 79.85 15.925 15.133 35.238 22.7 56.245 22.7 81.43 0 132.819-71.717 188.273-148.517 24.62-34.221 61.666-55.229 102.437-60.876 76.349-10.503 167.83-32.527 223.172-46.983 27.897-7.341 56.358-5.534 83.802 3.162 48.565 15.586 66.975 25.073 122.768 25.073 50.371 0 84.818-11.746 101.534-34.447 13.44-16.828 16.715-39.53 10.164-65.619-11.858-42.804-2.033-89.675-133.044-89.675-29.365 0-57.94 2.824-81.77 6.099-36.819 4.97-73.299-10.955-97.016-40.885-32.301-40.546-65.167-88.433-87.981-123.219-16.151-24.508-21.572-53.986-16.264-83.124 15.473-84.706 18.41-147.615-23.492-206.683-17.619-25.186-41.223-37.835-67.99-37.835ZM1298.4 116.9Q1298.4 16.9 1369.1 87.6L1662.6 381.1Q1733.3 451.8 1633.3 451.8H1398.4Q1298.4 451.8 1298.4 351.8Z" />
        <path d="M791.057 1297.943c92.273-43.37 275.916-65.28 275.916-65.28-92.386-88.998-145.92-215.04-145.92-215.04-43.257 126.607-119.718 264.282-129.996 280.32" />
      </g>
    </svg>
  )
}

/**
 * A vault app's glyph (D107): a rounded square with `</>` cut out of it, from
 * svgrepo.com (#525813). Filled with `currentColor` rather than a type colour,
 * so it takes the tree row's tint as the chevron does.
 */
export function AppIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.46447 3.46447C2 4.92893 2 7.28595 2 12C2 16.714 2 19.0711 3.46447 20.5355C4.92893 22 7.28595 22 12 22C16.714 22 19.0711 22 20.5355 20.5355C22 19.0711 22 16.714 22 12C22 7.28595 22 4.92893 20.5355 3.46447C19.0711 2 16.714 2 12 2C7.28595 2 4.92893 2 3.46447 3.46447ZM13.4881 6.44591C13.8882 6.55311 14.1256 6.96437 14.0184 7.36447L11.4302 17.0237C11.323 17.4238 10.9117 17.6613 10.5116 17.5541C10.1115 17.4468 9.8741 17.0356 9.98131 16.6355L12.5695 6.97624C12.6767 6.57614 13.088 6.3387 13.4881 6.44591ZM14.9697 8.46967C15.2626 8.17678 15.7374 8.17678 16.0303 8.46967L16.2387 8.67801C16.874 9.3133 17.4038 9.84308 17.7678 10.3202C18.1521 10.8238 18.4216 11.3559 18.4216 12C18.4216 12.6441 18.1521 13.1762 17.7678 13.6798C17.4038 14.1569 16.874 14.6867 16.2387 15.322L16.0303 15.5303C15.7374 15.8232 15.2626 15.8232 14.9697 15.5303C14.6768 15.2374 14.6768 14.7626 14.9697 14.4697L15.1412 14.2981C15.8229 13.6164 16.2797 13.1574 16.5753 12.7699C16.8577 12.3998 16.9216 12.1843 16.9216 12C16.9216 11.8157 16.8577 11.6002 16.5753 11.2301C16.2797 10.8426 15.8229 10.3836 15.1412 9.70191L14.9697 9.53033C14.6768 9.23744 14.6768 8.76257 14.9697 8.46967ZM7.96986 8.46967C8.26275 8.17678 8.73762 8.17678 9.03052 8.46967C9.32341 8.76257 9.32341 9.23744 9.03052 9.53033L8.85894 9.70191C8.17729 10.3836 7.72052 10.8426 7.42488 11.2301C7.14245 11.6002 7.07861 11.8157 7.07861 12C7.07861 12.1843 7.14245 12.3998 7.42488 12.7699C7.72052 13.1574 8.17729 13.6164 8.85894 14.2981L9.03052 14.4697C9.32341 14.7626 9.32341 15.2374 9.03052 15.5303C8.73762 15.8232 8.26275 15.8232 7.96986 15.5303L7.76151 15.322C7.12617 14.6867 6.59638 14.1569 6.23235 13.6798C5.84811 13.1762 5.57861 12.6441 5.57861 12C5.57861 11.3559 5.84811 10.8238 6.23235 10.3202C6.59638 9.84308 7.12617 9.31331 7.76151 8.67801L7.96986 8.46967Z"
      />
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

/** A task file's glyph, keyed to its status: an empty circle for todo, a
 *  dotted one for doing, a checked one for done.
 *
 *  **The colours are the `--task-*` tokens, not hex**, the same ones the
 *  editor's task orbs use, so a vault theme recolours both at once (D64). */
export function TaskIcon({ status }: { status: TaskStatus }) {
  if (status === 'done')
    return <CircleCheck size={14} color="var(--task-done)" aria-hidden="true" />
  if (status === 'doing')
    return <CircleDot size={14} color="var(--task-doing)" aria-hidden="true" />
  return <Circle size={14} color="var(--task-todo)" aria-hidden="true" />
}

/**
 * What a file or app is called wherever it is listed: the tree and the tabs
 * (`docs/features/file-tree.md`). A note is the unmarked thing and drops its
 * `.md`; an app drops its `.app` (D107); anything else keeps its extension.
 */
export function pathLabel(path: string): string {
  if (isAppBundlePath(path)) return appName(path)
  const base = path.slice(path.lastIndexOf('/') + 1)
  return fileKind(path) === 'markdown' ? base.replace(/\.md$/i, '') : base
}

/**
 * What a file or app leads with, by the same rule: the vault icon map's emoji
 * first, then an app's glyph, a task's status, nothing for a note, and the type
 * glyph for anything else. `null` is a note's empty slot.
 */
export function pathGlyph(
  path: string,
  { emoji, task }: { emoji?: string; task?: TaskStatus } = {},
): JSX.Element | null {
  if (emoji) return fileIconFor(path, emoji)
  if (isAppBundlePath(path)) return <AppIcon />
  if (task) return <TaskIcon status={task} />
  if (fileKind(path) === 'markdown') return null
  return fileIconFor(path)
}
