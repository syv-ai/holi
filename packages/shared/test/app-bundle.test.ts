import { describe, expect, it } from 'vitest'
import {
  appBundleOf,
  appHost,
  appName,
  appSuffix,
  bundleFromAppHost,
  isAppBundlePath,
} from '../src/app-bundle'

describe('isAppBundlePath', () => {
  it('is a directory named *.app anywhere in the vault', () => {
    expect(isAppBundlePath('Budget.app')).toBe(true)
    expect(isAppBundlePath('Finance/Budget.app')).toBe(true)
    expect(isAppBundlePath('.holi/x.app')).toBe(true)
  })

  it('needs a name before the suffix', () => {
    expect(isAppBundlePath('.app')).toBe(false)
    expect(isAppBundlePath('Finance/.app')).toBe(false)
    expect(isAppBundlePath('Finance/Budget')).toBe(false)
    expect(isAppBundlePath('.local.app')).toBe(false)
  })

  it('includes a personal app, whose folder carries the .local. marker', () => {
    expect(isAppBundlePath('Home.local.app')).toBe(true)
    expect(isAppBundlePath('Me/Home.local.app')).toBe(true)
  })

  it('refuses the agent surface', () => {
    expect(isAppBundlePath('.claude/x.app')).toBe(false)
    expect(isAppBundlePath('memory/x.app')).toBe(false)
  })

  it('refuses an app inside an app', () => {
    expect(isAppBundlePath('A.app/B.app')).toBe(false)
  })

  it('refuses a path that is not normalized', () => {
    expect(isAppBundlePath('../x.app')).toBe(false)
    expect(isAppBundlePath('/x.app')).toBe(false)
    expect(isAppBundlePath('a//x.app')).toBe(false)
  })
})

describe('appBundleOf', () => {
  it('is the bundle a file sits in, at any depth', () => {
    expect(appBundleOf('A.app/index.html')).toBe('A.app')
    expect(appBundleOf('Finance/Budget.app/sub/x.js')).toBe('Finance/Budget.app')
  })

  it('is null outside a bundle, and for a file merely named .app', () => {
    expect(appBundleOf('notes/x.md')).toBe(null)
    expect(appBundleOf('notes/x.app')).toBe(null)
    expect(appBundleOf('.claude/x.app/index.html')).toBe(null)
  })
})

describe('appName', () => {
  it('drops the folder and the suffix', () => {
    expect(appName('Finance/Budget.app')).toBe('Budget')
    expect(appName('char-count.app')).toBe('char-count')
  })

  it('drops the .local. marker too: a personal Home is called Home', () => {
    expect(appName('Me/Home.local.app')).toBe('Home')
  })
})

describe('appSuffix', () => {
  it('is what a rename must keep, so renaming never publishes a personal app', () => {
    expect(appSuffix('Finance/Budget.app')).toBe('.app')
    expect(appSuffix('Me/Home.local.app')).toBe('.local.app')
  })
})

describe('appHost', () => {
  it('round-trips a bundle path', () => {
    for (const path of ['Finance/Budget.app', 'Æble grød.app', `${'deep/'.repeat(40)}x.app`]) {
      expect(bundleFromAppHost(appHost(path))).toBe(path)
    }
  })

  it('is a valid, lowercase host whose labels fit DNS', () => {
    const host = appHost(`${'deep/'.repeat(40)}x.app`)
    expect(host).toMatch(/^[0-9a-f.]+app$/)
    for (const label of host.split('.')) expect(label.length).toBeLessThanOrEqual(63)
  })

  it('survives a URL parser without being read as an address', () => {
    const host = appHost('A.app')
    expect(new URL(`https://${host}/index.html`).hostname).toBe(host)
  })

  it('refuses a host that is not one, or does not decode to a bundle', () => {
    expect(bundleFromAppHost('retro')).toBe(null)
    expect(bundleFromAppHost('zz.app')).toBe(null)
    expect(bundleFromAppHost(appHost('../x.app'))).toBe(null)
    expect(bundleFromAppHost(appHost('.claude/x.app'))).toBe(null)
    expect(bundleFromAppHost(appHost('notes'))).toBe(null)
  })
})
