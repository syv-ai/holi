# foliate-js, vendored

The EPUB engine behind Read all the things (docs/features/reader.md). Copied
from https://github.com/johnfactotum/foliate-js at commit
`78914aef4466eb960965702401634c2cb348e9b1`, MIT (`license`, upstream's LICENSE). The `foliate-js`
package on npm is not published by its author, so the files live here.

Copied: `view.js` and every module it imports, except `pdf.js` and its bundled
PDF.js. Not copied: the reader UI, `opds.js`, `dict.js`, `footnotes.js`,
`quote-image.js`, `vendor/pdfjs/`, the tests and the build.

Holi's changes, all three of them, to re-apply on an update:

1. `paginator.js` and `fixed-layout.js` create their iframes with
   `sandbox="allow-same-origin"`, not `allow-same-origin allow-scripts`. The
   upstream comment says scripts are allowed for a WebKit bug; Electron is
   Chromium, and a book's script must never run. `test/foliate-sandbox.test.ts`
   fails if any `sandbox` here grants more.
2. `paginator.js`'s `getBackground` copies only the chapter's background
   colour onto the paginator's own background element, not the whole
   `background`. That element is in Holi's document, outside the chapter's
   policy, so a chapter's `url()` would load from there: a book could make
   Holi fetch a web address. `test/foliate-sandbox.test.ts` checks it.
3. `pdf.js` is a stub that throws: the real one imports PDF.js, which would
   land a large chunk in the app for a path Holi never takes.

Everything else is byte for byte upstream, and kept out of Prettier, ESLint,
knip and rulecast as third-party code.
