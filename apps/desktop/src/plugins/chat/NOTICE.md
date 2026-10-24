# Third-party notice: MonoCode

Parts of the chat plugin's views and its Claude Code channel are ported from, or written after,
MonoCode, which is released under the MIT License below. Each such file says so in its header
comment.

Ported or adapted:

- `renderer/ChatSidebar.tsx`, `parts.tsx` (after `app/shell/Sidebar.tsx`'s session rows; their braille
  spinner and shimmering step text gave way to Holi's own `motion-orbit`)
- `renderer/Transcript.tsx`, `Markdown.tsx`, `Composer.tsx`, `ChatMain.tsx` (after
  `features/sessions/ui/AgentTranscript.tsx` with its turn line, `TurnDuration`,
  `TurnMetricsBadge`, `CopyTurnButton` and `SaveNoteButton`, `AgentMarkdown.tsx`, `Composer.tsx`,
  `ModelPicker.tsx`, `AccessPicker.tsx`, `SessionPane.tsx` and `EmptySession.tsx`)
- `renderer/ComposerMenus.tsx` (after `features/skills/ui/SkillPicker.tsx` and
  `features/sessions/ui/FileMentionPicker.tsx`)
- `renderer/composer-tokens.ts` (after `features/skills/model/slashCommands.ts`,
  `features/files/model/fileMentions.ts` and `shared/lib/fuzzy.ts`)
- `renderer/ReviewCard.tsx` (after `features/sessions/ui/SessionReview.tsx`)
- `main/commands.ts` (after `src-tauri/src/skills.rs`'s skill discovery)
- `shared/chat.ts` (the transcript's item shapes and tool phrasing)
- `renderer/steps/` (after `AgentTranscript.tsx`'s activity rows, `ToolCall`, `SubagentPanel` and
  `ActivityThinkingRow`, `features/files/ui/FilePreview.tsx`'s diff rows and
  `features/sessions/model/taskList.ts`), `renderer/attachments.tsx` (after
  `features/sessions/model/attachments.ts`)
- `shared/tool-views.ts` (after `integrations/harness/core/preview.ts`'s tool previews and diff)
- `main/claude-stream.ts` (after `integrations/harness/providers/claude/claudeProtocol.ts`, its
  `turnMetricsFromResult` included)

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
