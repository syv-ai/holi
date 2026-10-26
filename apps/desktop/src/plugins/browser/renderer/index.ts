/**
 * The browser's renderer side (docs/features/browser.md): its tab, one per
 * page, kept mounted so a page keeps its place while another tab is up;
 * New Browser Tab in the command menu and the palette; and its pages kept
 * in step with main while the vault is open.
 */
import { GlobeIcon } from 'lucide-react'
import type { RendererPlugin } from '@/plugin-api'
import { BROWSER_INFO } from '../info'
import { BrowserSurface } from './browser-surface'
import {
  BROWSER_COMMANDS,
  BROWSER_SURFACE,
  browserEvents,
  browserMenuEntriesAtom,
  browserVault,
  runBrowserMenuEntryAtom,
  tabLooksAtom,
} from './state'

export const browserRenderer: RendererPlugin = {
  info: BROWSER_INFO,
  events: browserEvents,
  surfaces: [
    {
      kind: BROWSER_SURFACE,
      label: 'Browser',
      icon: GlobeIcon,
      render: BrowserSurface,
      keepMounted: true,
      unlisted: true,
      tabs: tabLooksAtom,
    },
  ],
  commands: BROWSER_COMMANDS,
  commandMenu: { entries: browserMenuEntriesAtom, run: runBrowserMenuEntryAtom },
  vault: browserVault,
}
