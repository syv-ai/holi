import { expect, test } from 'vitest'
import { validateArchiveEvidence } from '../scripts/archive-checks.mjs'

function deviceArchive() {
  return {
    archiveInfo: { ApplicationProperties: { ApplicationPath: 'Applications/mobile.app' } },
    appInfo: {
      CFBundleExecutable: 'mobile',
      CFBundleIdentifier: 'ai.syv.holi.compatibility',
      DTPlatformName: 'iphoneos',
      CFBundleSupportedPlatforms: ['iPhoneOS'],
      MinimumOSVersion: '26.0',
    },
    settings: {
      CONFIGURATION: 'Release',
      CODE_SIGNING_ALLOWED: 'NO',
      SDK_NAME: 'iphoneos26.2',
      PLATFORM_NAME: 'iphoneos',
      PRODUCT_BUNDLE_IDENTIFIER: 'ai.syv.holi.compatibility',
      IPHONEOS_DEPLOYMENT_TARGET: '26.0',
    },
    architectures: ['arm64'],
    buildVersion: 'platform IOS\n minos 26.0\n sdk 26.2\n',
    signed: false,
    gitSha: 'a'.repeat(40),
    bundleFiles: ['app/package.json', 'app/bundle.mjs', 'app/shared-bundle-graph.json'],
  }
}

test('accepts unsigned Release device evidence with the application and shared graph', () => {
  expect(() => validateArchiveEvidence(deviceArchive())).not.toThrow()
})

test('rejects an arm64 simulator even though its architecture matches the device', () => {
  const evidence = deviceArchive()
  evidence.buildVersion = 'platform IOSSIMULATOR\n minos 26.0\n sdk 26.2\n'
  expect(() => validateArchiveEvidence(evidence)).toThrow()
})

test('rejects signed archives and signing metadata', () => {
  const signed = deviceArchive()
  signed.signed = true
  expect(() => validateArchiveEvidence(signed)).toThrow()
  const provisioned = deviceArchive()
  provisioned.archiveInfo.ApplicationProperties.SigningIdentity = 'Apple Development'
  expect(() => validateArchiveEvidence(provisioned)).toThrow()
})

test('rejects Debug builds and inconsistent deployment metadata', () => {
  const debug = deviceArchive()
  debug.settings.CONFIGURATION = 'Debug'
  expect(() => validateArchiveEvidence(debug)).toThrow()
  const oldTarget = deviceArchive()
  oldTarget.appInfo.MinimumOSVersion = '25.0'
  expect(() => validateArchiveEvidence(oldTarget)).toThrow()
})

test('rejects archives without executable app code or shared-graph evidence', () => {
  for (const missing of ['app/bundle.mjs', 'app/shared-bundle-graph.json']) {
    const evidence = deviceArchive()
    evidence.bundleFiles = evidence.bundleFiles.filter((name) => name !== missing)
    expect(() => validateArchiveEvidence(evidence)).toThrow()
  }
})

test('rejects paths outside the application products and mismatched bundle identity', () => {
  const outside = deviceArchive()
  outside.archiveInfo.ApplicationProperties.ApplicationPath = 'Applications/../../other.app'
  expect(() => validateArchiveEvidence(outside)).toThrow()
  const otherApp = deviceArchive()
  otherApp.appInfo.CFBundleIdentifier = 'another.app'
  expect(() => validateArchiveEvidence(otherApp)).toThrow()
})
