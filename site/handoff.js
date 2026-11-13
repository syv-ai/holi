const BASE = 'https://syv-ai.github.io/holi/'
const FIELDS = new Set(['vault', 'path', 'heading'])

/** Validate the destination payload and construct only Holi's fixed app URL. */
export function handoffTarget(fragment) {
  if (typeof fragment !== 'string' || !fragment.startsWith('#') || fragment.length < 2) return null
  if (/%(?![\da-f]{2})/i.test(fragment)) return null
  const params = new URLSearchParams(fragment.slice(1))
  const keys = [...params.keys()]
  if (
    keys.some((key) => !FIELDS.has(key)) ||
    ['vault', 'path', 'heading'].some((key) => params.getAll(key).length > 1)
  )
    return null
  const vault = params.get('vault')
  const path = params.get('path')
  const heading = params.get('heading')
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
  if (heading !== null && heading.trim().length > 200) return null
  return `holi://open?${params.toString()}`
}

export function destinationLabel(fragment) {
  const target = handoffTarget(fragment)
  if (!target) return null
  const params = new URLSearchParams(target.slice(target.indexOf('?') + 1))
  return `${params.get('vault')} · ${params.get('path')}${params.has('heading') ? ` · ${params.get('heading')}` : ''}`
}

if (typeof document !== 'undefined') {
  const target = handoffTarget(location.hash)
  const destination = document.querySelector('#destination')
  const message = document.querySelector('#message')
  const button = document.querySelector('#open')
  if (destination && message && button) {
    const label = destinationLabel(location.hash)
    if (!target || !label) {
      destination.textContent = 'This sharing link is invalid or incomplete.'
      message.textContent = 'Ask the sender for a new Holi link.'
    } else {
      destination.textContent = label
      button.href = target
      button.hidden = false
      message.textContent = 'Trying to open Holi. If nothing happens, use the button.'
      // The page itself has no external targets; this fixed scheme is the only handoff.
      location.href = target
      window.setTimeout(() => {
        message.textContent = 'Holi did not open? Use the button to try again.'
      }, 1200)
    }
  }
}

export { BASE }
