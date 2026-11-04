# Meetings

A meeting in Holi ends with its work already started. While people talk, the Meetings tab shows
live captions and the meeting cut into **groups** (topics): contiguous stretches about one
subject, each with a title, a short summary, keywords, its decisions and open questions, and
**suggestions** (features and to-dos that came up in it). A background agent session, the
**scribe**, draws the groups and writes them every few minutes; the minutes are rendered from the
groups by code. A person presses **Send** on a group or a suggestion, says what should be done,
ticks what else in the meeting belongs with it, and Holi starts an agent run (the vault's chosen
agent, or one of the vault's [Holis](holis.md)) with every one of those lines as its brief, while
the meeting is still going. Everything on screen is the person's to correct: a caption's words, where a group
starts, every field of a group. The tab calls the scribe **the assistant**, whichever agent runs it, and the work sent **Tasks**;
this page keeps the code's words (a task is a `Card`).

Meetings are the plugin `transcribe` (`src/plugins/transcribe/`), off until a vault turns it on.
They require the `agent` and `tasks` plugins. Speech goes to the speech service this machine chose,
syv.ai's by default; the scribe and a sent task run on the vault's chosen agent
([agent-sessions](agent-sessions.md)).

**The speech service** (`main/speech-service.ts`) is syv.ai's, or any service that answers OpenAI's
`/audio/transcriptions` (a local Whisper server, a hosted one), named by its address (https, or
http on this machine only, so meeting audio does not cross a network unencrypted) and the model to
ask for. It is this machine's, in `userData/speech-service.json`, chosen in the header's **Speech
service** dialog (`meeting.service.set`). syv.ai gets its own fields (`diarize`, `vocab`) and a key;
another service gets OpenAI's fields, the glossary as its `prompt`, and no `Authorization` without a
key. A profile's speech model is one of syv.ai's, so another service is asked for its own model.

**The speech key** is the person's, not the vault's: it lives in `userData/speech-key.enc`, encrypted
with the OS keychain (Electron `safeStorage`, as the GitHub token and Google's own client are
([auth](auth.md))), and is used for every vault on this machine. Main uses the key set in the
Meetings tab, else, for syv.ai's service only, the vault's `SYV_API_KEY` (`.env.local`, then `.env`,
read by core's one reader `readVaultEnv`), else none. syv.ai needs a key; another service may take
requests without one. **A key is bound to the service it was saved for**: it is stored with that
service's address and sent there alone. Choosing another service leaves it unused (it applies again
if that service is chosen again) unless the person ticks **Move this Mac's saved key to the new
service** (`meeting.service.set` with `moveKey`): there is one saved key, so it is then the new
service's and no longer the old one's. The dialog says when a saved key is for another service. The key never reaches the renderer, which learns only whether one is set,
where it came from, the service, and whether meetings can be transcribed as things are
(`meeting.key.status`'s `ready`); `meeting.key.set`, `meeting.key.clear` and `meeting.key.test` (for
syv.ai the free `/v1/models`, spending no credits; for another service half a second of silence) are
UI-door only. **Nothing records before transcription is set up**: while it is not, the tab shows
**Set up transcription before you record** above Record, and Record opens the Speech service dialog
instead of recording, so a person learns before the meeting, not after it.

## How it works

```
renderer                          main                                   Claude Code
mic ─┐                            meeting.chunk ─► chunk-<n>.wav (disk)
     ├─ stereo, 16 kHz ─ chunk ─►   Silero VAD per channel: speech only
sys ─┘   cut at a pause (6–12 s)    upload mono, or L and R apart ─► the service's /audio/transcriptions
                                    label Me/Them by channel, stitch in order
                                    segments [i] ── idle and 3 min of new lines ──► scribe session
groups ◄── 'meeting' event ◄──      MeetingState  ◄── holi meeting group / context
                                    minutes rendered from the groups (code)
edits ─ segment.edit, group.* ────► corrections, locks, stale ── next batch ──► scribe session
Summarise now ── summarise ───────► the next batch, as soon as it is idle ────► scribe session
Ask the assistant ─ tell (minutes) ► at once ─────────────────────────────────► scribe session
Send ── related (BM25), task.create, build ► tasks.create + the vault's agent ► build session
                                     or holis.send (the task) ──────────────► a Holi's run
```

**Capture** runs in the renderer (`renderer/audio/`): the microphone on the left channel and the
computer's sound (loopback: main answers the tab's `getDisplayMedia` with the main screen and its
sound, and refuses a frame's) on the right, resampled
to 16 kHz. A chunk closes at the first pause after 6 s and always by 12 s; a chunk with almost no
sound above the room's noise floor is dropped there already. That loudness test is crude: a fan or a
keyboard passes it, and speech models invent words in silence and noise, so main judges speech again
with a real voice activity detector before anything is uploaded (below). When one source cannot be
had (the system refused the computer's sound, say), the other records: the audio toggles show what
actually records, and the header says which source is missing and how to fix it, so half a
conversation is not lost unseen. Recording lives outside the tab, so leaving the tab keeps it going;
the status bar shows a timer. A Stop while Record is still starting cancels it: whatever the start
gets after that (the meeting, the capture) is let go as it arrives. The tab is reached from ⌘K:
**Meetings** under Go to, or **Start meeting**, which also starts recording with the picked profile
(the Default without one); and from the vault's tree (**Files**, below).

**Transcription** happens in main, per chunk. The WAV is written to
`userData/meetings/<id>/chunk-<n>.wav` before anything else, so a crash or a failed upload loses no
audio; uploads retry with backoff and once more at Stop, and a meeting left recording by a crash is
finished at the next start. A chunk the renderer gave up on (three tries) is told to main
(`meeting.chunk.lost`), which stitches past it at once: otherwise every later caption and batch
would wait for it until Stop. Quitting Holi, or turning the plugin off, asks the renderer to stop a
recording first (the capture's last chunk, its uploads, then the stop), and main keeps its verbs for
up to 15 s while it does. A missing key, or one the service refuses (401, 403), is no retry's to
fix: the chunk stays queued and untried, the meeting shows `blocked` (`no-key`, `bad-key`) as a badge
in the header with the fix under it, and saving a key sends what waited, in every vault here. A meeting does
not finish past a chunk waiting for its key, and the scribe's final pass gets its 3 minutes from when
the last upload is done, so slow transcription or a wait for the key never eats the pass. A meeting that ended with chunks failed for the key alone, their audio still on disk, is
transcribed again at the next start, without its scribe, and finishes again.

Before upload, main runs Silero VAD v5 (`main/vad.ts`, `main/silero.ts`: the model the backend runs,
on onnxruntime-web's wasm build, loaded once at the first chunk) over each channel, with the
backend's tuned settings: threshold 0.5, speech of at least 250 ms, a pause splits speech at
300 ms, 250 ms of padding each side. The upload holds only those speech regions, 0.3 s of silence
apart, and a time map takes the returned lines back to the chunk's own timeline, so line times and
Me/Them are judged on the original audio. A chunk, or a channel, with no speech is not uploaded at
all. The model takes about 60 ms for a 12 s channel; a channel that never rises above -60 dBFS
skips it. When the model cannot load or run, the log says so once and chunks go up whole.

Holi labels lines **Me** (the microphone) or **Them** (the computer) itself, with the backend's
speaker split off. These are the stored labels, which the scribe is sent; what a person reads (the
tab, copied text, the transcript file, a task's brief) names them by source, **Mic audio** and
**System audio** (`speakerName`), since "Me" is wrong for whoever else reads the transcript. When both channels carry speech in a chunk (each at least a quarter of the
chunk's VAD speech, the microphone's without the computer's echo), main uploads the left and the
right channel's speech as two mono requests at once and labels each line by the channel it came
from, so a line never straddles a change of speaker and the two requests take no longer than one. A
microphone line over which the computer is at least twice as loud is the speakers leaking into the
microphone (echo) and is dropped, as is a line over a channel with no speech. A chunk with speech on
one side only (echo does not count as speech) goes up once, as a mono mix of both channels' speech,
and each line gets the louder channel over it. Segment numbers `i` are given in chunk order, and
within a chunk in order of start, so they never change once shown. Known broadcast-credit
hallucinations ("DR P1", "Tekster af …", `ASR_JUNK`) and repetition loops are dropped
(`main/stitcher.ts`).

The VAD keeps silence and noise from the model, but a burst it passes (laughter, a jingle, a second
of music) still comes back as a broadcast caption, and the service gives no confidence to judge it
by (`avg_logprob` and `no_speech_prob` are always 0). So as each chunk is stitched, before its lines
get an index, `main/junk.ts` drops a line that is:

- **a loop**: two or more `mm:ss` timestamps used as cues (`05:03: …`) or each followed by the same
  words, or a `compression_ratio` over 2.4 (Whisper's threshold; measured locally, as the service
  does, when it sent none or a loop was collapsed). "Fra 10:00 til 11:30" is kept.
- **echo**: a Me line that a Them line covers for at least half its length, with token-set
  (Jaccard) similarity of at least 0.3 between their lowercased, unpunctuated words. The Them line is
  kept: the computer's own sound is the clean copy. A real echo, garbled by the room, measured 0.36,
  and two people talking over each other at most 0.19. Half of the Me line rather than of the
  shorter, because a long Me line over a short Them line that shares a few words is someone speaking.
- **a burst of broadcast cliché**: shorter than 2.5 s and matching `BROADCAST_CLICHES` whole. A
  name (a channel such as "TV 2" or "DR P3", "Næste station", a place alone such as "Horsens
  centrum", "[Musik]") of at most five words counts only with no other line on its channel within
  3 s, since a sentence may end on one; an announcement ("Det er den sidste station i …", "Næste
  stop: …") of at most eight words counts anywhere.
- **a lone burst**: one or two words under 1.5 s with no line on either channel within 3 s. A "ja"
  the other side's speech comes within 3 s of is an answer, and kept.

Neighbours are the chunk's own lines and the transcript before it; the next chunk is not in yet, so a
line is judged on what came before it, as an answer is. Every dropped line goes to main's console at
debug level (the Logs tab) with its reason.
Chunk audio is deleted once transcribed unless the profile keeps it.

**The scribe** runs on the vault's agent, in the form that holds it to the meeting there. On Claude
Code it is held by the deny rules below. On Pi it is a run with no tools at all (`agent.launch` with
`tools: 'none'`: Pi's `--no-tools`, and no extensions, skills, prompt templates, context files, MCP
servers or project settings), kept for the meeting (`keep`) and stopped when it is done, or when the plugin stops; it answers
each message with its groups as one JSON array (the prompt's `reply` form), which main reads at the
turn's end (`agent.reply`) and writes as `holi meeting group` would, telling it in the next message
which groups were refused and why. A person's note waits for the turn under way rather than join
its answer, and goes next; one that nothing will take (the run ended, the meeting did) is refused,
never left pending. It has nothing to read a file or reach the web with, and the
profile's model and MCP servers, which are Claude Code's, are not used. Codex has neither, so a
meeting on it records and captions without topics (`scribeUnsupported`), and the header says so with
the fix, never running another agent behind the person's choice. A Stop while the scribe is still
starting waits for it, up to a minute, before deciding the meeting has none, so a short meeting
still gets its final pass. **Start the assistant** under Now (`meeting.scribe.restart`) starts a new
one for a recording meeting whose assistant stopped or could not start, on the agent chosen then,
sent the whole transcript with the groups so far.

On Claude Code it is one background session per meeting, launched at Start with the profile in its
system prompt (`shared/scribe-prompt.ts`), one allow rule, `Bash(holi meeting:*)`, and deny rules
(`--disallowedTools`) that beat any allow, the vault's own included. It needs no file or web tools:
the transcript comes by message and `holi meeting context` re-syncs it. So it has no `Read`, `Edit`,
`Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, subagents (`Agent`, `Task`) or
`Monitor`, and `Read(//**)` and `Edit(//**)` deny every path, which Claude Code also applies to the
file commands it recognises in Bash and to redirections: `cat .env.local`, `grep -r` and `< file`
are refused. A deny cannot say "all of Bash but `holi meeting`", since an allow never carves an
exception out of a deny; any other command asks the person in the session as usual, unless the
vault's own rules allow it (`holi agent notify`, say), and a script that opens files itself is past
what rules see. The profile's MCP servers stay available.

**It is fed per group, not per minute.** Main sends the new transcript lines as one batch when the
scribe is idle and either at least 180 s of new transcript waits (`BATCH_TRANSCRIPT_S` in
`main/scribe.ts`), or the person pressed **Summarise now**, or the meeting stopped. About three
minutes is how long a subject runs, so a batch closes one group or none, and the scribe takes about
a fifth of the turns it took when it was fed at most every 45 s. Never into a running turn: a turn
pauses vault sync, and a feed into a working turn would hold sync paused for the whole meeting. A
batch carries the new lines, the groups so far (start, title, open or not written, the fields a
person edited, the suggestions each already has), and what the person changed since the last one
(corrections, group edits, tasks they made). What a person changes does not wake the scribe on its
own: it rides the next batch, or Summarise now sends it. A busy scribe shows as such in the
header's status chip. A scribe that takes no first batch within the retry window (its vault's
turn-signal hook predates inbox channels) marks the meeting `scribeUnreachable`, and the tab says
to run **Update skills** from the account menu and start a new meeting; the batch is still tried
once a minute, so a scribe that answers catches up from its cursor. It answers through two CLI
verbs, accepted only from that meeting's scribe:

| Verb                   | What it does                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `holi meeting group`   | Writes one group (JSON as the argument or on stdin); prints it as saved, and what it kept |
| `holi meeting context` | Prints the profile, the groups, the person's tasks and the last segment number            |

A verb knows its session from `$CLAUDE_JOB_DIR`, and inside a session a different `--session` is
refused. Identity is still cooperative, like all `holi` session verbs: a process that can run commands
in the vault can set that variable, as it can already message any session with `holi agent message`.

**Groups.** A `Topic` is `{id, title, summary, keywords, lines, start, end, open, decisions,
questions, suggestions, editedAt?, edited?, stale?}` (`shared/meeting.ts`): `summary` 2–4 bullets,
`keywords` 2–5, and a `Suggestion` `{id, kind, title, why, segments}`. The groups are contiguous and
in order; the last is **open** while the meeting records, and new lines join it (the meeting's
first line starts it). The scribe names a group by the `[i]` of its first line and sends
`{startIndex, title, keywords, summary?, decisions?, questions?, suggestions?}`; `main/topics.ts`
checks it. A `startIndex` that starts a group writes that group; one inside the open group cuts it
there, the earlier part closing and the rest becoming the new open group; one inside a closed group
is refused, since a closed group's start does not move. A field left out keeps its value and a list
sent replaces the old one. Titles are cut to 8 words and 60 characters, summaries to 4 bullets,
keywords to 5 (at least 2), decisions and questions to 8, suggestions to 8 a group. A suggestion
cites 1–6 lines of its group or an earlier one; quotes are looked up from the transcript, never the
model's, and a suggestion keeps its id while the scribe rewrites it (same kind, and the same title
or a line in common), so a sent one stays linked, and one a person sent is kept if the scribe later
drops it. Code derives every group's lines, times and id (`t<first line>`). The scribe is asked to
write a group in full when it closes and to refresh only the open group's title and keywords;
Summarise now asks it to write the open one in full too. At Stop the final pass may still cut the
last group, which closes once that pass is over. A meeting holds at most 60 groups and 60 tasks.

**The minutes are code's.** On every change, `main/minutes.ts` renders `minutes.local.md` (or
`minutes.md`, shared) from the groups, in the order minutes are read: the meeting's title, its date
and time, and **Participants**, the names the scribe heard said (a group's `people`; none when no
name was said, never a speaker label); then what came of it: **Decisions** and **Open questions**
gathered from the groups, each with its group's title, and between them **Action points**, the
tasks sent or made with where they stand and the to-dos the scribe heard someone take on that no
task covers yet; then **Discussion**, a `### <title> (m:ss–m:ss)` per topic with its bullets and
keywords, the open group as `### Now (from m:ss)`. While the meeting records, or a topic is still to
be written, the minutes open with a line saying they are a draft, and an unwritten topic says
"Not summarised yet." rather than stand empty. They are in the meeting's language, the headings
included: the profile's, or for `auto` the one the transcript is mostly in (Danish or English, by
their common words). A meeting saved before groups keeps the minutes its scribe wrote. Export writes
these minutes.

**A person reshapes the groups.** On a caption line, **Start a new topic here** splits the group at
that line (`meeting.group.split {meetingId, i}`); on a group, **Merge with the previous**
(`meeting.group.merge {meetingId, groupId}`) and **Edit topic**, its title, bullets, keywords,
decisions and questions (`meeting.group.edit {meetingId, groupId, patch}`). The groups a split or a
merge touches are marked stale and listed in the scribe's next batch as not written, to write again;
a split's new group takes the suggestions that cite its lines. A field a person edited is theirs
(`edited`, `editedAt`): the scribe's later write of it is not taken, the verb says which fields it
kept and why (as a person's minutes once did), and the next batch tells the scribe what those fields
say now. Lines are not re-sorted into groups that are not contiguous: that was measured and is not
reliable ([not built](../not-built.md)); `lines` stays a list so it could be.

**Joining topics.** A subject a meeting comes back to is two groups far apart. A person joins them
into one topic by dragging one row onto another by its handle (the target says "Drop to join with
this topic"), or with **Join with** in a topic's menu (`meeting.group.join {meetingId, groupId,
into}`). Joining moves no line: each group stays the contiguous stretch the scribe wrote, and only
`joinedTo` on the later ones names the group heading the set, its earliest, so the scribe's writes,
splits and merges work as before and the join rides along (`shared/joins.ts`; main tidies the joins
on every change, so a group gone, merged or split leaves none dangling, and a split-off part is a
topic of its own). The open group cannot join while it is being written. A joined topic is one row under the earliest group's title, with every group's number (`1 + 5`)
and time. Open, it reads as one topic: its Summary has one list each of bullets, decisions, open
questions, suggestions and keywords across all its groups, and its menu edits one group at a time
(**Edit part**), since each group is still what the scribe writes; its Transcript has each stretch
under its heading, and Send takes every group's lines. The minutes write it once, with every stretch's time.
**Separate topics** in its menu, or Separate on the toast after a join, gives each group back its
own row (`meeting.group.separate {meetingId, groupId}`).

**Send.** Each group has **Send**, and each suggestion in it too. Send opens a panel from the right,
beside the meeting: the group's title and summary; **What should be done?** (required; for a
suggestion, its title and why); Feature or To-do; **Related from elsewhere in the meeting**, the
five ~20 s stretches outside the group that best match the ask with the group's title and keywords
(`meeting.related {meetingId, query, exclude}`, BM25 in `main/related.ts`: lowercase words, Danish
stopwords, each cut to five letters), asked again as the person types, each a checkbox, unticked;
and who it goes to (the vault's agent, named, or a Holi). Sending makes a task (`meeting.task.create {meetingId,
lines, prompt, kind, title?, from?}`) with the group's lines, the suggestion's, and the ticked ones,
then sends it (`meeting.build`). A task carries at most 400 lines and says how many it had; its
title is the ask's first line (80 characters) unless given; it is the person's, accepted, with
`from: {topicId, suggestionId?}`. The scribe's next batch says the person made it. When the task
was made but sending it failed, a retry makes it again in place from the form as it is now
(`cardId`), so edits to the ask, the kind or the ticked lines are what goes.

`meeting.build` (the name is kept) creates the task's file in the meeting's folder, or writes it
again from the task as it now reads (when that write fails nothing is sent: a Holi reads the file
as its instructions, and would carry out what it said before), and starts a session named
`Build · <title>` (`Action ·` for a to-do) on the vault's chosen agent: Claude Code as a background
session with the profile's model and MCP config, Pi as its background run, any other in a session
of its own the person watches (`agent.start`); what that agent cannot do is the error, never a run
on another. One send runs at a time per task, whichever panel or caller asks. The brief: what the person asks, the group it came from (title, time, bullets), how they
want it done if said, and what was said, every line of the task up to 100,000 characters, under its
times or, when the lines are not one stretch, under each stretch's; then the profile's platform and
repository and the minutes' path. A to-do's session is asked to do or prepare it (draft the email,
gather the material) and to ask before sending anything, not to build software. The task's status
becomes `building`, and the UI shows its run from the agent's sessions: **Sent**, **Running**,
**Needs you** or **Done**, with **Open session**.

**Sending to a Holi.** Beside Send, a picker lists the vault's agent and its Holis, while the Holis
plugin offers `holis.send` (`useHasCapability`); without it Send goes to the agent alone. A Holi takes
work as a document, so main writes how the person wants it done into the task and calls
`holis.send` with the task's path; the Holi's own soul, rules, model and approval apply, and the
task records the session that answers. A Holi this machine has not approved, or approved before it
changed, is listed but cannot be picked: approving is the Holis view's, a UI door of its own. A Holi
whose `accepts` globs leave out the meeting's folder refuses the task, and the panel says so. The
picker shows Holis even while `HOLIS_READY` keeps them out of the Agents sidebar and the Agent menu:
a plugin cannot read another's flag, and the capability is the seam. The pick is remembered.

**Corrections.** A caption's words open for editing at a click: Enter saves, Escape puts it back,
and a corrected line is marked `edited` (`meeting.segment.edit`, at most 2000 characters). Main
stores the words, quotes them on every task citing the line (a quote is still copied from the
transcript by code) and writes the transcript file again. A line the scribe has already been sent,
or that is in the batch on its way (which carries the old words), reaches it as a correction in its
next batch, under "Corrections from the person", as
`[i] now reads: …`; its prompt says these are authoritative. A line it has not been sent yet goes
as corrected. **Replace** fixes a misheard word everywhere at once: in the review's transcript the
search finds lines with the words in any case and marks them, and, opened, Replace corrects the first
line it is in and Replace all every one (`meeting.segment.replace`), each a correction as above. A
line the replacement would empty is left as it was.

**Asking the scribe to change the minutes.** While the meeting records, the topics' header has
**Ask the assistant** ("drop the budget talk", "Simon owns the CI fix"). It is `meeting.tell` with
`kind: 'minutes'`, sent at once like any note, which main frames as a request to change the groups
the minutes are built from: write the groups it is about again, change
what was asked and keep the rest, and keep to it later. It cannot move a closed group's start; the
person splits and merges groups themselves. A plain `meeting.tell` (no kind, or `note`) is a
standing instruction. The header says "The assistant is updating…" until a group next changes, or for a
minute.

**A task from a stretch of the meeting.** **Custom range**, in the Tasks rail and on the review,
makes a task from a time range: a two-thumb slider over the meeting (0 to now while it records, to
its end after), presets (the last 2, 5 or 10 minutes, the whole meeting, and one per closed topic),
a preview of the lines in range, what should be done, and Feature or To-do. It calls
`meeting.task.create` with the lines in range and opens the task in a panel, ready to send, where
its words can still be edited (`meeting.card`) and it can be dismissed.

**The tab.** One header row: back to the list, the profile with a **…** menu (Edit profile, New
profile, Speech service), the title (the recording meeting's own while it records), Microphone and
Computer audio as one pair of icon toggles named in their tooltips, then, while a meeting records, a
chip with a dot and how the topics are doing ("Topics listening") that opens the details, each part
named for what it is so a problem says which part to fix (what records, the transcription, how far
the captions run behind, the topics, what to do about topics that stopped or cannot run, and
**Open the assistant's session**), a badge for each problem (transcription needs a key or its key was
refused, chunks not transcribed, topics unreachable, no topics with this agent), and an orange
**Recording · tell everyone** pill that stays for as long as it records; on the right the level
meter, the timer and Record or Stop. Under it an alert row, only while something is wrong: setting
up transcription, a source that is not recorded, or the assistant not receiving the transcript.

The middle is the minutes as topic sections, stacked, newest at the bottom, following the newest
while recording unless the person scrolled up. They start folded, so a meeting reads at a glance: a
half-hour meeting makes a dozen topics, and open they are a wall of text. Above them a strip with one
bar per topic, as wide as the topic ran (the open one in the primary colour), whose bar opens that
topic and brings it into view, and a folded roll-up of the decisions and open questions, each with its
topic, scrolling smoothly there; **Expand all** and **Collapse all** in the Minutes header. One topic
is open at a time: opening one folds the others, so the list stays a list. A folded topic is one row:
its number, title, gist (its first bullet) and its time: the counts of decisions, questions and
suggestions it once had were icons that crowded the row and said less than the gist. Open, it has two tabs. **Summary**: its bullets, decisions, questions, suggestions as
compact rows with Send (a sent one shows its run and Open session) and its keywords as small badges.
**Transcript**: the topic's own lines word for word, each correctable and able to start a new topic
as in the whole transcript, with Copy. Send and a menu with Edit
topic and Merge with the previous show on hover, on focus and while it is open; a stale one says
the assistant will rewrite it. Last comes the open topic, **Now (from m:ss)**, with the last three caption lines,
Send and **Summarise now** (`meeting.summarise`). Summarise now goes only while the assistant can
take it; otherwise Now says why and what gets it going: it is starting, it waits for the person in
its session (**Open its session**), it stopped or did not start (**Start the assistant**), or the
vault's agent cannot write topics (**Agent settings**, then Start the assistant). The rail on the right, 300px, is **Tasks**: only
what was sent or made, with its run and Open session, and **Custom range** in its header; empty, it
says "Send a topic to <the agent> to start", named for the vault's agent. The captions start folded into a strip under the topics with
the last two lines, quiet, and **Show transcript**, which opens the whole transcript as a column on
the left (about two sevenths of the width, following the newest line, under topic headings); the
choice is kept on this machine. A quote clicked on a task shows the transcript for that once. Under
900px they are tabs: Minutes, Transcript, Tasks.

**The review.** Stop, and opening any meeting that is not recording, land on its review: title,
date and length, with **Copy transcript** (one `[m:ss] Speaker: text` line each), **Export minutes**
and **Open in vault** (the minutes file). The transcript is copied only here, once the meeting is
over. Export minutes is a menu: **Markdown file…** opens the save sheet beside the minutes and main
writes the rendered minutes, under the meeting's title, where it says (`meeting.export`, an absolute
`.md` path; in the vault through the vault writer); **PDF…**, offered while the PDF plugin is on,
renders the minutes file through `pdf.render` with the `plain` template. Either one that lands in the
vault opens in a tab. Below: the roll-ups, the same topic sections (editable, Send works), Tasks with
Custom range, and the whole transcript under topic headings, searchable, with Replace, editable, and
copied from its own header too. Every transcript view reads a speaker's run of lines under their name
once, the time beside each line, as a transcript editor does, rather than a badge on every line. While the scribe's final pass runs the review says it is finishing the minutes.

**Files.** A meeting is a folder, `<folder>/<YYYY-MM-DD> <title>.meeting/` (`Meetings` when none is
chosen), holding `transcript.local.md` and `minutes.local.md` (`.local.`, so they never sync), and
the tasks made from it; a profile's **Share minutes** writes `minutes.md` instead, and the meeting
says which (`minutesPath`). State is kept in `userData/meetings/<id>/state.json`, with what a person
changed that the scribe has not been sent yet.

**In the vault's tree.** The `.meeting` suffix makes the folder one document (`meeting-claim.ts`, a
folder claim whose entry is the transcript), named without it, that opens as the meeting in a tab of
the Meetings surface: its transcript, topics and minutes, and Stop while it records. So a customer's
or a project's meeting lives beside that customer's or project's documents, and is found the way
they are. The tree's **New** menu has **New meeting**: it makes the folder where it was opened
(`meeting.prepare`, with a placeholder transcript) and opens it as its setup, where Record starts
the meeting there (`meeting.start` with `path`); nothing records until a person presses it. On
another machine the transcript is not there, so the folder is an ordinary one with the shared
minutes. A meeting recorded before folders had the suffix keeps its folder, and opens from the
Meetings tab.

**A meeting is known by its id, not its path.** Its transcript starts with `meeting: <id>`
frontmatter, written when it starts, and the engine checks it before every write and on every vault
scan (`meetings.follow`). A folder renamed or moved in the tree takes its meeting with it: the
meeting's paths (its minutes, its tasks) follow, and it writes there from then on. A transcript
dragged out on its own into a folder that is not a meeting's is not the meeting moving: the meeting
stays in its folder and writes its transcript there again. A folder deleted
from the vault, gone for 5 s (a move removes its files before it writes them again), deletes the
meeting here too, its recording stopped first (`meeting-removed`: the capture stops and what it
still has goes nowhere); nothing writes the old path again. What this machine had of it (state,
audio) is set aside in `meetings/.removed/<id>-<time>` for 30 days rather than erased, since a
folder can go by mistake or by another machine's sync; `meeting.delete` erases at once. A folder
that stayed while only its transcript went, as in a fresh clone (the transcript is machine-local),
gets it written again. A folder at a meeting's path that is not that meeting's is never taken for
it, nor is a file someone put in its transcript's place overwritten: a stale record shows in the
list as moved away (`away`), opens no folder, and `meeting.start` in a folder whose transcript carries another
meeting's id, or no id at all (a file of someone's own), is refused. A meeting from before ids takes the transcript at its path as its own.

**Renaming and deleting.** Each meeting in the list has a **…** menu, on hover or focus, and so does
its review beside the title: **Rename** edits the title in place (`meeting.rename`; Enter saves,
Escape keeps it) and **Delete**, once confirmed, removes the meeting (`meeting.delete`). A rename
changes the title the list, the review and the transcript's heading show, not the folder: the folder
is where the tasks made from the meeting were filed, and moving it would break their paths. A delete
removes the meeting's state on this machine and the transcript and minutes it wrote, then its folder
if nothing else is left in it; the tasks made from it stay, since they are the work the meeting led
to. A meeting that records or finishes cannot be deleted: stop it first.

## Profiles

A profile tells the scribe what this kind of meeting is about, and is how a person tunes away
irrelevant points and mis-transcriptions. None is needed: a meeting records with this machine's
first profile, the Default unless another was made. **What do you build?** is context for the tasks
sent and for the topics, not for transcription, and is optional. Profiles live on this machine in
`userData/meeting-profiles.json`, not in the vault: a profile can hand sessions an MCP config, and
anything in the vault can be rewritten by an agent. A meeting copies its profile at Start.

The editor asks five plain questions: **Name**, **What do you build?** (platform), **Listen for**
(focus), **Leave out** (ignore) and **Language**, then **Words to spell right** (the glossary). The
rest, which a person sets once if ever, is folded under **More settings**: the repository, extra
instructions, the speech model, in-room speaker numbers, share minutes, keep audio, the two models
and the MCP config. Only the labels are a person's words; the fields keep their names, so a saved
profile, and what the scribe is told from it, are unchanged.

| Field                     | Effect                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| platform, repository      | What features are built on; build runs are told to work in the repository   |
| focus, ignore             | What counts as a feature here, and what to drop                             |
| glossary (term, heard as) | Terms go to speech recognition as vocabulary; mishearings to the scribe     |
| instructions              | Extra standing instructions for the scribe                                  |
| language                  | `da`, `en` or `auto`                                                        |
| speech model              | syv.ai's Accurate (`syv-transcribe`, default) or Fast (`syvai/hviske-v5.3`) |
| in-room speaker numbers   | One microphone in a room: the backend numbers speakers instead of Me/Them   |
| scribe model, build model | Claude model for each (another agent runs on its own default)               |
| MCP config                | A JSON file passed to the scribe and build runs as `--mcp-config`           |
| share minutes, keep audio | See Files above                                                             |

During a meeting, `meeting.tell` sends the scribe an instruction at once; the tab's **Ask the assistant**
sends it as a change to the groups (above).

## Boundaries and rejected alternatives

- **Send is a person's press.** Nothing starts a run from what was said: a spoken "build X" would
  otherwise be a way to start agents from the room. Automatic builds for explicit asks are in
  [not-built](../not-built.md).
- **The pipeline is a first-party plugin, not a vault app**, because `agent.launch` is UI-door
  only and a vault app's script can press its own buttons.
- **Chunked uploads, not a streaming endpoint.** The backend answers a 6–12 s chunk in about 2.5 s
  (p50, `syv-transcribe`; 1.2 s on the fast model), which needs no backend change. Stereo uploads
  with the backend's speaker split were slower (about 4 s) and its channel split did not fire on
  short chunks, so Holi labels Me/Them itself, by uploading the two channels apart when both speak.
- **Holi's own VAD, not the backend's.** The backend runs Silero VAD only on uploads over 32 s:
  on a short clip it found trimming a quiet start costlier than the silence. Live chunks are 6–12 s,
  so the backend sends them to the model whole, silence and noise included. Measured on 12 s
  chunks against the real service, chunks of room noise and typing that pass the recorder's
  loudness test came back with about 175 invented words a minute (radio schedules, "P4
  Natradio"); with main's VAD in front, none, while word error on Danish speech went from 11.1 %
  to 9.5 %, line start times from 3.3 s to 0.2 s off, and uploaded audio fell by three quarters. Waiting for longer chunks to cross the
  backend's bar would cost the live captions their latency.
- **One scribe session for the meeting, not one call per batch.** It keeps the whole meeting in
  context and rewrites groups rather than duplicating them; Holi makes no headless model calls.
- **Groups first; the rest was cut for them.** The scribe's rolling cards missed real tasks and
  cost a turn every 45 s. Each cut serves the groups:
  - **Cards the scribe kept up to date in the rail**, with their confidence, Explicit and "N more":
    a task now starts from a group a person sends, and the group's context is what makes its
    suggestions more reliable than cards read off a rolling window. The profile's minimum
    confidence went with them, and so did forwarding a card's later changes to its build: a task
    is the person's, and nothing rewrites it under a running build.
  - **Ask now on a card's open questions**: questions live in the group they were left open in.
  - **The free-text minutes editor and its baseline rule**: the minutes are rendered from the
    groups, so a person edits the group, field by field, and the lock keeps what they wrote. Two
    ways to edit the same words would fight.
  - **The minutes-line presets in the custom range**, which needed the minutes to name cards: a
    topic preset is the same thing, from the groups.
  - **The separate Topics tab**: the topics are the middle of the tab now.
  - **The 45 s cadence**: a batch per three minutes of transcript sees whole subjects, and takes
    about a fifth of the turns (Quality).
- **No Claes, measured.** syv.ai's Claes decision model was measured as a fast detector of feature
  requests (window AUC 0.63–0.72) and, for groups, on three jobs: related lines for a prompt,
  topic-change detection, and re-sorting lines into groups. It tied or lost to free baselines on
  each ([not-built](../not-built.md) has the numbers), so related lines are BM25, the scribe draws
  the boundaries, and groups stay contiguous.
- **Quotes are never the model's text.** Suggestions and tasks cite segment numbers; main supplies
  the words, a person's correction included.
- **A Holi's work is its task, not a message.** `holis.send` takes a document and nothing else, so
  how the person wants it done goes into the task, where the person can read it too.

## Quality

The scribe is measured against five recorded Danish meetings labelled blind (feature and action items
with their segments), four for tuning and one held out, by matching each suggestion to a label within
three lines; two runs each, pooled. The groups-first prompt, after three rounds on the tuning
meetings, found features at precision 0.75 and recall 0.95 on them, and 1.00 and 0.50 on the held-out
one; the cards scribe before it scored 0.82 / 0.82 and 0.89 / 0.57. Held-out recall is short of the
0.70 it aims for: the groups catch more of the tuning meetings' features and fewer of the held-out
one's. Every cited segment was valid. Turns take 14–16 s at the median on `sonnet`, and at a batch
per three minutes of transcript the scribe takes about 24 turns a meeting-hour, where one batch every
45 s took about 83. The meetings themselves are private and not in the repository.
