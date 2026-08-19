import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_METHODS } from '@holi/shared'
import { BRIDGE_JS } from '../src/main/apps/bridge-script'
import {
  appFileAbsPath,
  appHeadHtml,
  injectAppHead,
  parseAppUrl,
} from '../src/main/apps/app-protocol'

const ROOT = '/vault/root'
const APPS = `${ROOT}${sep}.holi${sep}apps`

describe('parseAppUrl', () => {
  it('reads the app id off the HOST and the file off the path', () => {
    expect(parseAppUrl('holi-app://retro/index.html')).toEqual({ appId: 'retro', rel: 'index.html' })
    expect(parseAppUrl('holi-app://retro/sub/app.js')).toEqual({ appId: 'retro', rel: 'sub/app.js' })
  })

  it('treats a bare host as the entry document', () => {
    expect(parseAppUrl('holi-app://retro/')).toEqual({ appId: 'retro', rel: 'index.html' })
    expect(parseAppUrl('holi-app://retro')).toEqual({ appId: 'retro', rel: 'index.html' })
  })

  it('decodes the path', () => {
    expect(parseAppUrl('holi-app://retro/a%20b.css')).toEqual({ appId: 'retro', rel: 'a b.css' })
  })

  it('folds the host to lower case, deliberately rather than by accident', () => {
    // Chromium case-folds the host of a `standard:` scheme; Node's URL does not
    // fold a non-special one. Folding here makes the two agree, so the same URL
    // means the same app whichever parser produced the string.
    expect(parseAppUrl('holi-app://Retro/index.html')).toEqual({ appId: 'retro', rel: 'index.html' })
  })

  it('is null for an id that could not be a directory name', () => {
    // `My_App` folds to `my_app`, which isValidAppId then rejects for the
    // underscore — an app id must survive being a host without colliding.
    expect(parseAppUrl('holi-app://My_App/index.html')).toBeNull()
  })

  it('is null for another scheme or for a non-URL', () => {
    expect(parseAppUrl('holi-vault://retro/x')).toBeNull()
    expect(parseAppUrl('not a url')).toBeNull()
  })
})

describe('appFileAbsPath', () => {
  it('resolves inside ONE app directory', () => {
    expect(appFileAbsPath(ROOT, 'retro', 'index.html')).toBe(`${APPS}${sep}retro${sep}index.html`)
    expect(appFileAbsPath(ROOT, 'retro', 'sub/a.js')).toBe(`${APPS}${sep}retro${sep}sub${sep}a.js`)
  })

  it('refuses to leave that directory', () => {
    // Narrower than holi-vault://, which is the whole point: one app cannot read
    // another app's files, and no app can read the vault's notes off disk.
    expect(appFileAbsPath(ROOT, 'retro', '../../../etc/passwd')).toBeNull()
    expect(appFileAbsPath(ROOT, 'retro', '../other/index.html')).toBeNull()
    expect(appFileAbsPath(ROOT, 'retro', '/abs')).toBeNull()
    expect(appFileAbsPath(ROOT, 'retro', '')).toBeNull()
  })

  it('refuses an invalid app id even when the file path is fine', () => {
    expect(appFileAbsPath(ROOT, '../..', 'index.html')).toBeNull()
    expect(appFileAbsPath(ROOT, 'My_App', 'index.html')).toBeNull()
  })

  it('always lands under the one app root — the containment guarantee', () => {
    // No `..` case here: vaultRelPath refuses one outright, even an interior
    // one the shell would resolve. The URL parser has already normalized any
    // that a real request could carry.
    for (const rel of ['index.html', 'sub/a.js', './index.html', 'sub//deep/a.js']) {
      const out = appFileAbsPath(ROOT, 'retro', rel)
      expect(out).not.toBeNull()
      expect(out!.startsWith(`${APPS}${sep}retro${sep}`)).toBe(true)
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

  it('does not reach for anything the frame cannot have', () => {
    // The origin is opaque: localStorage throws, and there is no origin string
    // to target a postMessage at — which is why '*' is correct here and the
    // renderer is what verifies identity.
    expect(BRIDGE_JS).not.toContain('localStorage')
    expect(BRIDGE_JS).toContain("'*'")
  })
})
