1. Allow for drag-and-drop reordering of tasks within a column
2. Allow for dragging files into a vault and out of a vault
3. Make our frontmatter yaml editor use proper syntax highlighting (we already suppoort this elsewhere)
4. Allow CTR+S to commit changes in notes, tasks etc.
5. Make apps stateful - We should get as close to actual apps inside Holi as possible. Since apps are already folders with a manifest, we are not far from actual typescript projects - and since every user is assumed to be a developer, we can just reuse their typescript installations.
6. Add a "Summarize" action to the email thread header
7. Add animations to essentially everything. 
8. When a user clicks "add file" or "add folder" in the file explorer, the temp input field should appear in the right place in the file explorer - where the user clicked.
10. When reordering tab headers, we should animate the tabs to their new position, such that the other tabs slide out to make room for the new tab.
11. Note slash commands should be customizable per vault - also via the agent. Same way theme is done. 
12. The UI for the slash command popover (and the "@" popover) use the standard codemirror layout, font etc. We should make it our own, ideally a full shadcn ui component with proper hover and focus states, and sub menus if possible.
12. Allow users to change a notes icon in the file explorer by typing in an emoji as the first character
13. Agent generally uses its own memory instead of our MEMORY.md file - we need to nudge or make it easier - perhaps make it a directory of memory files that lazy loads - or simply expose the native memory folder and its files in Holi's file explorer
14. Drop the "today" button and instead add a label in the file explorer to today's note. 
15. Allow for customizing the "landing note" - so users can point it at whatever - including an app or even boards, agenda or email