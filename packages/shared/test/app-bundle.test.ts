import { describe, expect, it } from 'vitest'
import { appBundleOf, appSuffix, isAppBundlePath } from '../src/app-bundle'

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
    expect(isAppBundlePath('.holi/memory/x.app')).toBe(false)
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

describe('appSuffix', () => {
  it('is what a rename must keep, so renaming never publishes a personal app', () => {
    expect(appSuffix('Finance/Budget.app')).toBe('.app')
    expect(appSuffix('Me/Home.local.app')).toBe('.local.app')
  })
})
