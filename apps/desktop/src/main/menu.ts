/**
 * The application menu — Electron's default, plus a **Developer** menu in dev.
 *
 * Holi had no application menu at all, which meant it ran on Electron's stock
 * one. That matters here: `setApplicationMenu` **replaces** the menu wholesale,
 * so a template carrying only a Developer submenu would silently delete Edit —
 * and with it ⌘X/⌘C/⌘V, Undo, and Select All, none of which the app implements
 * itself. So the template restates the standard roles and adds one submenu.
 * Everything except Developer is exactly what Electron would have built.
 *
 * **Developer is dev-only** (`app.isPackaged`). Its one item stands up the
 * onboarding ritual against nothing — no repo, no vault, no writes — which is a
 * tool for whoever is building the ritual, not a thing to hand someone who just
 * installed Holi. Shipping it is a one-line change if that judgement is wrong.
 *
 * **File is spelled out rather than taken from the `fileMenu` role.** The stock
 * one is a single *Close Window* on ⌘W, and a menu accelerator fires before the
 * renderer ever sees the key — so ⌘W closed the window, which in a
 * tray-resident app reads as "quits", and no renderer handler could take it
 * back while the menu held it. Here ⌘W is *Close Tab*, sent to the renderer,
 * and the window closes on ⌘⇧W (VS Code's convention) or its traffic light.
 */
import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** Main → renderer: open the ritual in dry-run mode. */
export const TEST_ONBOARDING_CHANNEL = 'dev:test-onboarding'

/**
 * Main → renderer: a menu item ran, carrying the id of a row in the renderer's
 * command table (`state/commands.ts`, D102). The renderer decides what the id
 * means — which tab ⌘W closes, say — because main has no notion of panes.
 */
export const MENU_COMMAND_CHANNEL = 'menu:command'

function fileMenu(getWindow: () => BrowserWindow | null): MenuItemConstructorOptions {
  const isMac = process.platform === 'darwin'
  return {
    label: 'File',
    submenu: [
      {
        label: 'Close Tab',
        accelerator: 'CmdOrCtrl+W',
        click: () => getWindow()?.webContents.send(MENU_COMMAND_CHANNEL, 'tab.close'),
      },
      { type: 'separator' },
      { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      // Quit lives in the app menu on macOS; the stock File menu carries it
      // everywhere else, and losing it would leave the tray as the only exit.
      ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
    ],
  }
}

function developerMenu(getWindow: () => BrowserWindow | null): MenuItemConstructorOptions {
  return {
    label: 'Developer',
    submenu: [
      {
        label: 'Test onboarding',
        // No accelerator: it is a deliberate act, not something to hit by
        // accident while typing in a note.
        click: () => getWindow()?.webContents.send(TEST_ONBOARDING_CHANNEL),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
    ],
  }
}

/**
 * Install the application menu. Call once, after the first window exists.
 *
 * `getWindow` rather than a window instance: the menu outlives any particular
 * window (the app keeps running with none, which is what the tray is for), so
 * holding a reference here would send to a destroyed `webContents`.
 */
export function installAppMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // `appMenu` is the About/Services/Hide/Quit block macOS expects under the
    // app's own name. It does not exist on other platforms.
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    fileMenu(getWindow),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(app.isPackaged ? [] : [developerMenu(getWindow)]),
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
