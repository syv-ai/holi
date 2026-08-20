#!/usr/bin/env node
// Holi PostToolUse hook — tell the agent immediately when an app it just wrote
// cannot work.
//
// Slice 1's authoring loop was: write the files, then ask the user to go and
// look. There was no console, no screenshot and no way to open the app, so a
// syntax error showed up as a blank tab and a puzzled user. `holi app open`
// gives the agent the second half of that loop; this gives it the first — the
// class of mistake that a look at the running app would have caught anyway,
// caught at the moment it is made, while the file is still in mind.
//
// **Advisory, never blocking.** It reports and exits 0. The one hook here that
// says no is `google-send-gate`, and it says no about mail reaching a person
// who cannot un-receive it. A lint opinion does not get that power: the cost of
// a wrong refusal here is the agent unable to write a file, and the cost of a
// missed report is a sentence nobody read.
//
// **Silence is the design.** It says nothing at all about a correct write, and
// nothing about a half-written app that is merely unfinished. A hook that talks
// every time is one the agent learns to skim, and then it is not a feedback
// loop, it is noise.
//
// It never uses a dependency: Node's own parser does the syntax check, and
// everything else is a regex over the file the tool just wrote.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { Script } from 'node:vm'

/** Everything this hook knows how to complain about, worst first. */
const ERROR = 'x'
const NOTE = '-'

function main(payload) {
  const filePath = payload?.tool_input?.file_path
  if (typeof filePath !== 'string') return []

  // `.holi/apps/<id>/…` — anywhere in the absolute path, because the hook is
  // handed an absolute path and never told where the vault root is.
  const match = /[/\\]\.holi[/\\]apps[/\\]([^/\\]+)[/\\](.+)$/.exec(filePath)
  if (match === null) return []
  const [, appId] = match
  const appDir = filePath.slice(0, match.index) + join('/.holi/apps', appId)

  const source = readFileSync(filePath, 'utf8')
  const ext = extname(filePath).toLowerCase()

  return [
    ...unbuildable(ext),
    ...syntax(source, ext),
    ...boundaries(source, ext),
    ...registration(appDir, appId),
  ]
}

/** There is no bundler, so these can never load — which today shows up as a
 *  blank tab and nothing else. */
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
    if (/\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)/i.test(attrs)) continue
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
 * `type="module"`. Reporting it would be this hook inventing a rule the
 * platform does not have — but simply giving up on module files would blind it
 * to every real syntax error in one, so the import/export lines come out and
 * the rest is checked.
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
 * Is this app registered?
 *
 * Only asked once there IS an entry document. Before that the app is merely
 * unfinished, and an agent halfway through writing one does not need to be told
 * on every file that it has not finished yet.
 */
function registration(appDir, appId) {
  if (!existsSync(join(appDir, 'index.html'))) return []
  if (existsSync(join(appDir, 'app.yaml'))) return []
  return [
    [
      ERROR,
      `${appId} has no app.yaml, so it will not appear in the sidebar. Write one ` +
        `(name: ${appId} is enough), or run \`holi app init ${appId}\`. Write it ` +
        `LAST: it is what registers the app.`,
    ],
  ]
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
