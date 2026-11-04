/**
 * A calendar event's description as markup, whichever shape it arrived in.
 *
 * **Every description goes through the one renderer** (`SandboxedHtml`): a
 * second rendering path is a second place for the sandbox to be forgotten, so
 * plain text is converted *into* the renderer's input. Google Calendar's editor
 * stores HTML, but API- or `.ics`-created events carry bare text whose newlines
 * HTML would collapse. `&` must be escaped first or it double-escapes the others.
 *
 * This is *not* sanitizing: the sanitizer downstream still decides what survives.
 * The Agenda keeps its own copy until it is retired for the calendar view.
 */
export function descriptionHtml(description: string): string {
  if (/<[a-z][^>]*>/i.test(description)) return description
  return description
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}
