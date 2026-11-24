import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, type WebContents } from 'electron'

/** Drives only the fixture's real, visible Inbox controls, never renderer state. */
export async function startInboxNavigation(contents: WebContents, root: string): Promise<void> {
  const steps: string[] = []
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = async (expression: string, label: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const point = await contents.executeJavaScript(`(() => {
        const matches = (${expression}).filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
        });
        if (matches.length !== 1) return null;
        const e = matches[0], r = e.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        if (!e.contains(document.elementFromPoint(x, y)) || e.disabled) return null;
        return { x, y };
      })()`)
      if (point) {
        contents.sendInputEvent({ type: 'mouseMove', ...point })
        contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
        steps.push(label)
        return
      }
      await wait(100)
    }
    throw new Error(`Exactly one visible, unobscured UI target required: ${label}`)
  }
  try {
    const window = BrowserWindow.fromWebContents(contents)
    if (!window) throw new Error('Fixture window unavailable')
    window.show()
    window.focus()
    const focusDeadline = Date.now() + 5000
    while (!window.isFocused()) {
      if (Date.now() > focusDeadline)
        throw new Error('Owned fixture window did not gain native focus')
      await wait(100)
    }
    await writeFile(join(root, 'inbox-focus-ready.json'), JSON.stringify({ focused: true }), {
      flag: 'wx',
    })
    const fixture = JSON.parse(await readFile(join(root, 'inbox-notification.json'), 'utf8'))
    const deadline = Date.now() + 30_000
    while (!(await readFile(join(root, 'inbox-submitted.json'), 'utf8').catch(() => null))) {
      if (Date.now() > deadline) throw new Error('Production notification submission missing')
      await wait(100)
    }
    await click(
      "[...document.querySelectorAll('[role=tab]')].filter(e => e.textContent.trim() === 'Agents')",
      'Agents sidebar mode',
    )
    await click(
      "[...document.querySelectorAll('[data-agents-sidebar] button')].filter(e => [...e.querySelectorAll('span')].some(s => s.textContent.trim() === 'Inbox'))",
      'Inbox navigation',
    )
    await click(
      `[...document.querySelectorAll('[data-inbox-entry] > button')].filter(e => [...e.querySelectorAll('span')].some(s => s.textContent === ${JSON.stringify(fixture.title)}))`,
      'exact owned notice row',
    )
    const openedDeadline = Date.now() + 15_000
    let destination
    while (Date.now() < openedDeadline) {
      destination = await contents.executeJavaScript(`(() => {
        const visible = e => {const r=e.getBoundingClientRect();return r.width>0 && r.height>0;};
        const editors = [...document.querySelectorAll('[contenteditable=true]')].filter(visible);
        return {editorTexts:editors.map(e=>e.innerText), selectedTabs:[...document.querySelectorAll('[role=tab][aria-selected=true]')].filter(visible).map(e=>e.innerText)};
      })()`)
      if (
        destination.editorTexts.some((text: string) =>
          fixture.expectedParagraphs.every((part: string) => text.includes(part)),
        )
      )
        break
      await wait(100)
    }
    if (
      !destination?.editorTexts.some((text: string) =>
        fixture.expectedParagraphs.every((part: string) => text.includes(part)),
      )
    )
      throw new Error('Owned welcome document did not appear in a visible editor')
    steps.push('owned welcome document visible in editor')
    const screenshot = (await contents.capturePage()).toPNG().toString('base64')
    await writeFile(
      join(root, 'inbox-navigation.json'),
      JSON.stringify({ ok: true, title: fixture.title, destination, steps, screenshot }),
      { flag: 'wx' },
    )
  } catch (error) {
    await writeFile(
      join(root, 'inbox-navigation.json'),
      JSON.stringify({
        ok: false,
        error: String(error),
        steps,
        bodyText: await contents.executeJavaScript('document.body.innerText').catch(() => null),
      }),
      { flag: 'wx' },
    )
  }
}
