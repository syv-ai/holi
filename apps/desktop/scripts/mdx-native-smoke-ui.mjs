export function createMdxSmokeUi(signal) {
  async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function waitFor(fn, label, timeout = 30000) {
    signal.throwIfAborted()
    const deadline = performance.now() + timeout
    let last
    let finished = false
    let timer
    let onAbort
    const expired = () => new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`)
    const guard = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => reject(expired()), timeout)
    })
    const poll = async () => {
      while (!finished) {
        signal.throwIfAborted()
        if (performance.now() >= deadline) throw expired()
        try {
          last = await fn()
        } catch {}
        signal.throwIfAborted()
        if (performance.now() >= deadline) throw expired()
        if (finished) return
        if (last) return last
        await delay(Math.min(100, Math.max(0, deadline - performance.now())))
      }
    }
    try {
      const result = await Promise.race([guard, poll()])
      signal.throwIfAborted()
      if (performance.now() >= deadline) throw expired()
      return result
    } finally {
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function clickPointerAt(page, point, deadline = performance.now() + 30000) {
    const check = () => {
      signal.throwIfAborted()
      if (performance.now() >= deadline)
        throw new Error('Timed out dispatching native pointer input')
    }
    check()
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    for (const type of ['mousePressed', 'mouseReleased']) {
      check()
      await page.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    check()
  }

  async function findInFile(page, text) {
    const deadline = performance.now() + 30000
    const point = await waitFor(
      () =>
        page.evaluate(`(() => {
        const editor = document.querySelector('.cm-content');
        if (!editor) return null;
        const { left, top, width, height } = editor.getBoundingClientRect();
        const x = left + width / 2, y = top + height / 2;
        return editor.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`),
      'visible CodeMirror content to click before Find',
      Math.max(0, deadline - performance.now()),
    )
    await clickPointerAt(page, point, deadline)
    const editorFocused = `document.hasFocus() && document.activeElement?.matches('.cm-content')`
    await waitFor(() => page.evaluate(editorFocused), 'CodeMirror focus after pointer click')
    const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp'])
        await page.call('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        })
    }
    const bar = '[role="search"][aria-label="Find in file"]'
    await press('f', 'KeyF', 70, process.platform === 'darwin' ? 4 : 2)
    await waitFor(
      () => page.evaluate(`!!document.activeElement?.closest(${JSON.stringify(bar)})`),
      'focused Find in file field',
    )
    await page.call('Input.insertText', { text })
    const selectionMatches = `(() => {
      const { state } = window.__mdxSmoke.editor();
      const { from, to } = state.selection.main;
      return state.sliceDoc(from, to) === ${JSON.stringify(text)};
    })()`
    await waitFor(
      () => page.evaluate(selectionMatches),
      'Find in file selects the matching MDX source text',
    )
    await press('Escape', 'Escape', 27)
    await waitFor(
      () =>
        page.evaluate(
          `!document.querySelector(${JSON.stringify(bar)}) && ${editorFocused} && ${selectionMatches}`,
        ),
      'Find in file closed and returned focus to the selected MDX match',
    )
  }

  function cleanDiagnostics(page) {
    return page.evaluate(`
      [...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent.includes('syntax is valid')) &&
      window.__mdxSmoke.diagnostics().length === 0
    `)
  }

  async function settledPaint(page) {
    await page.evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
  }

  async function windowStatus(page) {
    return await page.evaluate(`window.holiSmoke.call('smoke:status')`)
  }

  return {
    delay,
    waitFor,
    clickPointerAt,
    findInFile,
    cleanDiagnostics,
    settledPaint,
    windowStatus,
  }
}
