import test from 'node:test'
import assert from 'node:assert/strict'
import { destinationLabel, handoffTarget, initializeHandoff } from './handoff.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

test('builds fixed holi destination preserving unicode and reserved characters', () => {
  const fragment =
    '#vault=syv-ai/team-notes&path=notes/Caf%C3%A9%20%26%20%231.md&heading=next-steps'
  assert.equal(
    handoffTarget(fragment),
    'holi://open?vault=syv-ai%2Fteam-notes&path=notes%2FCaf%C3%A9+%26+%231.md&heading=next-steps',
  )
  assert.equal(destinationLabel(fragment), 'syv-ai/team-notes · notes/Café & #1.md · next-steps')
})

test('does not create a target for absent, malformed, ambiguous, or unsafe input', () => {
  for (const fragment of [
    '',
    '#',
    '#vault=x&path=y',
    '#vault=a/b&vault=c/d&path=x.md',
    '#vault=a/b&path=x.md&redirect=https://evil.test',
    '#vault=a/b&path=%ZZ',
    '#vault=a/b&path=../x.md',
    '#vault=a/b&path=.env',
    '#vault=a/b&path=notes/x.local.md',
    '#vault=a/b&path=.holi/state/x',
    '#vault=a/b&path=x.md&heading=' + 'h'.repeat(201),
    '#vault=a/b&path=%FF',
    '#vault=a/b&path=notes/%C3%28.md',
    '#vault=a/b&path=%FF',
    '#vault=a/b&path=notes%2F%FF.md',
  ]) {
    assert.equal(handoffTarget(fragment), null, fragment)
    assert.equal(destinationLabel(fragment), null, fragment)
  }
})

test('matches shared parsing normalization for path and heading', () => {
  assert.equal(
    handoffTarget('#vault=a/b&path=notes/Cafe%CC%81.md&heading=+Cafe%CC%81+'),
    'holi://open?vault=a%2Fb&path=notes%2FCaf%C3%A9.md&heading=Caf%C3%A9',
  )
  assert.equal(
    handoffTarget('#vault=a/b&path=x.md&heading=+++'),
    'holi://open?vault=a%2Fb&path=x.md',
  )
})

function render(fragment, navigate = () => {}, timers = []) {
  const elements = {
    destination: { textContent: '' },
    message: { textContent: '' },
    button: { href: '', hidden: true },
  }
  initializeHandoff({
    fragment,
    ...elements,
    navigate,
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  })
  return elements
}

test('renders valid destination, explicit fallback and automatic launch timeout', () => {
  const timers = []
  const destinations = []
  const elements = render(
    '#vault=a/b&path=notes/one.md',
    (target) => destinations.push(target),
    timers,
  )
  assert.equal(elements.destination.textContent, 'a/b · notes/one.md')
  assert.equal(elements.button.hidden, false)
  assert.equal(elements.button.href, destinations[0])
  assert.equal(
    elements.message.textContent,
    'Trying to open Holi. If nothing happens, use the button.',
  )
  assert.equal(timers[0].delay, 1200)
  timers[0].callback()
  assert.match(elements.message.textContent, /Use the button/)
})

test('invalid destination stays on the page without attempting launch', () => {
  let launched = false
  const elements = render('#vault=a/b&path=%FF', () => (launched = true))
  assert.equal(elements.destination.textContent, 'This sharing link is invalid or incomplete.')
  assert.equal(elements.button.hidden, true)
  assert.equal(launched, false)
})

test('browser bootstrap refreshes the current fragment on hash changes', async () => {
  const elements = {
    destination: { textContent: '' },
    message: { textContent: '' },
    button: { href: '', hidden: true },
  }
  const listeners = new Map()
  const timers = []
  const launches = []
  const location = {
    hash: '#vault=a/b&path=notes/one.md',
    set href(target) {
      launches.push(target)
    },
  }
  globalThis.document = {
    querySelector: (selector) =>
      ({
        '#destination': elements.destination,
        '#message': elements.message,
        '#open': elements.button,
      })[selector],
  }
  globalThis.location = location
  globalThis.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
  }

  try {
    await import(`${pathToFileURL(resolve('site/handoff.js')).href}?bootstrap-test`)
    assert.equal(listeners.has('hashchange'), true)
    const hashchange = listeners.get('hashchange')
    assert.equal(elements.destination.textContent, 'a/b · notes/one.md')
    assert.equal(elements.button.href, handoffTarget(location.hash))

    location.hash = '#vault=a/b&path=notes/two.md'
    hashchange()
    assert.equal(elements.destination.textContent, 'a/b · notes/two.md')
    assert.equal(elements.button.href, handoffTarget(location.hash))
    assert.equal(launches.at(-1), handoffTarget(location.hash))

    location.hash = '#vault=a/b&path=%FF'
    hashchange()
    assert.equal(elements.destination.textContent, 'This sharing link is invalid or incomplete.')
    assert.equal(elements.button.hidden, true)
    assert.equal(elements.button.href, '')
    const invalidMessage = elements.message.textContent
    timers[0].callback()
    assert.equal(elements.message.textContent, invalidMessage)

    location.hash = '#vault=c/d&path=notes/three.md'
    hashchange()
    assert.equal(elements.destination.textContent, 'c/d · notes/three.md')
    assert.equal(elements.button.hidden, false)
    assert.equal(elements.button.href, handoffTarget(location.hash))
  } finally {
    delete globalThis.document
    delete globalThis.location
    delete globalThis.window
  }
})

test('a rejected automatic launch leaves the visible fallback working', () => {
  const timers = []
  const target = handoffTarget('#vault=a/b&path=notes/one.md')
  const elements = render(
    '#vault=a/b&path=notes/one.md',
    () => {
      throw new Error('blocked')
    },
    timers,
  )
  assert.equal(elements.button.hidden, false)
  assert.equal(elements.button.href, target)
  assert.match(elements.message.textContent, /Use the button/)
  timers[0].callback()
  assert.match(elements.message.textContent, /Use the button/)
})
