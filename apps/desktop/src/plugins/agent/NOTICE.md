# Third-party notice: MonoCode

Parts of the agent plugin's Agents view are ported from, or written after, MonoCode, which is
released under the MIT License below. Each such file says so in its header comment. The chat
plugin's parts carry their own notice (`../chat/NOTICE.md`).

Ported or adapted:

- `renderer/agents/pixel-mascots.ts` (from `features/projects/model/projectMascots.ts` and
  `pixelMascots.ts`: the sprites, shading and talk frames)
- `renderer/agents/PixelMascot.tsx` and the mascot motion in `renderer/agents/agents.css` (from
  `features/projects/ui/PixelMascot.tsx` and its stylesheet)
- `renderer/agents/AgentsSidebar.tsx`, `parts.tsx` (after `app/shell/Sidebar.tsx`'s session rows; their
  braille spinner and shimmering step text gave way to Holi's own `motion-orbit`)
- `renderer/agents/AgentsMain.tsx` (after `features/sessions/ui/SessionPane.tsx`)
- The idea of a Holi, after MonoCode's Monos (`docs/features/holis.md`)

MonoCode is not affiliated with Holi. Provider marks shown in the UI are trademarks of their owners
and identify those products only.

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
