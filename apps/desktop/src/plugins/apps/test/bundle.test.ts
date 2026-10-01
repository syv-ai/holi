import { describe, expect, it } from 'vitest'
import { appHost, appName, bundleFromAppHost } from '../shared/bundle'

describe('appName', () => {
  it('drops the folder and the suffix', () => {
    expect(appName('Finance/Budget.app')).toBe('Budget')
    expect(appName('char-count.app')).toBe('char-count')
  })

  it('drops the .local. marker too: a personal Home is called Home', () => {
    expect(appName('Me/Home.local.app')).toBe('Home')
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
