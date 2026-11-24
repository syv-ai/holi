import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebContents } from 'electron'

export async function startInboxNavigation(contents: WebContents, root: string): Promise<void> {
  const target = async (selector: string) =>
    contents.executeJavaScript(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:e.innerText}; })()`,
    )
  const click = async (selector: string) => {
    const point = await target(selector)
    if (!point) throw new Error(`UI target not found: ${selector}`)
    contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    contents.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
    contents.sendInputEvent({
      type: 'mouseUp',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
  }
  try {
    const fixture = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(root, 'inbox-notification.json'), 'utf8'),
    )
    const deadline = Date.now() + 25_000
    let row: { x: number; y: number; text: string } | null = null
    while (Date.now() < deadline) {
      row = await contents.executeJavaScript(
        `(() => { const e=[...document.querySelectorAll('[data-inbox-entry]')].find(e=>e.innerText.includes(${JSON.stringify(fixture.title)})); if(!e)return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:e.innerText}; })()`,
      )
      if (row) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!row) throw new Error('Notification row did not appear')
    await click('[data-agents-sidebar] button')
    const inbox = await target('[data-agents-sidebar]')
    if (!inbox) throw new Error('Agents sidebar unavailable')
    const inboxPoint = await contents.executeJavaScript(
      `(() => { const e=[...document.querySelectorAll('[data-agents-sidebar] button')].find(e=>e.innerText.includes('Inbox')); if(!e)return null; const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    )
    if (!inboxPoint) throw new Error('Inbox navigation item unavailable')
    contents.sendInputEvent({ type: 'mouseDown', ...inboxPoint, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...inboxPoint, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click(`[data-inbox-entry]`)
    const documentText = await contents.executeJavaScript('document.body.innerText')
    if (!documentText.includes(fixture.line))
      throw new Error('Expected Welcome.md content was not displayed')
    const screenshot = (
      await (await import('electron')).BrowserWindow.getFocusedWindow()?.webContents.capturePage()
    )
      ?.toPNG()
      .toString('base64')
    if (!screenshot) throw new Error('Could not capture UI evidence')
    writeFileSync(
      join(root, 'inbox-navigation.json'),
      JSON.stringify({ ok: true, title: fixture.title, document: documentText, screenshot }),
    )
  } catch (error) {
    writeFileSync(
      join(root, 'inbox-navigation.json'),
      JSON.stringify({ ok: false, error: String(error) }),
    )
  }
}
