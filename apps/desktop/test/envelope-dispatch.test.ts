/**
 * D52 — which frames off the user stream cross a vault boundary and which do not.
 *
 * The whole suite runs with **no vault activated**, which is the point rather than a
 * shortcut: it is exactly the state that used to make a reminder undeliverable (D48). A
 * user-scoped stream that then dropped the frame in main would have bought nothing.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/holi-test-unused' } }))

const { createVaultManager } = await import('../src/main/vault/vault-manager')

function managerWith() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const raised: Array<{ vaultId: string; event: unknown }> = []
  const vaultManager = createVaultManager({
    store: { load: () => null, save: () => {}, clear: () => {} } as never,
    dataDir: '/tmp/holi-test-unused',
    send: (channel, payload) => void sent.push({ channel, payload }),
    onReminders: (vaultId, event) => void raised.push({ vaultId, event }),
  })
  return { vaultManager, sent, raised }
}

const fire = { fires: [{ taskId: 't1', title: 'ship it', fireAt: '09:00' }], coalesced: false, firedAt: 'x' }
const doc = { id: 'd1', vaultId: 'v-other', path: 'a.md', kind: 'note', createdAt: '', updatedAt: '' }

describe('handleEnvelope (D52)', () => {
  describe('never filtered by vault', () => {
    // The closure of D48, in one assertion: the app has no vault open at all and the
    // reminder still reaches you.
    it('raises a reminder for a vault that is not the active one', () => {
      const { vaultManager, raised } = managerWith()
      vaultManager.handleEnvelope('reminders', 'v-other', fire)
      expect(raised).toEqual([{ vaultId: 'v-other', event: fire }])
    })

    // Being added to a vault is not *about* any vault you already have — if this were
    // filtered, the switcher would be exactly as stale as before the stream existed.
    it('forwards a membership change, flattened for the renderer', () => {
      const { vaultManager, sent } = managerWith()
      vaultManager.handleEnvelope('membership', 'v-new', { type: 'joined' })
      expect(sent).toEqual([{ channel: 'vaults:event', payload: { vaultId: 'v-new', type: 'joined' } }])
    })
  })

  describe('filtered to the active vault', () => {
    // The renderer holds one tree and one board, and mirror/projector close over one
    // vault. A foreign `tasks` frame reaching applyTasksEvent would fall into its `else`
    // branch and DELETE A TASK FILE (D36's trap by a new road) — so this is a safety
    // property, not a tidiness one.
    it('drops docs, tasks and presence when their vault is not active', () => {
      const { vaultManager, sent } = managerWith()
      vaultManager.handleEnvelope('docs', 'v-other', { type: 'created', doc })
      vaultManager.handleEnvelope('tasks', 'v-other', { type: 'deleted', taskId: 't1' })
      vaultManager.handleEnvelope('presence', 'v-other', {
        taskId: 't1',
        userId: 'u1',
        name: 'Nicolai',
        expiresAt: '',
      })
      expect(sent).toEqual([])
    })
  })

  it('ignores a channel it does not know rather than throwing into the stream', () => {
    const { vaultManager, sent, raised } = managerWith()
    expect(() => vaultManager.handleEnvelope('something-new', 'v1', {})).not.toThrow()
    expect([...sent, ...raised]).toEqual([])
  })
})
