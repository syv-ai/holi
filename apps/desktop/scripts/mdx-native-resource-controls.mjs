/** Native pointer controls shared by the external-resource acceptance drivers. */
export function createMdxNativeResourceControls(page, { waitFor, untilDeadline, clickPointerAt }) {
  const trigger = 'MDX resources'
  const button = (label, at = null) =>
    page.evaluate(`(() => {
    const match = Array.from(document.querySelectorAll('button,[role="button"]')).find(item =>
      (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(label)} &&
      !item.closest('[aria-hidden="true"],[inert]') && item.getClientRects().length &&
      getComputedStyle(item).visibility === 'visible' && !item.matches(':disabled,[aria-disabled="true"]'));
    if (!match) return null;
    const {x, y, width, height} = match.getBoundingClientRect();
    const point = ${JSON.stringify(at)} ?? {x: x + width / 2, y: y + height / 2};
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && match.contains(hit) ? point : null;
  })()`)
  const clickAt = (label, point, deadline) =>
    clickPointerAt(page, point, (at) => button(label, at), deadline)
  const click = async (label, deadline = performance.now() + 30000) => {
    const point = await waitFor(() => button(label), label, { deadline })
    await clickAt(label, point, deadline)
  }
  const openResources = async (expected, deadline = performance.now() + 30000) => {
    const read = (operation) => untilDeadline(operation, deadline, expected)
    for (;;) {
      const state = await waitFor(
        async () => {
          if (await read(() => button(expected))) return { ready: true }
          // Mutations may close the panel or leave it open while state refreshes.
          const open = await read(() =>
            page.evaluate(`Array.from(document.querySelectorAll('button')).some(item =>
          (item.getAttribute('aria-label') || item.textContent.trim()) === ${JSON.stringify(trigger)} &&
          (item.getAttribute('aria-expanded') === 'true' || item.getAttribute('data-state') === 'open'))`),
          )
          const point = !open && (await read(() => button(trigger)))
          return point ? { point } : false
        },
        expected,
        { deadline },
      )
      if (state.ready) return
      await clickAt(trigger, state.point, deadline)
    }
  }
  return { button, click, openResources }
}
