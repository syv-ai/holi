const BASE = 'https://syv-ai.github.io/holi/'
const FIELDS = new Set(['vault', 'path', 'heading'])

/** Validate the destination payload and construct only Holi's fixed app URL. */
export function handoffTarget(fragment) {
  if (typeof fragment !== 'string' || !fragment.startsWith('#') || fragment.length < 2) return null
  if (/%(?![\da-f]{2})/i.test(fragment)) return null
  const query = fragment.slice(1)
  try {
    for (const field of query.split('&')) {
      const separator = field.indexOf('=')
      const key = separator === -1 ? field : field.slice(0, separator)
      const value = separator === -1 ? '' : field.slice(separator + 1)
      decodeURIComponent(key.replace(/\+/g, ' '))
      decodeURIComponent(value.replace(/\+/g, ' '))
    }
  } catch {
    return null
  }
  const params = new URLSearchParams(query)
  const keys = [...params.keys()]
  if (
    keys.some((key) => !FIELDS.has(key)) ||
    ['vault', 'path', 'heading'].some((key) => params.getAll(key).length > 1)
  )
    return null
  const vault = params.get('vault')
  const path = params.get('path')?.normalize('NFC')
  const heading = params.get('heading')?.normalize('NFC').trim()
  if (!vault || !/^[\w.-]+\/[\w.-]+$/.test(vault) || vault.includes('..')) return null
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null
  const segments = path.split('/')
  if (segments.some((part) => part === '..' || part === '.' || !part)) return null
  if (segments.some((part) => /\.local\./.test(part) || /^\.(?:env|secrets)(?:\.|$)/i.test(part)))
    return null
  if (
    segments.some((part) => part === '.git' || part === 'node_modules') ||
    path.startsWith('.holi/state/')
  )
    return null
  if (heading !== undefined && heading.length > 200) return null
  const normalized = new URLSearchParams({ vault, path })
  if (heading) normalized.set('heading', heading)
  return `holi://open?${normalized.toString()}`
}

export function destinationLabel(fragment) {
  const target = handoffTarget(fragment)
  if (!target) return null
  const params = new URLSearchParams(target.slice(target.indexOf('?') + 1))
  return `${params.get('vault')} · ${params.get('path')}${params.has('heading') ? ` · ${params.get('heading')}` : ''}`
}

export function initializeHandoff({
  fragment,
  destination,
  message,
  button,
  navigate,
  setTimeout,
}) {
  const target = handoffTarget(fragment)
  const label = destinationLabel(fragment)
  if (!destination || !message || !button) return
  if (!target || !label) {
    destination.textContent = 'This sharing link is invalid or incomplete.'
    message.textContent = 'Ask the sender for a new Holi link.'
    return
  }
  destination.textContent = label
  button.href = target
  button.hidden = false
  message.textContent = 'Trying to open Holi. If nothing happens, use the button.'
  // Scheme navigation may be rejected by a browser; the explicit link remains available.
  try {
    navigate(target)
  } catch {
    message.textContent = 'Holi did not open? Use the button to try again.'
  }
  setTimeout(() => {
    message.textContent = 'Holi did not open? Use the button to try again.'
  }, 1200)
}

if (typeof document !== 'undefined') {
  initializeHandoff({
    fragment: location.hash,
    destination: document.querySelector('#destination'),
    message: document.querySelector('#message'),
    button: document.querySelector('#open'),
    navigate: (target) => {
      location.href = target
    },
    setTimeout: window.setTimeout.bind(window),
  })
}

export { BASE }
