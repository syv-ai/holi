#!/usr/bin/env node
// Holi PostToolUse hook — tell the agent immediately when an app it just wrote
// cannot work.
//
// Without it a syntax error shows up as a blank tab. This catches the mistake
// at the moment it is made, while the file is still in mind; `holi app open`
// covers the rest of the loop.
//
// **Advisory, never blocking.** It reports and exits 0. Only `google-send-gate`
// says no; a wrong refusal here would leave the agent unable to write a file.
//
// **Silence is the design.** Nothing about a correct write, and nothing about a
// half-written app that is merely unfinished: a hook that talks every time is
// one the agent learns to skim.
//
// It never uses a dependency: Node's own parser does the syntax check, and
// everything else is a regex over the file the tool just wrote.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { Script } from 'node:vm'

/** Everything this hook knows how to complain about, worst first. */
const ERROR = 'x'
const NOTE = '-'

function main(payload) {
  const filePath = payload?.tool_input?.file_path
  if (typeof filePath !== 'string') return []

  // `<name>.app/…`. The hook is handed an absolute path, so the part
  // above the vault is cut off first when the session's cwd (the vault root)
  // says where that is; a folder named `x.app` above the vault is not an app.
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd.replace(/[/\\]+$/, '') : ''
  const inVault = cwd !== '' && (filePath.startsWith(`${cwd}/`) || filePath.startsWith(`${cwd}\\`))
  const base = inVault ? cwd.length + 1 : 0
  const rel = filePath.slice(base)
  const match = /(?:^|[/\\])([^/\\]+\.app)[/\\]/.exec(rel)
  if (match === null) return []
  const bundleEnd = base + match.index + match[0].length - 1
  const appDir = filePath.slice(0, bundleEnd)
  // What `holi app init` takes: the vault-relative bundle when it is known.
  const bundle = inVault ? appDir.slice(base) : match[1]
  if (/^(\.claude|memory)[/\\]/.test(bundle)) return []

  // A record the agent wrote by hand: Holi's own store check says whether it
  // fits its collection's schema, so there is one validator and not two.
  if (/^data[/\\][^/\\]+[/\\][^/\\]+\.json$/.test(filePath.slice(bundleEnd + 1))) {
    return record(inVault ? rel : filePath)
  }

  const source = readFileSync(filePath, 'utf8')
  const ext = extname(filePath).toLowerCase()

  return [
    ...unbuildable(ext),
    ...syntax(source, ext),
    ...boundaries(source, ext),
    ...registration(appDir, bundle),
  ]
}

/** There is no bundler, so these can never load; they show up as a blank tab
 *  and nothing else. */
function unbuildable(ext) {
  if (!['.ts', '.tsx', '.jsx'].includes(ext)) return []
  return [
    [
      ERROR,
      `a ${ext} file cannot run here: there is no bundler and no build step, so ` +
        `the browser is handed this file verbatim. Write plain .js and plain DOM.`,
    ],
  ]
}

/**
 * Parse what the browser will parse.
 *
 * A `.js` file whole; the inline `<script>` blocks of an `.html`, each offset
 * back to its own line in the file so the reported number is the one the agent
 * would go and look at.
 */
function syntax(source, ext) {
  if (ext === '.js' || ext === '.mjs') return check(source, 0)
  if (ext !== '.html' && ext !== '.htm') return []

  const found = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m
  while ((m = re.exec(source)) !== null) {
    const [, attrs, body] = m
    // A `src=` script has no body to parse, and a JSON block is not JavaScript.
    if (/\bsrc\s*=/i.test(attrs)) continue
    if (/\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)/i.test(attrs))
      continue
    const before = source.slice(0, m.index + m[0].indexOf(body))
    found.push(...check(body, before.split('\n').length - 1))
  }
  return found
}

/**
 * Parse as a script, and if the file is a module, parse what is left of it
 * after the module syntax is taken out.
 *
 * `export const a = 1` is a script-parse error and a perfectly good
 * `type="module"`, but skipping module files would miss every real syntax error
 * in one, so the import/export lines come out and the rest is checked.
 */
function check(source, lineOffset) {
  const error = parse(source)
  if (error === null) return []
  if (looksLikeModule(source)) {
    // Blanked rather than deleted, so every remaining line keeps its number.
    const asScript = source
      .replace(/^\s*import\s[^\n]*$/gm, '')
      .replace(/^(\s*)export\s+default\s+/gm, '$1')
      .replace(/^(\s*)export\s+/gm, '$1')
    const still = parse(asScript)
    if (still === null) return []
    return [format(still, lineOffset)]
  }
  return [format(error, lineOffset)]
}

function looksLikeModule(source) {
  return /^\s*(?:import\s|export\s|export\{)/m.test(source)
}

function parse(source) {
  try {
    new Script(source)
    return null
  } catch (error) {
    return error
  }
}

function format(error, lineOffset) {
  const message = String(error?.message ?? error)
  const at = /:(\d+)$/.exec(String(error?.stack ?? '').split('\n')[0] ?? '')
  const line = at === null ? null : Number(at[1]) + lineOffset
  return [ERROR, `SyntaxError${line === null ? '' : ` at line ${line}`}: ${message}`]
}

/** The boundaries the vault-apps skill states, each with the skill's reason —
 *  so the report teaches the rule rather than only citing it. */
function boundaries(source, ext) {
  const found = []
  const code = ext === '.css' ? '' : stripComments(source)

  if (/\b(?:local|session)Storage\b/.test(code)) {
    found.push([
      ERROR,
      'localStorage and sessionStorage THROW in an app: the page has an opaque ' +
        'origin, so there is no storage to reach. Derive the view from the vault ' +
        'on every load instead.',
    ])
  }
  if (/\bholi\s*\.\s*data\b/.test(code)) {
    found.push([
      ERROR,
      'there is no holi.data — an app stores nothing. The whole API is ' +
        'holi.docs.list, holi.docs.read, holi.tasks.list and holi.open.',
    ])
  }
  if (/\bholi\s*\.\s*(?:docs|tasks)\s*\.\s*(?:write|create|update|delete|save)\b/.test(code)) {
    found.push([
      ERROR,
      'an app cannot write anything — an app shows, the agent changes. The whole ' +
        'API is holi.docs.list, holi.docs.read, holi.tasks.list and holi.open.',
    ])
  }
  if (/<form\b/i.test(code) || /createElement\(\s*["']form["']/.test(code)) {
    found.push([
      ERROR,
      'a form never submits in an app: the frame is sandboxed without forms, so ' +
        'submission is blocked before a submit handler runs, and nothing happens. ' +
        'Handle the button click, and Enter as a keydown on the input, instead.',
    ])
  }
  if (/<script[^>]*\bsrc\s*=\s*["'][^"']*(?:holi|bridge)[^"']*["']/i.test(source)) {
    found.push([
      ERROR,
      'do not add a script tag for the bridge: window.holi is injected when the ' +
        'page is served, and a hand-added one overwrites it with nothing.',
    ])
  }

  // Deliberately last and deliberately quieter: a hard-coded colour still runs.
  const colour = /(?<![\w&])#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(ext === '.css' ? source : code)
  if (colour !== null) {
    found.push([
      NOTE,
      `hard-coded colour ${colour[0]} — use the theme tokens (var(--foreground), ` +
        `var(--background), var(--brand) for text, var(--primary) for fills, …) so the app follows whatever ` +
        `palette this vault has chosen.`,
    ])
  }
  return found
}

/** Line and block comments removed, so a rule named in a comment explaining the
 *  rule does not report itself. Crude on purpose: it only has to be right about
 *  code that would otherwise produce a false positive. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Is this app finished?
 *
 * Only asked once there IS an entry document. Before that the app is merely
 * unfinished, and an agent halfway through writing one does not need to be told
 * on every file that it has not finished yet.
 */
function registration(appDir, bundle) {
  if (!existsSync(join(appDir, 'index.html'))) return []
  if (existsSync(join(appDir, 'app.yaml'))) return []
  return [
    [
      ERROR,
      `${bundle} has no app.yaml, so it is not finished and will not open. Write ` +
        `one (an empty file is enough), or run \`holi app init ${bundle}\`. Write ` +
        `it LAST: it is what finishes the app.`,
    ],
  ]
}

/**
 * `holi store check` on one record. Silent without Holi (no `HOLI_BIN`), on
 * any failure, and on a record that is fine: the vault works in any Claude
 * Code, and a check that cannot run has nothing to say.
 */
function record(path) {
  const bin = process.env.HOLI_BIN
  if (!bin) return []
  const run = spawnSync(bin, ['store', 'check', path], { encoding: 'utf8', timeout: 5000 })
  if (run.status !== 0 || typeof run.stdout !== 'string') return []
  return run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => [ERROR, `${path}: ${line}`])
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (text += chunk))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(''))
  })
}

const raw = await readStdin()
let findings = []
try {
  findings = main(JSON.parse(raw))
} catch {
  // Any failure at all is silence. This hook's opinion is worth strictly less
  // than the agent's turn, so a bug in it must cost nothing.
  findings = []
}

if (findings.length > 0) {
  const lines = findings.map(([mark, text]) => `  ${mark} ${text}`).join('\n')
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `vault-app check:\n${lines}`,
      },
    }),
  )
}
process.exit(0)
