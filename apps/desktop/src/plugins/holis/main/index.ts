/**
 * The Holis plugin's main side (docs/features/holis.md): the vault's Holis,
 * their approvals and runs, and the commands their runs keep their memory
 * with. A send runs through the agent (`agent.launch`), which it requires.
 *
 * Electron loads inside `activate`, so the plugin stays importable under
 * plain Node in the tests.
 */
import { join } from 'node:path'
import { jsonFileStore, type MainPlugin } from '../../../main/plugin-api'
import { HOLIS_INFO } from '../info'
import { holisSeed } from './seed'
import { holiCapabilities, HOLI_NAMESPACES } from './capabilities'
import { createHolis, parseHolisFile, type NeedsYou } from './holis'

type Launched = { ok: true; sessionId: string } | { ok: false; message: string }

export const holisMain: MainPlugin = {
  info: HOLIS_INFO,
  seed: holisSeed,
  async activate(ctx) {
    const { BrowserWindow, Notification } = await import('electron')
    // A run that needs the person says so where they are, which is often not
    // Holi: a system notification, and a click opens Agents mode on it.
    const notify = (n: NeedsYou): void => {
      if (!Notification.isSupported()) return
      const note = new Notification({ title: `${n.name} needs you`, body: n.text })
      note.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win !== undefined) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
        ctx.emit(n.remote, 'holi-open', { holi: n.id })
      })
      note.show()
    }
    // Which Holis this machine approved, and their runs: outside the vault,
    // where the agent cannot approve its own (`holis.ts`).
    const holis = createHolis({
      store: jsonFileStore(join(ctx.userData, 'holis.json'), parseHolisFile),
      launch: async (args) => (await ctx.call('agent.launch', args)) as Launched,
      emit: ctx.emit,
      needsYou: notify,
    })
    ctx.register(
      HOLI_NAMESPACES,
      holiCapabilities({ holis, changed: (remote) => ctx.emit(remote, 'holis', null) }),
    )
    return () => {}
  },
}
