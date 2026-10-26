/** Open a web address (or `mailto:`) in the system's own app. The one way the
 *  renderer leaves the page: main checks the scheme (`holi:openExternal`).
 *  Plugins reach it as `openExternal` from `@/plugin-api`. */
export function openExternal(url: string): void {
  void window.holi?.openExternal(url)
}
