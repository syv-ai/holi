/**
 * One focus treatment, app-wide.
 *
 * The app had drifted to four: shadcn's default 3px halo *plus* a recoloured
 * border on the form primitives, `ring-2` on the dialog's ✕, `ring-1` with an
 * offset on the resize handle, and `ring-0` on four bare inline fields — which
 * opted out so completely that a focused field showed nothing at all.
 *
 * The rule now: **a control recolours its own edge.** Where there is no edge to
 * recolour (a filled or ghost button, an icon button, a 1px handle), it draws
 * the thinnest one there is. Nothing grows on focus, so nothing shifts.
 *
 * This is a source scan rather than a render test on purpose: the failure mode
 * is a new component pasted in from shadcn upstream carrying the old halo, and
 * no rendering test would catch what has not been mounted anywhere yet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../src/renderer/src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full)
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

const files = sources(ROOT).map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }))

/** Every `focus-visible:` utility the renderer uses, with where it came from. */
const used = files.flatMap(({ path, text }) =>
  [...text.matchAll(/focus-visible:[a-z0-9:/[\]#.-]+/g)].map((m) => ({ path, cls: m[0] })),
)

describe('the focus treatment is one treatment', () => {
  it('grows nothing on focus — no halo, anywhere', () => {
    // A ring thicker than a hairline is the "thick border" this replaced, and
    // an offset floats the mark off the element it belongs to.
    const halos = used.filter(({ cls }) => /ring-\[|ring-[2-9]|ring-offset/.test(cls))
    expect(halos).toEqual([])
  })

  it('draws focus from the ring token, never a literal colour', () => {
    const literal = used.filter(({ cls }) => /#|\b(sky|blue|amber|red|slate|zinc|gray)-/.test(cls))
    expect(literal).toEqual([])
  })

  it('uses only the agreed vocabulary', () => {
    // `outline-none`/`outline-hidden` are the browser default being cleared, and
    // `opacity-100` is a hover affordance that focus also triggers — neither is
    // a focus *indicator*, so both are allowed alongside the three that are.
    const allowed = new Set([
      'focus-visible:border-ring',
      'focus-visible:ring-1',
      'focus-visible:ring-ring',
      'focus-visible:ring-0',
      'focus-visible:outline-none',
      'focus-visible:outline-hidden',
      'focus-visible:opacity-100',
    ])
    const strays = [...new Set(used.filter(({ cls }) => !allowed.has(cls)).map((u) => `${u.cls} (${u.path})`))]
    expect(strays).toEqual([])
  })

  it('leaves no control silent on focus', () => {
    // `ring-0` is only ever an opt-out in favour of a recoloured border; on its
    // own it means a focused control shows nothing, which is how four inline
    // fields ended up with no indicator at all.
    const silent = files.flatMap(({ path, text }) =>
      text
        .split(/["'`]/)
        .filter((cls) => cls.includes('focus-visible:ring-0'))
        .filter((cls) => !cls.includes('focus-visible:border-ring'))
        .map((cls) => `${path}: ${cls.trim().slice(0, 60)}`),
    )
    expect(silent).toEqual([])
  })
})
