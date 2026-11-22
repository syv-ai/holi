import { constants } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { preparePosixSpawn } from '../src/main/posix-launch-lease'

const wire = vi.hoisted(() => ({
  report: '',
  holdGo: true,
  goAttempted: false,
  stopped: false,
  collectSignal: undefined as (() => void) | undefined,
  commands: [] as string[],
}))

vi.mock('../src/main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => process.execPath,
}))
vi.mock('../src/main/posix-lease-transport', () => ({
  leaseEnvironment: {},
  openLeaseTransport: () => ({
    directory: '',
    mapped: [],
    dropMapped() {},
    closeControl() {
      if (!wire.stopped) wire.report += 'TERM\nKILL\n'
      wire.stopped = true
    },
    controlClosed: () => false,
    closeExec() {},
    remove() {},
    retainFailure() {},
    readReport: () => {
      const text = wire.report
      wire.report = ''
      return text || (wire.stopped ? null : undefined)
    },
    readExec: () => null,
    post: (frame: Buffer) => {
      const command = frame.toString()
      wire.commands.push(command)
      if (frame.length > 2) wire.report += 'REAPER 102\n'
      else if (command === 'A') wire.report += 'READY 103 102\n'
      else if (command === 'S') wire.report += 'START\n'
      else if (command === 'G') {
        wire.goAttempted = true
        if (wire.holdGo) return 0
        wire.report += 'GO\n'
      } else if (frame[0] === 70) {
        wire.report += `SIGNAL ${frame[1]}\n`
        // Model an immediately readable native receipt and an exec/lifecycle
        // poll queued before the sending wait's async continuation resumes.
        queueMicrotask(() => wire.collectSignal!())
      } else if (command === 'T') {
        wire.report += 'TERM\nKILL\n'
        wire.stopped = true
      }
      return frame.length
    },
  }),
}))

afterEach(() => vi.restoreAllMocks())

it.skipIf(process.platform === 'win32').each([true, false])(
  'accepts an immediate signal receipt before the sender resumes (pre-GO: %s)',
  async (preGo) => {
    Object.assign(wire, {
      report: 'ROOT 101\n',
      holdGo: true,
      goAttempted: false,
      stopped: false,
      commands: [],
    })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (!wire.stopped) return true
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    const launch = preparePosixSpawn('/usr/bin/true', [], { env: {}, pollMs: 1 }, ['ignore'])
    const observed: unknown[] = []
    wire.collectSignal = () => {
      try {
        observed.push(launch.execution())
      } catch (error) {
        observed.push(error)
      }
    }
    const binding = launch.bind(101)
    void binding.catch(() => {})
    try {
      await vi.waitFor(() => expect(wire.goAttempted).toBe(true))
      if (!preGo) {
        wire.holdGo = false
        await binding
      }
      expect(launch.signal(0)).toBe(true)
      expect(launch.signal(constants.signals.SIGCONT)).toBe(true)
      if (preGo) expect(wire.commands.some((command) => command.startsWith('F'))).toBe(false)
      wire.holdGo = false
      await binding
      await vi.waitFor(() => expect(observed).toHaveLength(1))
      expect(observed).toEqual([null])
      expect(launch.canceledBeforeCommit()).toBe(false)
      await launch.drain()
    } finally {
      wire.holdGo = false
      await launch.drain().catch(() => {})
    }
  },
)
