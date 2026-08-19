import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appFileAbsPath, parseAppUrl } from '../src/main/apps/app-protocol'

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
