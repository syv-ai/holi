# Third-party notice: MonoCode

The Holis plugin is written after MonoCode's Monos, which MonoCode releases under the MIT License
below. Each ported file says so in its header comment.

Ported or adapted:

- `packages/shared/src/holi-memory.ts` (from `features/monos/model/monoMemory.ts`: the dated
  entries, the budget, the archive, the redaction and the search)
- `main/holis.ts`'s system prompt (after `monoFiles.ts`'s mono context: the soul, the memory rules
  and the memory)
- `renderer/HoliPage.tsx`, `renderer/HoliSettings.tsx`, `renderer/MemoryPage.tsx`,
  `renderer/HolisSection.tsx` (after `MonoSettingsDialog.tsx`, `MonoFilePages.tsx`,
  `MonoIntro.tsx` and `MonoRailSection.tsx`)
- The idea of a Holi itself: an agent of your own with a soul, a memory and habits

The Holis' faces were MonoCode's pixel mascots; they are now syv.ai's own pixel personas
(`apps/desktop/src/renderer/src/composites/pixel-persona/`), which owe MonoCode nothing.

MonoCode is not affiliated with Holi.

```
MIT License

Copyright (c) 2026 Nick

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
