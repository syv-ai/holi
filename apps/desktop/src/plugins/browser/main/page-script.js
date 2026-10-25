/**
 * What main runs inside a web page to read it and find its controls
 * (docs/features/browser.md, The agent). Shipped as text (`?raw`) and run in
 * an isolated world, so the page's own scripts can neither see these
 * functions nor the numbers they hand out: they share the page's DOM and
 * nothing else.
 *
 * `read` walks the page in reading order and writes it as plain text, each
 * control it could be asked to use numbered: `[3] button "Sign in"`. The
 * numbers are kept here, so `point`, `focus` and `fill` find the same
 * element until the next read or the page is left. Hidden things are left
 * out: what the person cannot see, the agent is not told about.
 *
 * Defines `globalThis.__holiPage` once per world; each call is an expression
 * main appends (`__holiPage.read(12000)`).
 */
;(() => {
  if (globalThis.__holiPage !== undefined) return

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK'])
  const BLOCK = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BODY',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TR',
    'UL',
    'BR',
  ])
  const ROLES = new Set([
    'button',
    'link',
    'checkbox',
    'radio',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'switch',
    'option',
    'combobox',
    'textbox',
    'searchbox',
    'slider',
  ])
  const NAME_MAX = 80

  const squash = (text) => (text || '').replace(/\s+/g, ' ').trim()
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  const quoted = (text) => `"${clip(squash(text), NAME_MAX).replace(/"/g, "'")}"`

  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
    if (el.tagName === 'INPUT' && el.type === 'hidden') return true
    if (typeof el.checkVisibility === 'function') {
      return !el.checkVisibility({ visibilityProperty: true, opacityProperty: false })
    }
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    return style.display === 'none' || style.visibility === 'hidden'
  }

  /** The control's role, or null for an element that is not one. */
  function roleOf(el) {
    const role = (el.getAttribute('role') || '').toLowerCase()
    if (ROLES.has(role)) return role
    switch (el.tagName) {
      case 'A':
        return el.hasAttribute('href') ? 'link' : null
      case 'BUTTON':
      case 'SUMMARY':
        return 'button'
      case 'SELECT':
        return 'select'
      case 'TEXTAREA':
        return 'textbox'
      case 'INPUT': {
        const type = (el.type || 'text').toLowerCase()
        if (type === 'checkbox' || type === 'radio') return type
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
        return type === 'search' ? 'searchbox' : 'textbox'
      }
      default:
        return el.isContentEditable && el.getAttribute('contenteditable') !== null
          ? 'textbox'
          : null
    }
  }

  function labelText(el) {
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
        .join(' ')
      if (squash(text)) return text
    }
    if (el.labels && el.labels.length > 0) return el.labels[0].textContent
    return ''
  }

  function nameOf(el) {
    const candidates = [
      el.getAttribute('aria-label'),
      labelText(el),
      el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '',
      el.getAttribute('alt'),
      el.querySelector?.('img[alt]')?.getAttribute('alt'),
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? '' : (el.innerText ?? el.textContent),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
    ]
    for (const c of candidates) if (squash(c)) return c
    return ''
  }

  /** Where a link goes, short: a path on the same site, else the address. */
  function target(el) {
    const href = el.getAttribute('href') || ''
    if (href.startsWith('#') || href.startsWith('javascript:')) return ''
    try {
      const url = new URL(href, el.ownerDocument.baseURI)
      const here = el.ownerDocument.location
      const short = url.origin === here.origin ? url.pathname + url.search : url.href
      return clip(short, 100)
    } catch {
      return ''
    }
  }

  function describe(el, role, n) {
    let line = `[${n}] ${role}`
    const name = nameOf(el)
    if (name) line += ` ${quoted(name)}`
    if (role === 'link') {
      const to = target(el)
      if (to) line += ` → ${to}`
    }
    if (role === 'textbox' || role === 'searchbox') {
      const type = el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : ''
      if (type && type !== 'text' && type !== 'search') line += ` (${type})`
      const value = el.isContentEditable ? el.innerText : el.value
      // A password is never read back out.
      if (type !== 'password' && squash(value)) line += ` value=${quoted(value)}`
      const hint = el.getAttribute('placeholder')
      if (hint && squash(hint) !== squash(name)) line += ` placeholder=${quoted(hint)}`
    }
    if (role === 'select' && el.selectedOptions && el.selectedOptions.length > 0) {
      line += ` value=${quoted(el.selectedOptions[0].textContent)}`
      const options = [...el.options].map((o) => squash(o.textContent)).filter(Boolean)
      if (options.length > 0) line += ` options=${quoted(options.slice(0, 12).join(' | '))}`
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const on = el.checked ?? el.getAttribute('aria-checked') === 'true'
      line += on ? ' (checked)' : ' (not checked)'
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)'
    return line
  }

  function read(max) {
    const doc = document
    const refs = [null]
    const lines = []
    let line = ''
    let size = 0
    let truncated = false

    const flush = () => {
      const text = squash(line)
      line = ''
      if (!text || truncated) return
      if (size + text.length + 1 > max) {
        truncated = true
        return
      }
      lines.push(text)
      size += text.length + 1
    }

    const walk = (node, prefix) => {
      if (truncated) return
      if (node.nodeType === 3) {
        line += node.nodeValue
        return
      }
      if (node.nodeType !== 1) return
      const el = node
      if (SKIP.has(el.tagName) || hidden(el)) return
      if (el.tagName === 'IFRAME') {
        flush()
        line = '[frame, not read]'
        flush()
        return
      }
      const role = roleOf(el)
      if (role !== null) {
        refs.push(el)
        line += ` ${describe(el, role, refs.length - 1)} `
        // Its text is its name; a big clickable card still has its words read.
        if (role !== 'link' && role !== 'button') return
        if (squash(el.innerText ?? el.textContent).length <= NAME_MAX) return
      }
      const block = BLOCK.has(el.tagName)
      if (block) flush()
      const heading = /^H([1-6])$/.exec(el.tagName)
      if (heading) line += `${'#'.repeat(Number(heading[1]))} `
      if (el.tagName === 'LI') line += `${prefix}- `
      if (el.tagName === 'IMG' && squash(el.getAttribute('alt'))) {
        line += ` [image ${quoted(el.getAttribute('alt'))}] `
      }
      if (el.tagName === 'TD' || el.tagName === 'TH') line += ' | '
      const inner = el.tagName === 'UL' || el.tagName === 'OL' ? `${prefix}  ` : prefix
      for (const child of el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes) {
        walk(child, inner)
      }
      if (block) flush()
    }

    walk(doc.body ?? doc.documentElement, '')
    flush()
    globalThis.__holiPage.refs = refs
    return { title: doc.title, url: doc.location.href, text: lines.join('\n'), truncated }
  }

  /** The element numbered `ref` by the last read, if it is still on the page. */
  function find(ref) {
    const el = globalThis.__holiPage.refs[ref]
    return el && el.isConnected ? el : null
  }

  /** Bring `ref` into view and say where its middle is, in the page's own
   *  pixels, and whether a click there lands on it. Null when it is gone. */
  function point(ref) {
    const el = find(ref)
    if (el === null) return null
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    const lands = hit !== null && (hit === el || el.contains(hit) || hit.contains(el))
    return { x, y, width: rect.width, height: rect.height, lands }
  }

  /** Click `ref` from script: for a page Holi is not drawing, or a control
   *  something else covers. */
  function click(ref) {
    const el = find(ref)
    if (el === null) return false
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    if (typeof el.focus === 'function') el.focus()
    el.click()
    return true
  }

  /** Focus `ref` and select what it holds, so typing replaces it. */
  function focus(ref) {
    const el = find(ref)
    if (el === null) return false
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    el.focus()
    if (typeof el.select === 'function') el.select()
    else if (el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }
    return document.activeElement === el || el.contains(document.activeElement)
  }

  /** What `ref` holds now, to check that typing reached it. */
  function valueOf(ref) {
    const el = find(ref)
    if (el === null) return null
    return el.isContentEditable ? el.innerText : (el.value ?? null)
  }

  /** Set `ref`'s value as if typed, for a field that typing did not reach.
   *  A choice in a select is picked by its text or its value. */
  function fill(ref, text) {
    const el = find(ref)
    if (el === null) return false
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find(
        (o) => squash(o.textContent) === squash(text) || o.value === text,
      )
      if (option === undefined) return false
      el.value = option.value
    } else if (el.isContentEditable) {
      el.textContent = text
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
      if (setter) setter.call(el, text)
      else el.value = text
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  function scroll(to) {
    const page = document.scrollingElement ?? document.documentElement
    const step = Math.round(innerHeight * 0.8)
    if (to === 'top') page.scrollTo({ top: 0, behavior: 'instant' })
    else if (to === 'bottom') page.scrollTo({ top: page.scrollHeight, behavior: 'instant' })
    else page.scrollBy({ top: to === 'up' ? -step : step, behavior: 'instant' })
    const atEnd = page.scrollTop + innerHeight >= page.scrollHeight - 2
    return { top: Math.round(page.scrollTop), atTop: page.scrollTop <= 0, atEnd }
  }

  globalThis.__holiPage = { refs: [null], read, point, click, focus, valueOf, fill, scroll }
})()
