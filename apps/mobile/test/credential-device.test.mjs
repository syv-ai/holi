import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ownCredentialSimulator } from '../scripts/credential-device.mjs'

// Model the two sides of simctl create: the service can commit a device even
// when the client never receives its UUID. Cleanup has a fresh client.
function interruptedCreate({ anotherMatchingDevice = false } = {}) {
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
  const deviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
  const name = 'holi-770-8cc448d5-5de7-4699-9465-6d66cd3594c8'
  const unrelated = {
    name: `${name}-other`,
    udid: '0896B489-1087-4B2A-99FC-86B5544D09B3',
    state: 'Booted',
    deviceTypeIdentifier: deviceType,
  }
  const devices = new Map([[unrelated.udid, unrelated]])
  const controller = new AbortController()
  const simctl = async (exe, [tool, verb, ...args]) => {
    assert.equal(exe, 'xcrun')
    assert.equal(tool, 'simctl')
    if (verb === 'list' && args.join(' ') === 'devices --json')
      return JSON.stringify({ devices: { [runtime]: [...devices.values()] } })
    if (verb === 'create') {
      const [requestedName, requestedType, requestedRuntime] = args
      assert.equal(requestedRuntime, runtime)
      const newDevice = {
        name: requestedName,
        udid: '4F438E6D-CBE9-48D3-AD40-050BB2EEF2D9',
        deviceTypeIdentifier: requestedType,
        state: 'Shutdown',
      }
      devices.set(newDevice.udid, newDevice)
      if (anotherMatchingDevice) {
        const udid = 'C54BCE18-155B-4F78-8048-DBDC2A0FFD45'
        devices.set(udid, { ...newDevice, udid })
      }
      controller.abort()
      controller.signal.throwIfAborted()
    }
    if (verb === 'delete' || verb === 'shutdown') {
      const [id] = args
      const target = devices.get(id)
      if (!target) throw Object.assign(new Error('Device not found'), { exitCode: 2 })
      if (verb === 'delete') {
        if (target.state !== 'Shutdown')
          throw Object.assign(new Error('Device is booted'), { exitCode: 2 })
        devices.delete(id)
      } else devices.set(id, { ...target, state: 'Shutdown' })
      return ''
    }
    throw new Error('Unsupported simulated simctl command')
  }
  const command = (...args) => {
    controller.signal.throwIfAborted()
    return simctl(...args)
  }
  return {
    owned: ownCredentialSimulator({ name, runtime, deviceType, command, cleanupCommand: simctl }),
    devices,
    unrelated,
  }
}

test('reconciles the exact created device after interruption and leaves the existing device alone', async () => {
  const { owned, devices, unrelated } = interruptedCreate()
  await assert.rejects(owned.create(), { name: 'AbortError' })
  const receipt = await owned.cleanup()
  assert.equal(receipt.simulatorRemoved, true)
  assert.deepEqual([...devices.values()], [unrelated])
})

test('reports uncertain cleanup without deleting when the lost create has ambiguous matches', async () => {
  const { owned, devices } = interruptedCreate({ anotherMatchingDevice: true })
  await assert.rejects(owned.create())
  const before = [...devices.values()]
  const receipt = await owned.cleanup()
  assert.equal(receipt.simulatorRemoved, false)
  assert.equal(receipt.status, 'ambiguous')
  assert.deepEqual([...devices.values()], before)
})
