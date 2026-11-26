import assert from 'node:assert/strict'

// This interface consumes observations from the archived app and its exact build invocation.
export function validateArchiveEvidence({
  archiveInfo,
  appInfo,
  settings,
  architectures,
  buildVersion,
  signed,
  bundleFiles,
  gitSha,
}) {
  assert.match(gitSha, /^[a-f0-9]{40,64}$/)
  assert.match(
    archiveInfo.ApplicationProperties?.ApplicationPath ?? '',
    /^Applications\/[^/]+\.app$/,
  )
  for (const field of ['SigningIdentity', 'ProvisioningProfile', 'Team'])
    assert.ok(!archiveInfo.ApplicationProperties[field], `Unexpected signing metadata: ${field}`)
  assert.equal(signed, false, 'The archived executable must be unsigned')
  assert.match(appInfo.CFBundleExecutable ?? '', /^[^/.][^/]*$/)
  assert.ok(appInfo.CFBundleIdentifier)
  assert.equal(appInfo.DTPlatformName, 'iphoneos')
  assert.deepEqual(appInfo.CFBundleSupportedPlatforms, ['iPhoneOS'])
  assert.deepEqual(architectures, ['arm64'])
  assert.match(buildVersion, /\bplatform\s+IOS\s/)
  assert.doesNotMatch(buildVersion, /IOSSIMULATOR/)
  assert.equal(settings.CONFIGURATION, 'Release')
  assert.equal(settings.CODE_SIGNING_ALLOWED, 'NO')
  assert.match(settings.SDK_NAME ?? '', /^iphoneos\d/)
  assert.equal(settings.PLATFORM_NAME, 'iphoneos')
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, appInfo.CFBundleIdentifier)
  assert.equal(appInfo.MinimumOSVersion, settings.IPHONEOS_DEPLOYMENT_TARGET)
  assert.equal(appInfo.MinimumOSVersion, '26.0')
  assert.match(buildVersion, /\bminos\s+26\.0\b/)
  assert.ok(bundleFiles.includes('app/package.json'), 'Missing bundled application metadata')
  assert.ok(
    bundleFiles.some((name) => /^app\/(?:bundle|application)\.js$/.test(name)),
    'Missing bundled application code',
  )
  assert.ok(bundleFiles.includes('app/shared-bundle-graph.json'), 'Missing shared bundle evidence')
}
