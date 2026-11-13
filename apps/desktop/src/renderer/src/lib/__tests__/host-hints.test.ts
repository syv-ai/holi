import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  discoverHostHintTargets,
  hintLabel,
  activateHostHint,
  hostHintsUnchanged,
} from '../host-hints'
import { installHintLayout } from '@/test/host-hint-layout'

let place: ReturnType<typeof installHintLayout>['place']
let root: HTMLElement
beforeEach(() => {
  ;({ place } = installHintLayout())
  root = document.createElement('section')
  root.dataset.pane = 'one'
  document.body.append(root)
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function button(name: string, parent = root) {
  const element = document.createElement('button')
  element.textContent = name
  parent.append(element)
  return element
}

it('assigns unique prefix-free labels for thousands of targets', () => {
  for (const count of [1, 26, 27, 52, 800, 3000]) {
    const labels = Array.from({ length: count }, (_, index) => hintLabel(index, count))
    expect(new Set(labels).size).toBe(count)
    expect(new Set(labels.map((label) => label.length)).size).toBe(1)
  }
  expect(hintLabel(0, 27)).toBe('aa')
  expect(hintLabel(26, 27)).toBe('sa')
})

it('includes shell chrome and the focused pane, not other split members', () => {
  button('Focused')
  button('Sidebar', document.body)
  const other = document.createElement('section')
  other.dataset.pane = 'two'
  document.body.append(other)
  button('Other', other)
  expect(discoverHostHintTargets(root).map(({ label }) => label)).toEqual(['Focused', 'Sidebar'])
})

it('excludes disabled, hidden, transparent, inert, covered, clipped and offscreen targets', () => {
  button('Visible')
  button('Disabled').disabled = true
  button('Hidden').hidden = true
  button('Transparent').style.opacity = '0'
  const inert = document.createElement('div')
  inert.inert = true
  inert.setAttribute('inert', '')
  root.append(inert)
  button('Inert', inert)
  const disabled = document.createElement('div')
  disabled.setAttribute('aria-disabled', 'true')
  root.append(disabled)
  button('Ancestor disabled', disabled)
  const covered = button('Covered')
  place(covered, 300, 100)
  const cover = document.createElement('div')
  root.append(cover)
  place(cover, 300, 100)
  const clip = document.createElement('div')
  clip.style.overflow = 'hidden'
  root.append(clip)
  place(clip, 500, 100, 100, 24)
  place(button('Clipped', clip), 700, 100)
  place(button('Offscreen'), -300, 100)
  expect(discoverHostHintTargets(root).map(({ label }) => label)).toEqual(['Visible'])
})

it('uses a visible edge when a control is partially clipped or covered', () => {
  const clip = document.createElement('div')
  clip.style.overflow = 'hidden'
  root.append(clip)
  place(clip, 0, 0, 50, 50)
  const edge = button('Edge', clip)
  place(edge, -20, 10, 100, 24)
  expect(discoverHostHintTargets(root).find(({ element }) => element === edge)?.x).toBe(25)
})

it('top portalled overlay excludes background and nested focused menu wins', () => {
  button('Background')
  const dialog = document.createElement('div')
  dialog.role = 'dialog'
  dialog.tabIndex = -1
  document.body.append(dialog)
  const dialogButton = button('Dialog', dialog)
  place(dialogButton, 300, 100)
  place(dialog, 290, 90, 200, 100)
  dialog.focus()
  expect(discoverHostHintTargets(root).map(({ label }) => label)).toEqual(['Dialog'])
  const menu = document.createElement('div')
  menu.role = 'menu'
  menu.tabIndex = -1
  document.body.append(menu)
  place(menu, 600, 100, 200, 100)
  const item = button('Nested', menu)
  place(item, 610, 110)
  item.focus()
  expect(discoverHostHintTargets(root).map(({ label }) => label)).toEqual(['Nested'])
})

it('accepts unlabeled controls and native checkbox, switch, combobox and cmdk targets', () => {
  button('')
  for (const role of ['switch', 'combobox', 'option', 'treeitem']) {
    const element = document.createElement('div')
    element.role = role
    root.append(element)
  }
  const input = document.createElement('input')
  input.type = 'checkbox'
  root.append(input)
  expect(discoverHostHintTargets(root)).toHaveLength(6)
})

it('revalidates removal, disabled state, geometry, coverage and new overlay before activation', () => {
  const run = button('Run')
  const click = vi.fn()
  run.addEventListener('click', click)
  const target = discoverHostHintTargets(root)[0]!
  expect(hostHintsUnchanged([target])).toBe(true)
  run.disabled = true
  expect(activateHostHint(target)).toBe(false)
  run.disabled = false
  place(run, 200, 200)
  expect(activateHostHint(target)).toBe(false)
  place(run, 10, 10, 180, 24)
  const overlay = document.createElement('div')
  overlay.role = 'dialog'
  document.body.append(overlay)
  button('Dialog', overlay)
  expect(activateHostHint(target)).toBe(false)
  overlay.remove()
  run.remove()
  expect(activateHostHint(target)).toBe(false)
  expect(click).not.toHaveBeenCalled()
})

it('focuses and activates once through pointer and click handlers including checkbox defaults', () => {
  const run = button('Run')
  const events: string[] = []
  run.addEventListener('pointerdown', () => events.push('down'))
  run.addEventListener('pointerup', () => events.push('up'))
  run.addEventListener('click', () => events.push('click'))
  expect(activateHostHint(discoverHostHintTargets(root)[0]!)).toBe(true)
  expect(document.activeElement).toBe(run)
  expect(events).toEqual(['down', 'up', 'click'])
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  root.append(checkbox)
  const target = discoverHostHintTargets(root).find(({ element }) => element === checkbox)!
  expect(activateHostHint(target)).toBe(true)
  expect(checkbox.checked).toBe(true)
})
