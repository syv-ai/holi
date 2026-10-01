import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_METHODS, THEME_TOKENS, appHost } from '@holi/shared'
import { APP_BASE_TOKENS, missingBaseTokens } from '../main/tokens'
import { BRIDGE_JS } from '../main/bridge-script'
import {
  appFileAbsPath,
  appHeadHtml,
  servableAppFile,
  injectAppHead,
  parseAppUrl,
} from '../main/protocol'

const ROOT = '/vault/root'
const BUNDLE = 'Finance/Budget.app'
const APP = `${ROOT}${sep}Finance${sep}Budget.app`
const HOST = appHost(BUNDLE)

describe('parseAppUrl', () => {
  it('reads the bundle off the HOST and the file off the path', () => {
    expect(parseAppUrl(`holi-app://${HOST}/index.html`)).toMatchObject({
      bundle: BUNDLE,
      rel: 'index.html',
    })
    expect(parseAppUrl(`holi-app://${HOST}/sub/app.js`)).toMatchObject({
      bundle: BUNDLE,
      rel: 'sub/app.js',
    })
  })

  // The renderer knows the mode in force; main does not. The frame's URL says it.
  it('reads the colour mode off the query, dark when absent or unknown', () => {
    expect(parseAppUrl(`holi-app://${HOST}/index.html?mode=light`)?.mode).toBe('light')
    expect(parseAppUrl(`holi-app://${HOST}/index.html?mode=dark`)?.mode).toBe('dark')
    expect(parseAppUrl(`holi-app://${HOST}/index.html`)?.mode).toBe('dark')
    expect(parseAppUrl(`holi-app://${HOST}/index.html?mode=pink`)?.mode).toBe('dark')
  })

  it('treats a bare host as the entry document', () => {
    expect(parseAppUrl(`holi-app://${HOST}/`)).toMatchObject({ bundle: BUNDLE, rel: 'index.html' })
    expect(parseAppUrl(`holi-app://${HOST}`)).toMatchObject({ bundle: BUNDLE, rel: 'index.html' })
  })

  it('decodes the path', () => {
    expect(parseAppUrl(`holi-app://${HOST}/a%20b.css`)).toMatchObject({ rel: 'a b.css' })
  })

  it('reads a host that arrives upper-cased the same', () => {
    // Chromium case-folds the host of a `standard:` scheme and Node does not
    // fold a non-special one; hex means the fold changes nothing either way.
    expect(parseAppUrl(`holi-app://${HOST.toUpperCase()}/index.html`)).toMatchObject({
      bundle: BUNDLE,
    })
  })

  it('is null for a host that is not a bundle', () => {
    expect(parseAppUrl('holi-app://retro/index.html')).toBeNull()
    expect(parseAppUrl(`holi-app://${appHost('.claude/x.app')}/index.html`)).toBeNull()
  })

  it('is null for another scheme or for a non-URL', () => {
    expect(parseAppUrl(`holi-vault://${HOST}/x`)).toBeNull()
    expect(parseAppUrl('not a url')).toBeNull()
  })
})

describe('appFileAbsPath', () => {
  it('resolves inside ONE bundle', () => {
    expect(appFileAbsPath(ROOT, BUNDLE, 'index.html')).toBe(`${APP}${sep}index.html`)
    expect(appFileAbsPath(ROOT, BUNDLE, 'sub/a.js')).toBe(`${APP}${sep}sub${sep}a.js`)
  })

  it('refuses to leave that bundle', () => {
    // Narrower than holi-vault://, which is the whole point: one app cannot read
    // another app's files, and no app can read the vault's notes off disk.
    expect(appFileAbsPath(ROOT, BUNDLE, '../../../etc/passwd')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, '../Other.app/index.html')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, '/abs')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, '')).toBeNull()
  })

  it('never serves the store: records are reached through the bridge only', () => {
    // Otherwise `fetch('data/…')` would read past the store's checks.
    expect(appFileAbsPath(ROOT, BUNDLE, 'data/items/a.json')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, 'data')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, './data/a.json')).toBeNull()
    // macOS's filesystem is case-insensitive: these are the same files.
    expect(appFileAbsPath(ROOT, BUNDLE, 'Data/items/a.json')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, 'DATA/items/a.json')).toBeNull()
    expect(appFileAbsPath(ROOT, BUNDLE, 'database.js')).toBe(`${APP}${sep}database.js`)
    expect(appFileAbsPath(ROOT, BUNDLE, 'lib/data/x.js')).toBe(
      `${APP}${sep}lib${sep}data${sep}x.js`,
    )
  })

  it('refuses a path that is not a bundle even when the file path is fine', () => {
    expect(appFileAbsPath(ROOT, '../x.app', 'index.html')).toBeNull()
    expect(appFileAbsPath(ROOT, 'notes', 'index.html')).toBeNull()
    expect(appFileAbsPath(ROOT, '.claude/x.app', 'index.html')).toBeNull()
  })

  it('always lands under the one bundle — the containment guarantee', () => {
    // No `..` case here: vaultRelPath refuses one outright, even an interior
    // one the shell would resolve. The URL parser has already normalized any
    // that a real request could carry.
    for (const rel of ['index.html', 'sub/a.js', './index.html', 'sub//deep/a.js']) {
      const out = appFileAbsPath(ROOT, BUNDLE, rel)
      expect(out).not.toBeNull()
      expect(out!.startsWith(`${APP}${sep}`)).toBe(true)
    }
  })
})

describe('injectAppHead', () => {
  const HEAD = '<!--injected-->'

  it('puts the block immediately after the opening head tag', () => {
    const out = injectAppHead('<html><head><title>x</title></head>', HEAD)
    expect(out).toBe(`<html><head>${HEAD}<title>x</title></head>`)
  })

  it('matches a head tag carrying attributes', () => {
    const out = injectAppHead('<html><head lang="en"><title>x</title></head>', HEAD)
    expect(out).toBe(`<html><head lang="en">${HEAD}<title>x</title></head>`)
  })

  it('prepends when the document has no head — an app may ship a bare fragment', () => {
    expect(injectAppHead('<h1>hi</h1>', HEAD)).toBe(`${HEAD}<h1>hi</h1>`)
  })

  it('changes nothing else about the document', () => {
    // Remove what we added and the app's own bytes must come back exactly. Only
    // the entry document is ever touched; every other file is served verbatim.
    const src = '<html><head><title>x</title></head><body><p>a &amp; b</p></body></html>'
    expect(injectAppHead(src, HEAD).replace(HEAD, '')).toBe(src)
  })
})

describe('appHeadHtml', () => {
  it('gives an UNTHEMED vault a full palette', () => {
    // The defect this exists for: with only the vault's overrides injected, a
    // vault whose theme.json is `{}` (which is what gets seeded) hands the app
    // `:root{}`. Every var() then resolves to nothing and the app renders black
    // text on a transparent page — while every unit test passes. Found in the
    // running app, not here, which is why the assertion is now here.
    expect(missingBaseTokens()).toEqual([])
    const out = appHeadHtml({})
    for (const token of THEME_TOKENS) {
      expect(out).toContain(`--${token}:`)
    }
  })

  it('lets the vault override a base token', () => {
    const out = appHeadHtml({ primary: 'oklch(0.7 0.1 250)' })
    // Both are present; the vault's comes second, so it is the one that applies.
    expect(out.indexOf('--primary:oklch(0.7 0.1 250)')).toBeGreaterThan(
      out.indexOf(`--primary:${APP_BASE_TOKENS['primary']}`),
    )
  })

  it('writes the resolved theme onto :root as custom properties', () => {
    const out = appHeadHtml({ primary: 'oklch(0.7 0.1 250)' })
    expect(out).toMatch(/<style>:root\{[^<]*--primary:oklch\(0\.7 0\.1 250\)[^<]*\}<\/style>/)
  })

  it('carries the bridge shim in a script tag', () => {
    expect(appHeadHtml({})).toContain(`<script>${BRIDGE_JS}</script>`)
  })

  it('cannot be escaped by a hostile token value', () => {
    // resolveTheme already refuses `<`/`>` — this is the second guard, because
    // the head is built from a block and a caller could hand one over unresolved.
    const out = appHeadHtml({ primary: '</style><script>alert(1)</script>' })
    expect(out).not.toContain('alert(1)</script>')
    expect(out.match(/<style>/g)).toHaveLength(1)
    expect(out.match(/<\/style>/g)).toHaveLength(1)
    expect(out.match(/<script>/g)).toHaveLength(1)
    expect(out.match(/<\/script>/g)).toHaveLength(1)
  })
})

describe('BRIDGE_JS', () => {
  it('implements every method on the wire', () => {
    // The shim is a string, so nothing typechecks it against APP_METHODS. This
    // is what goes red when a method is added to the wire and not to the shim.
    for (const method of APP_METHODS) {
      expect(BRIDGE_JS).toContain(`'${method}'`)
    }
  })

  it('parses: a syntax slip in the string is an app that silently does nothing', () => {
    expect(() => new Function(BRIDGE_JS)).not.toThrow()
  })

  it('defines <holi-note> and holi.on', () => {
    expect(BRIDGE_JS).toContain("customElements.define('holi-note'")
    expect(BRIDGE_JS).toContain('    on,')
  })

  it('routes a push to its listeners and a reply to its caller', () => {
    // Run the shim against a minimal fake frame: parent, message events, crypto.
    const handlers: ((e: { source: unknown; data: unknown }) => void)[] = []
    const sent: { id: string; method: string }[] = []
    const parent = { postMessage: (m: { id: string; method: string }) => sent.push(m) }
    const win: Record<string, unknown> = {}
    const fake = {
      addEventListener: (_: string, fn: (e: { source: unknown; data: unknown }) => void) =>
        handlers.push(fn),
      parent,
      window: win,
      crypto: { randomUUID: () => `id${sent.length}` },
      HTMLElement: class {},
      customElements: { get: () => undefined, define: () => {} },
    }
    new Function(...Object.keys(fake), BRIDGE_JS)(...Object.values(fake))
    const holi = win.holi as {
      on(t: string, fn: () => void): () => void
      sync: { status(): Promise<unknown> }
    }
    const heard: string[] = []
    const off = holi.on('docs', () => heard.push('docs'))
    const deliver = (data: unknown) => handlers.forEach((h) => h({ source: parent, data }))

    deliver({ push: 'docs' })
    off()
    deliver({ push: 'docs' })
    expect(heard).toEqual(['docs'])

    const status = holi.sync.status()
    expect(sent.at(-1)).toMatchObject({ method: 'sync.status' })
    deliver({ id: sent.at(-1)!.id, ok: true, value: { kind: 'up-to-date' } })
    return expect(status).resolves.toEqual({ kind: 'up-to-date' })
  })

  it('does not reach for anything the frame cannot have', () => {
    // The origin is opaque: localStorage throws, and there is no origin string
    // to target a postMessage at — which is why '*' is correct here and the
    // renderer is what verifies identity.
    expect(BRIDGE_JS).not.toContain('localStorage')
    expect(BRIDGE_JS).toContain("'*'")
  })
})

describe('servableAppFile', () => {
  // A committed link is content like any other file, so an app's author (or a
  // pull) can plant one: the protocol must not follow it out of the bundle.
  it('serves a real file and refuses one reached through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-app-proto-'))
    try {
      await mkdir(join(root, 'memory'))
      await writeFile(join(root, 'memory/x.md'), 'secret')
      await mkdir(join(root, BUNDLE), { recursive: true })
      await writeFile(join(root, BUNDLE, 'index.html'), '<p></p>')
      await symlink('../../memory/x.md', join(root, BUNDLE, 'x.txt'))
      await symlink('../../memory', join(root, BUNDLE, 'lib'))
      expect(await servableAppFile(root, BUNDLE, 'index.html')).not.toBeNull()
      expect(await servableAppFile(root, BUNDLE, 'x.txt')).toBeNull()
      expect(await servableAppFile(root, BUNDLE, 'lib/x.md')).toBeNull()
      expect(await servableAppFile(root, BUNDLE, 'data/a.json')).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
