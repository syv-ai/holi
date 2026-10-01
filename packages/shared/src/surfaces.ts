/**
 * What a surface's name may look like: a tab kind such as `board` or `mail`
 * (docs/features/tabs-panes.md).
 *
 * Only the spelling is checked here. Which surfaces exist is the renderer's
 * registry, which knows the plugins this vault runs, so a name that passes
 * this may still name nothing.
 */
const SURFACE_NAME = /^[a-z][a-z0-9-]*$/

export function isSurfaceName(value: string): boolean {
  return SURFACE_NAME.test(value)
}
