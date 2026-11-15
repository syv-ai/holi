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

  // Native textarea/input editing stays in this isolated world. The host
  // configures one specific document and revisions only move forward.
  const newVimNonce = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let vimNonce = newVimNonce()
  let vimEnabled = false
  let vimMode = 'insert'
  let vimRevision = 0
  let vimField = null
  let verticalColumn = null
  const vimTypes = new Set(['text', 'search', 'url', 'tel'])
  const nativeTextTags = new Set(['DIV', 'SPAN', 'P', 'LABEL'])
  const plainHost = (el) => {
    const editorSelector =
      '[role="textbox"], [data-lexical-editor], [data-slate-editor], [data-tiptap-editor], .ProseMirror, .CodeMirror'
    if (
      !(el instanceof HTMLElement) ||
      !nativeTextTags.has(el.tagName) ||
      el.localName.includes('-') ||
      el.getAttribute('contenteditable')?.toLowerCase() !== 'plaintext-only' ||
      ![...el.childNodes].every((node) => node.nodeType === Node.TEXT_NODE) ||
      /[\r\n]/u.test(el.textContent) ||
      document.designMode === 'on' ||
      el.matches(editorSelector) ||
      el.querySelector(editorSelector)
    )
      return false
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const editable = parent.getAttribute('contenteditable')?.toLowerCase()
      if ((editable != null && editable !== 'false') || parent.matches(editorSelector)) return false
    }
    return true
  }
  const vimEligible = (el) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && vimTypes.has(el.type)) ||
    plainHost(el)
  const resetOwnership = () => {
    vimMode = 'insert'
    verticalColumn = null
  }
  const invalidatesPlainHost = (record, host) => {
    const changed = record.target
    if (changed === host || host.contains(changed)) return true
    if (record.type === 'attributes' && changed.nodeType === 1 && changed.contains(host))
      return true
    return (
      record.type === 'childList' &&
      [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === host || (node.nodeType === 1 && node.contains(host)),
      )
    )
  }
  const flushPlainHostMutations = () => {
    if (!vimField || vimField.nodeType !== 1 || !plainHost(vimField)) return false
    const records = plainHostObserver.takeRecords()
    if (records.some((record) => invalidatesPlainHost(record, vimField))) {
      resetOwnership()
      return true
    }
    return false
  }
  const plainHostObserver = new MutationObserver((records) => {
    if (
      vimField &&
      vimField.nodeType === 1 &&
      records.some((record) => invalidatesPlainHost(record, vimField))
    )
      resetOwnership()
  })
  plainHostObserver.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'contenteditable',
      'role',
      'class',
      'data-lexical-editor',
      'data-slate-editor',
      'data-tiptap-editor',
    ],
  })
  const eligibleNow = () => {
    flushPlainHostMutations()
    const eligible =
      vimEnabled &&
      vimField !== null &&
      document.activeElement === vimField &&
      vimField.isConnected &&
      !vimField.disabled &&
      !vimField.readOnly &&
      vimEligible(vimField) &&
      vimField.getRootNode() === document &&
      (!plainHost(vimField) || selectionFor(vimField) !== null)
    if (!eligible) {
      vimMode = 'insert'
      verticalColumn = null
    }
    return eligible
  }
  const selectionFor = (host) => {
    if (!plainHost(host)) return null
    const selection = host.ownerDocument.getSelection()
    if (
      !selection ||
      selection.rangeCount !== 1 ||
      !selection.anchorNode ||
      !selection.focusNode ||
      (!host.contains(selection.anchorNode) && selection.anchorNode !== host) ||
      (!host.contains(selection.focusNode) && selection.focusNode !== host)
    )
      return null
    const offsetOf = (node, offset) => {
      let total = 0
      for (const child of host.childNodes) {
        if (child === node) return total + (node.nodeType === Node.TEXT_NODE ? offset : 0)
        total += child.textContent.length
      }
      return node === host
        ? [...host.childNodes]
            .slice(0, offset)
            .reduce((n, child) => n + child.textContent.length, 0)
        : null
    }
    const range = selection.getRangeAt(0)
    const start = offsetOf(range.startContainer, range.startOffset)
    const end = offsetOf(range.endContainer, range.endOffset)
    return start === null || end === null ? null : { selection, start, end }
  }
  const placeCaret = (host, offset) => {
    let remaining = Math.max(0, Math.min(host.textContent.length, offset))
    const range = host.ownerDocument.createRange()
    for (const child of host.childNodes) {
      const length = child.textContent.length
      if (remaining <= length) {
        range.setStart(child, remaining)
        range.collapse(true)
        const selection = host.ownerDocument.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      remaining -= length
    }
    range.setStart(host, host.childNodes.length)
    range.collapse(true)
    const selection = host.ownerDocument.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const fieldValue = (el) => (plainHost(el) ? el.textContent : el.value)
  const fieldSelection = (el) => {
    if (!plainHost(el))
      return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? el.selectionStart ?? 0 }
    const selection = selectionFor(el)
    return selection ? { start: selection.start, end: selection.end } : null
  }
  const setCaret = (el, offset) => (plainHost(el) ? placeCaret(el, offset) : move(el, offset))
  const graphemes = (value) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return [...segmenter.segment(value)].map(({ index, segment }) => ({
      index,
      end: index + segment.length,
      text: segment,
    }))
  }
  const boundaries = (value) => [0, ...graphemes(value).map((part) => part.end)]
  const previous = (value, at) =>
    boundaries(value)
      .filter((n) => n < at)
      .at(-1) ?? 0
  const next = (value, at) => boundaries(value).find((n) => n > at) ?? value.length
  const move = (el, at) =>
    el.setSelectionRange(
      Math.max(0, Math.min(el.value.length, at)),
      Math.max(0, Math.min(el.value.length, at)),
    )
  const lineStart = (value, at) => (at === 0 ? 0 : value.lastIndexOf('\n', at - 1) + 1)
  const lineEnd = (value, at) => {
    const end = value.indexOf('\n', at)
    return end < 0 ? value.length : end
  }
  const firstNonblank = (value, at) => {
    const start = lineStart(value, at)
    const line = value.slice(start, lineEnd(value, at))
    return start + (line.match(/^\s*/u)?.[0].length ?? 0)
  }
  const wordSegments = (value) =>
    [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(value)].filter(
      (part) => part.isWordLike,
    )
  const wordForward = (value, at) => {
    const parts = wordSegments(value)
    const current = parts.find((part) => part.index <= at && part.index + part.segment.length > at)
    return (
      parts.find((part) => part.index > at || (current && part.index > current.index))?.index ??
      value.length
    )
  }
  const wordBackward = (value, at) => {
    const parts = wordSegments(value)
    const current = parts.find((part) => part.index < at && part.index + part.segment.length > at)
    return current?.index ?? parts.filter((part) => part.index < at).at(-1)?.index ?? 0
  }
  const wordEnd = (value, at) => {
    const part = wordSegments(value).find((item) => {
      const end = item.index + (boundaries(item.segment).at(-2) ?? 0)
      return end > at
    })
    return part ? part.index + (boundaries(part.segment).at(-2) ?? 0) : at
  }
  const verticalMove = (target, at, direction) => {
    const value = target.value
    const start = lineStart(value, at)
    const column = verticalColumn ?? graphemes(value.slice(start, at)).length
    let adjacentStart
    if (direction === 'down') {
      const end = lineEnd(value, at)
      if (end === value.length) return at
      adjacentStart = end + 1
    } else {
      if (start === 0) return at
      adjacentStart = lineStart(value, start - 1)
    }
    const end = lineEnd(value, adjacentStart)
    const stops = boundaries(value.slice(adjacentStart, end))
    return adjacentStart + (stops[Math.min(column, stops.length - 1)] ?? 0)
  }
  const onVimKey = (event) => {
    const target = event.target
    flushPlainHostMutations()
    if (
      !vimEnabled ||
      !vimEligible(target) ||
      target.disabled ||
      target.readOnly ||
      document.activeElement !== target ||
      target.getRootNode() !== document ||
      target.ownerDocument !== document
    ) {
      if (vimField === target) resetOwnership()
      return
    }
    if (vimField !== target) {
      vimField = target
      vimMode = 'insert'
      verticalColumn = null
    }
    const selection = fieldSelection(target)
    if (selection === null) {
      resetOwnership()
      return
    }
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    if (vimMode === 'insert') {
      if (event.key === 'Escape') {
        event.preventDefault()
        vimMode = 'normal'
        verticalColumn = null
      }
      return
    }
    if (
      event.shiftKey &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
    )
      return
    const value = fieldValue(target)
    const at = selection.start
    const end = selection.end
    const key = event.key
    let destination = at
    let enteringInsert = false
    if (key === 'i') enteringInsert = true
    else if (key === 'a') {
      destination = next(value, end)
      enteringInsert = true
    } else if (key === 'I') {
      destination = firstNonblank(value, at)
      enteringInsert = true
    } else if (key === 'A') {
      destination = lineEnd(value, at)
      enteringInsert = true
    } else if (key === 'h') destination = previous(value, at)
    else if (key === 'l') destination = next(value, at)
    else if (key === '0') destination = lineStart(value, at)
    else if (key === '^') destination = firstNonblank(value, at)
    else if (key === '$') destination = lineEnd(value, at)
    else if (key === 'w') destination = wordForward(value, at)
    else if (key === 'b') destination = wordBackward(value, at)
    else if (key === 'e') destination = wordEnd(value, at)
    else if (key === 'j' && target instanceof HTMLTextAreaElement)
      destination = verticalMove(target, at, 'down')
    else if (key === 'k' && target instanceof HTMLTextAreaElement)
      destination = verticalMove(target, at, 'up')
    else if (key === 'Escape') {
      event.preventDefault()
      return
    } else {
      // Normal mode does not let editing or printable keys reach the browser.
      if (
        key.length === 1 ||
        [
          'Backspace',
          'Delete',
          'Enter',
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
        ].includes(key)
      )
        event.preventDefault()
      return
    }
    event.preventDefault()
    if (enteringInsert) {
      setCaret(target, destination)
      vimMode = 'insert'
      verticalColumn = null
      return
    }
    setCaret(target, destination)
    verticalColumn =
      key === 'j' || key === 'k'
        ? (verticalColumn ?? graphemes(value.slice(lineStart(value, at), at)).length)
        : null
  }
  document.addEventListener(
    'focusin',
    (event) => {
      if (
        vimEnabled &&
        vimEligible(event.target) &&
        event.target.getRootNode() === document &&
        !event.target.disabled &&
        !event.target.readOnly
      ) {
        plainHostObserver.takeRecords()
        vimField = event.target
        vimMode = 'insert'
        verticalColumn = null
      }
    },
    true,
  )
  document.addEventListener(
    'focusout',
    (event) => {
      if (vimField === event.target) {
        vimField = null
        vimMode = 'insert'
        verticalColumn = null
      }
    },
    true,
  )
  document.addEventListener(
    'selectionchange',
    () => {
      if (vimField && vimField.nodeType === 1 && plainHost(vimField) && !selectionFor(vimField))
        resetOwnership()
    },
    true,
  )
  document.addEventListener('keydown', onVimKey, true)
  const vim = {
    documentNonce() {
      return vimNonce
    },
    rearm() {
      vimNonce = newVimNonce()
      vimEnabled = false
      vimMode = 'insert'
      vimField = null
      verticalColumn = null
      return vimNonce
    },
    configure(enabled, revision, nonce) {
      if (
        nonce !== vimNonce ||
        typeof enabled !== 'boolean' ||
        !Number.isSafeInteger(revision) ||
        revision <= vimRevision
      )
        return false
      vimRevision = revision
      vimEnabled = enabled
      vimMode = 'insert'
      vimField = null
      verticalColumn = null
      return true
    },
    reset(revision, nonce) {
      return this.configure(false, revision, nonce)
    },
    mode() {
      return { revision: vimRevision, mode: eligibleNow() ? vimMode : 'insert' }
    },
  }
  globalThis.__holiPage = { refs: [null], read, point, click, focus, valueOf, fill, scroll, vim }
})()
