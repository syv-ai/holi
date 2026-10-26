// `pnpm ui:add <name…>`: install shadcn or ReUI components with the shadcn CLI and put
// every file in apps/desktop/src/renderer/src/components/ui, the one stock-component
// folder (docs/renderer.md, "Add a stock component").
//
// The CLI writes where each registry item says: shadcn's land in components/ui already,
// ReUI's in a `components/reui` folder (sometimes under the wrong root). This script
// moves those into components/ui, points their imports there, marks each with the ReUI
// item it came from, and undoes the CLI's `cn` npm dependency (Holi's is @/lib/cn).
// A file that already exists in components/ui is never replaced: Holi edits the stock
// files in place, and the new copy is dropped with a warning.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(repo, 'apps/desktop')
const ui = join(desktop, 'src/renderer/src/components/ui')
const strays = [
  join(desktop, 'src/components/reui'),
  join(desktop, 'src/renderer/src/components/reui'),
]

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('usage: pnpm ui:add <name…>   e.g. pnpm ui:add tabs @reui/timeline')
  process.exit(1)
}

// The @reui registry in components.json reads REUI_LICENSE_KEY; it lives in the
// gitignored apps/desktop/.env.local.
const env = { ...process.env }
const envFile = join(desktop, '.env.local')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
}

const dependencies = () =>
  JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).dependencies ?? {}
const hadCn = 'cn' in dependencies()
const before = new Set(walk(ui))

console.log(
  'Answer "no" when the CLI asks to overwrite a file: Holi edits the stock files in place.',
)
const run = spawnSync('pnpm', ['exec', 'shadcn', 'add', ...names], {
  cwd: desktop,
  env,
  stdio: 'inherit',
})
if (run.status !== 0) process.exit(run.status ?? 1)

const touched = [...walk(ui).filter((f) => !before.has(f))]
for (const stray of strays) {
  for (const file of walk(stray)) {
    const rel = relative(stray, file)
    const target = join(ui, rel)
    if (existsSync(target)) {
      console.warn(`kept components/ui/${rel}; the new ReUI copy was dropped`)
      rmSync(file)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    renameSync(file, target)
    touched.push(target)
    const item = rel.split('/')[0].replace(/\.(tsx?|css)$/, '')
    const text = readFileSync(target, 'utf8')
    if (/\.tsx?$/.test(target) && !text.startsWith('// ReUI:')) {
      writeFileSync(
        target,
        `// ReUI: @reui/${item} (\`npx shadcn@latest view @reui/${item}\` shows the published source)\n${text}`,
      )
    }
  }
  if (existsSync(stray)) rmSync(stray, { recursive: true, force: true })
}

for (const file of touched) {
  if (!/\.tsx?$/.test(file)) continue
  const text = readFileSync(file, 'utf8')
  const next = text
    .replaceAll('@/components/reui/', '@/components/ui/')
    .replace(/from (['"])cn\1/g, 'from "@/lib/cn"')
  if (next !== text) writeFileSync(file, next)
}

if (!hadCn && 'cn' in dependencies()) {
  spawnSync('pnpm', ['--filter', '@holi/desktop', 'remove', 'cn'], { cwd: repo, stdio: 'inherit' })
}

console.log(
  touched.length === 0
    ? 'Nothing new landed in components/ui.'
    : `In components/ui:\n${touched.map((f) => `  ${relative(ui, f)}`).join('\n')}\nCheck \`git status\` for a rewritten index.css, then run pnpm lint.`,
)

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}
