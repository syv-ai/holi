import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { recordCredentialCommand } from './credential-log.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

/** Own a fresh simctl device by its exact identity even if create loses its stdout. */
export function ownCredentialSimulator({ name, runtime, deviceType, command, cleanupCommand }) {
  let attempted = false
  let observed = false
  let simulator
  const commands = []
  const list = async (run) => {
    const { devices } = JSON.parse(
      await run('xcrun', ['simctl', 'list', 'devices', '--json'], {
        timeout: 15_000,
        outputLimit: 512 * 1024,
      }),
    )
    assert.ok(devices && typeof devices === 'object' && !Array.isArray(devices))
    return Object.entries(devices).flatMap(([runtime, entries]) => {
      assert.ok(Array.isArray(entries))
      return entries.map((device) => {
        assert.ok(typeof device?.udid === 'string' && uuid.test(device.udid))
        assert.equal(typeof device.name, 'string')
        return { ...device, runtime }
      })
    })
  }
  const identify = (devices) => {
    const candidates = devices.filter(
      (device) => device.name === name || device.udid.toUpperCase() === simulator,
    )
    if (!candidates.length) return { status: 'absent' }
    const [device] = candidates
    if (
      candidates.length !== 1 ||
      device.name !== name ||
      device.runtime !== runtime ||
      device.deviceTypeIdentifier !== deviceType ||
      (simulator && device.udid.toUpperCase() !== simulator)
    )
      return { status: 'ambiguous' }
    return { status: 'found', device }
  }
  const reconcile = () =>
    recordCredentialCommand(commands, 'list-devices', () => list(cleanupCommand))
  const action = (verb) =>
    recordCredentialCommand(commands, verb, () =>
      cleanupCommand('xcrun', ['simctl', verb, simulator], { timeout: 60_000 }),
    )
  return {
    async create() {
      assert.ok(!attempted, 'Simulator creation already attempted')
      assert.equal(identify(await list(command)).status, 'absent', 'Simulator name already in use')
      // simctl can lose its client after CoreSimulator accepts the create request.
      attempted = true
      const id = await command('xcrun', ['simctl', 'create', name, deviceType, runtime], {
        timeout: 60_000,
      })
      assert.match(id, uuid)
      simulator = id.toUpperCase()
      assert.equal(identify(await list(command)).status, 'found', 'Could not verify new simulator')
      observed = true
      return simulator
    },
    async cleanup() {
      const result = (status) => ({
        name,
        runtime,
        deviceType,
        simulator,
        simulatorRemoved: status === 'absent',
        status,
        commands,
      })
      if (!attempted) return result('not-attempted')
      try {
        let match = identify(await reconcile())
        // After a lost create response, allow the service to finish publishing the
        // device. No visible match in this window is uncertainty, not proof.
        for (let i = 0; !observed && match.status === 'absent' && i < 10; i++) {
          await sleep(500)
          match = identify(await reconcile())
        }
        if (match.status !== 'found')
          return result(
            match.status === 'absent' && !observed ? 'create-unconfirmed' : match.status,
          )
        simulator = match.device.udid.toUpperCase()
        if (match.device.state !== 'Shutdown') await action('shutdown').catch(() => {})
        await action('delete').catch(() => {})
        const remaining = identify(await reconcile()).status
        return result(remaining === 'found' ? 'still-present' : remaining)
      } catch {
        return result('reconciliation-failed')
      }
    },
  }
}
