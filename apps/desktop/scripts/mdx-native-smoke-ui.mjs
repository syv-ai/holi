import { setTimeout as sleep } from 'node:timers/promises'

const interactionMs = 30000

export function createMdxSmokeUi(signal) {
  function remainingBudget(deadline, expired) {
    signal.throwIfAborted()
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw expired()
    return remaining
  }

  async function bounded(operation, deadline, expired) {
    const remaining = remainingBudget(deadline, expired)
    let timer
    let onAbort
    const guard = new Promise((_, reject) => {
      const onTimeout = () => {
        const left = deadline - performance.now()
        if (left > 0) timer = setTimeout(onTimeout, Math.ceil(left))
        else reject(expired())
      }
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(onTimeout, Math.ceil(remaining))
    })
    try {
      const result = await Promise.race([
        guard,
        Promise.resolve().then(() => {
          remainingBudget(deadline, expired)
          return operation()
        }),
      ])
      remainingBudget(deadline, expired)
      return result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  // Bound one operation at a time: an already-sent CDP call cannot be withdrawn,
  // but its late acknowledgement must not start another operation.
  function untilDeadline(operation, deadline, label = 'native MDX operation') {
    return bounded(operation, deadline, () => new Error(`Timed out waiting for ${label}`))
  }

  async function delay(ms, deadline) {
    signal.throwIfAborted()
    const expired = () => new Error('Timed out waiting for native MDX delay')
    const remaining = deadline === undefined ? Infinity : remainingBudget(deadline, expired)
    try {
      await sleep(Math.ceil(Math.min(ms, remaining)), undefined, { signal })
    } finally {
      signal.throwIfAborted()
    }
    if (deadline !== undefined) {
      remainingBudget(deadline, expired)
      if (ms >= remaining) throw expired()
    }
  }

  async function waitFor(fn, label, budget = interactionMs) {
    const deadline = typeof budget === 'number' ? performance.now() + budget : budget.deadline
    let last
    const expired = () => new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`)
    for (;;) {
      last = await bounded(
        async () => {
          try {
            return await fn()
          } catch {
            // A probe can fail while the renderer is changing. Retry within the budget.
            return last
          }
        },
        deadline,
        expired,
      )
      if (last) return last
      await delay(Math.min(100, remainingBudget(deadline, expired)))
    }
  }

  // hitTest must read whether these coordinates still hit the original logical target.
  async function clickPointerAt(
    page,
    point,
    hitTest,
    deadline = performance.now() + interactionMs,
  ) {
    const dispatch = (type, button = {}) =>
      untilDeadline(
        () => page.call('Input.dispatchMouseEvent', { type, ...point, ...button }),
        deadline,
        type,
      )
    await dispatch('mouseMoved')
    if (!(await untilDeadline(() => hitTest(point), deadline, 'pointer target after movement')))
      throw new Error('Native pointer target changed after movement')
    for (const type of ['mousePressed', 'mouseReleased'])
      await dispatch(type, { button: 'left', clickCount: 1 })
  }

  async function findInFile(page, text, deadline = performance.now() + interactionMs) {
    const hitEditor = (point = null) =>
      page.evaluate(`(() => {
        const editor = document.querySelector('.cm-content');
        if (!editor) return null;
        const { left, top, width, height } = editor.getBoundingClientRect();
        const { x, y } = ${JSON.stringify(point)} ?? { x: left + width / 2, y: top + height / 2 };
        return editor.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
      })()`)
    const point = await waitFor(hitEditor, 'visible CodeMirror content to click before Find', {
      deadline,
    })
    await clickPointerAt(page, point, hitEditor, deadline)
    const ready = (expression, label) =>
      waitFor(() => page.evaluate(expression), label, { deadline })
    const editorFocused = `document.hasFocus() && document.activeElement?.matches('.cm-content')`
    await ready(editorFocused, 'CodeMirror focus after pointer click')
    const keyInput = (method, params) =>
      untilDeadline(() => page.call(method, params), deadline, method)
    const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp'])
        await keyInput('Input.dispatchKeyEvent', {
          type,
          key,
          code,
          windowsVirtualKeyCode,
          modifiers,
        })
    }
    const bar = '[role="search"][aria-label="Find in file"]'
    await press('f', 'KeyF', 70, process.platform === 'darwin' ? 4 : 2)
    await ready(
      `!!document.activeElement?.closest(${JSON.stringify(bar)})`,
      'focused Find in file field',
    )
    await keyInput('Input.insertText', { text })
    const selectionMatches = `(() => {
      const { state } = window.__mdxSmoke.editor();
      const { from, to } = state.selection.main;
      return state.sliceDoc(from, to) === ${JSON.stringify(text)};
    })()`
    await ready(selectionMatches, 'Find in file selects the matching MDX source text')
    await press('Escape', 'Escape', 27)
    await ready(
      `!document.querySelector(${JSON.stringify(bar)}) && ${editorFocused} && ${selectionMatches}`,
      'Find in file closed and returned focus to the selected MDX match',
    )
  }

  function cleanDiagnostics(page, deadline = performance.now() + interactionMs) {
    return untilDeadline(
      () =>
        page.evaluate(`
      [...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent.includes('syntax is valid')) &&
      window.__mdxSmoke.diagnostics().length === 0
    `),
      deadline,
      'clean diagnostics probe',
    )
  }

  function settledPaint(page, deadline = performance.now() + interactionMs) {
    return untilDeadline(
      () =>
        page.evaluate(
          `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
        ),
      deadline,
      'settled paint',
    )
  }

  function windowStatus(page, deadline = performance.now() + interactionMs) {
    return untilDeadline(
      () => page.evaluate(`window.holiSmoke.call('smoke:status')`),
      deadline,
      'native fixture status',
    )
  }

  return {
    delay,
    untilDeadline,
    waitFor,
    clickPointerAt,
    findInFile,
    cleanDiagnostics,
    settledPaint,
    windowStatus,
  }
}
