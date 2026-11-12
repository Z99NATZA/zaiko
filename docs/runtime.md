# Runtime and Development

## Setup

```text
Requirements
==========

GNOME Shell 50 on Wayland, Rust/Cargo, Python 3, Make, gjs, and gdbus.
Node.js is also needed for development checks. Install as your normal desktop user.

Configuration
----------

Select openai or deepseek with ZAIKO_LLM_PROVIDER and its model ID with
ZAIKO_LLM_MODEL. The example selects openai / gpt-6.1-sol.
Optionally list more model IDs for the /model picker in ZAIKO_LLM_MODELS,
separated by commas (up to 64, same ID rules). ZAIKO_LLM_MODEL is always first.
Listed models can use either provider: IDs starting with deepseek use DeepSeek,
IDs starting with gpt- use OpenAI, and other IDs use ZAIKO_LLM_PROVIDER unless
written as openai:<id> or deepseek:<id>.
The selected provider's API key is required, plus the key of any other provider
used by ZAIKO_LLM_MODELS.

make install copies the project .env to ~/.config/zaiko/.env. If the installed
file differs, it is first saved as ~/.config/zaiko/.env.backup-<timestamp>.
Without a project .env, an existing installed file is kept. Run zaiko restart
after changing the configuration.

Installation
----------

make install adds the core, launcher, character assets, and GNOME extension.
The default command location is ~/.local/bin/zaiko; it must be on PATH.
GNOME may need a logout/login to discover a new extension or load updated code.
Zaiko does not enable globally disabled user extensions.
```

## Behavior

```text
Desktop
==========

The GNOME 50 extension renders the character on the primary monitor at the
size chosen with CharSize (see Character size).
Her expression follows the companion state (idle, thinking, working, replied,
error); each change picks a random frame for that state from assets/aiko.
While a state lasts she switches to another of its frames every 20-40 s
(4-6 s while thinking). Each new frame pops in briefly, and she breathes with a
slight stretch from her bottom edge, faster while thinking or working. Breathing
pauses while she is hidden, and all motion follows GNOME's animation setting.
scripts/slice_sheet.py cuts those frames from a transparent sticker sheet.
The companion follows workspaces and hides in Overview, fullscreen, and lock.
It reserves no desktop space. Keyboard handling stays in focused UI or an active
character drag.

The character appears while the Rust core owns its session D-Bus service.
The extension can be disabled without stopping the core. zaiko stop ends both
the core session and its visible companion; enabling the extension reconnects
to an existing core.

Conversation
----------

Left click the character to show and focus compact input at her bottom; repeat
clicks keep it open. Click elsewhere or press Escape to hide input, keeping its
draft. The input uses the same borderless gray composer as Log, with a leading
› prompt and no placeholder or send icon. A single row fits one row; longer
drafts wrap and expand upward, then scroll when the available screen space is
full. Shift+Enter adds a newline; Enter submits the whole draft and hides input
once the core accepts it. Drag the character to move her. Submission failure
keeps input open and restores the draft. Click Aiko to reopen input;
a text Stop control appears while a request is active. The latest answer appears above her head
as [Aiko] message in a speech bubble: the Log's translucent One Half Dark
surface and 1 px border, 12 px
corners, 8/12 px padding, a purple bold [Aiko] prefix, and a small tail pointing
at her head. Errors use red text. The bubble shrinks to short replies, grows up
to 320 px wide, and is limited to five wrapped lines including
the prefix; longer answers are shortened only in this preview. A reply that
arrives while Zaiko runs types out in the bubble and in Log, whole characters
at a time (Thai vowels and tone marks stay with their letter), at about 50
characters a second and within 2.5 seconds for long replies. The bubble takes
its final size first so it does not move while typing. Replies already present
when Zaiko connects, and all replies when GNOME animations are off, appear at
once; sending a new message finishes any typing immediately. While a reply
types she bobs quickly up and down, dipping about 3% of her height behind her
bottom edge, and settles when the text is complete. Each displayed
completed message or error disappears 8 seconds after typing ends. Repainting,
changing the desktop font, reopening input, or using the character menu
does not hide the answer or restart that countdown; opening Log dismisses it. The full
conversation stays in Log.

Character dragging captures the pointer from the initial press until release,
so fast movement outside the character keeps moving it. Movement uses desktop
coordinates and the original pointer offset, including reversals after reaching
a screen edge. A movement of at least 8 px counts as a drag; a shorter click
opens input. Escape, hiding the character, or disabling the extension cancels
the drag and releases the pointer.

Thinking displays elapsed time, for example [Aiko] Thinking... (3s),
(1m 30s), or (2h 1m 30s). It updates once per second using measured elapsed
time, omits leading zero units, and remains visible while the request is active.
The clock starts when this extension observes thinking, continues across tool
phases of the same request, and resets for a new request or when the core stops.

Right click the character and choose Log to read and continue the retained
session conversation. Its flat, left-aligned transcript displays [Me] message
and [Aiko] message directly, without bubbles or separate role headings. Only
the prefixes have participant-specific colors; all message bodies use the same
color. Tool results use [Action]. Markup-like message content is literal text.
Drag to select text within a message (shown in the inputs' blue #4a6988) and
press Ctrl+C to copy it. The drag keeps selecting until release, even after the
pointer leaves Log or crosses an app window. Typing or pasting (Ctrl+V, Ctrl+Shift+V, Shift+Insert)
while a message is selected clears the selection and continues in the Log input,
including Vim and the command picker. Right click a
message and choose Copy to copy the selection, or the whole message when nothing
is selected. This menu uses the existing One Half Dark context-menu style.
Click outside Log to clear a message or input selection and release its keyboard
focus. A plain click on a message or unused space inside Log focuses its input.
Log stays open and input drafts are
preserved. Using a text field's or message's own context menu keeps its selection
available for Copy/Paste.
Each message has 6 px horizontal and 4 px vertical mouse padding. Dragging from
this padding starts selection at the nearest character, including beyond the
last character. The padding stays transparent and replaces the old row spacing.

The input at the bottom of Log is a multiline composer with a leading › prompt.
It wraps long lines and grows with the draft, without a fixed row limit. When
the available panel space is full, it scrolls internally and keeps the caret
visible. Shift+Enter adds a newline, including with Vim enabled.
Enter submits the complete draft. Both inputs have no placeholder or send
icon; a text Stop control appears only while a request is active.
Successful Log sends clear only its draft and keep Log open for continued chat.
While Log is open, character clicks and Present focus Log input and cannot open
the compact input. Closing Log re-enables compact input. The two drafts stay
separate and submission failures restore only the originating draft. A shared
request guard prevents overlapping sends from either input.
Opening Log hides the floating answer and request status. A reply or error
shown while Log is open has been seen there, so it is dismissed and does not
return outside after Log closes; this includes new replies received while Log
is open. A request status that is still active (sending or thinking) shows
again after Log closes. The character menu alone keeps the floating text
visible, stacked below popup menus.

The old comparison panel is removed. Log appears only when requested. Quit is
also available from the character menu. Escape closes the focused input or support
panel. Hiding input keeps the latest answer visible; Quit or zaiko stop ends
the session.
The conversation has no title/header row. Its circular close control sits inside
the top-right corner, inset 12 px from the edges, overlaying the transcript
without reserving a header or changing the message area. It appears
while the pointer is anywhere in Log, including its input and close button, and
hides immediately on leaving. Click closes
Log; Escape works even while the close button is hidden.
The character's right-click menu has five compact rows: Log, CharSize: 1-5,
Lang: en/th, Vim: off/on, and Quit, with no separator. Each setting row lists
all of its choices ("CharSize: 1 2 3 4 5", "Lang: en th", "Vim: on off"): the
current one in the normal color and the others dim (#7f848e), and clicking the row
moves to the next choice. Log is always first and
Quit always last; the rows between are sorted A-Z by their English names and
keep that order in Thai. New rows follow the same rule. It opens near the
right-click position and flips or shifts to stay inside the monitor's work area
at screen edges. It is stacked
above the floating reply. Input Copy/Paste and message
Copy menus share the Log/Quit menu's surface, corners, spacing and desktop font.
Choosing Quit closes the menu and opens a confirm popup at the pointer (at the
menu's point when Quit is chosen from the keyboard):
"Confirm quit?" with Cancel and Quit on the right. Cancel has focus, so Enter
or Escape keeps Zaiko running; Quit quits.
Input menus retain GNOME's Copy/Paste actions and disabled states, without
additional shortcut labels.
Menus appear above the companion surfaces; input menus sit outside the complete
composer border. Pointer highlights clear when the pointer leaves a row.
Keyboard navigation highlights the focused row until pointer movement resumes.

Slash commands
----------

Type /status in either input while no request is active. The core reports the
state before this command, configured provider/model, and actual permission
boundaries. It currently runs with the current user's permissions, without a
filesystem sandbox or protected sensitive folders. Missing provider configuration
is reported without requiring an API key or contacting the provider.

The reply appears in the existing answer preview and Log. Like other retained
messages, it can be included in the history of a later model request. Commands
share the existing request-ID, cancellation, and active-request guards.
Type /model to see the active provider/model, or /model <model-id> to switch
the model for the rest of this session. A listed model keeps its provider; a
typed ID uses the same provider rules as ZAIKO_LLM_MODELS and needs that
provider's key. Restarting Zaiko returns to ZAIKO_LLM_PROVIDER/ZAIKO_LLM_MODEL. A successful
switch leaves no message in the Log or the model history; the Log footer and
/status show the switched model. The ID uses the same rules as ZAIKO_LLM_MODEL and is
not checked against the provider until the next model request. A switched ID
that is not in ZAIKO_LLM_MODELS joins the picker list for this session.
In the command picker, Enter, Tab or clicking /model opens a list of model IDs
(names only) instead of submitting; it opens on the active model, typing after
"/model " filters by substring, and Enter or clicking submits /model <model-id>.
Without a model list (invalid configuration), /model submits as before.
Leading/trailing whitespace is ignored. /status takes no arguments; other slash
commands return a local unsupported-command reply instead of reaching the model.
Type /permissions to see the permission mode, or pick a mode from its list:
/permissions full (Full Access, the default) lets Aiko act right away, as before.
/permissions ask (Ask for approval) makes Aiko first say what it will do and ask
in a normal reply, then act only after you agree in your next message; any clear
wording works. The mode lasts for this session; restarting Zaiko returns to Full
Access. Ask mode is an instruction to the model, not a sandbox: commands still run
with your user's permissions once Aiko calls them. /status shows the mode.
Type /clear or /cls (they are the same) to clear the chat and start over: the Log
and the history sent to the model are emptied, and the provider/model stays as it is.
It takes no arguments and, like other commands, waits until no request is active.
Type /vim to toggle input Vim, exactly like the Vim: off/on menu row; the
extension handles it without submitting it to the core, empties the draft and
keeps the input open.
Type /exit to quit Zaiko right away, without the Quit menu's confirm popup; the
extension handles it without submitting it to the core. If Quit fails, the draft is restored.
Typing / opens a command picker above the focused compact or Log composer.
Each row shows a command and its description; typing filters command prefixes.
The flat list aligns to the input's width, with shared command/description
columns. A full-width green (#98c379, matching Me) selection bar and leading ›
mark the selected row. Filtering reuses matching rows so the highlight stays
steady while typing.
Popup geometry is measured after the input is allocated, keeping its full
width stable during text edits.
At most eight rows are visible, with native mouse-wheel scrolling for the rest.
Up/Down, or Super+J/K (also under the Thai layout), select and scroll the chosen
row into view, stopping at the first/last command without wrapping. Tab fills the command without
submitting; Enter or clicking a row submits it once. Escape closes the picker
and preserves the draft; the next Escape follows the normal composer/Vim behavior.
The picker hides while busy, on focus loss, and when its composer is hidden.
It stays within the monitor work area, using space below when needed.

UI language
----------

Click Lang: en/th in the character menu to switch between English and Thai.
Like Vim, it toggles in place and keeps the menu open. The UI updates immediately:
menus, Copy/Paste, request status, local errors, accessible labels, speaker
prefixes and slash-command descriptions. Command identifiers and conversation
contents remain unchanged. Language and Vim settings are independent.
The default is English. The choice is saved as `{"language":"en"}` or
`{"language":"th"}` in `~/.config/zaiko/language.json` (following XDG_CONFIG_HOME).
Invalid or unsupported preferences fall back to English.

Edit `gnome-extension/locales/en.json` and `gnome-extension/locales/th.json` to
change UI text. They are flat JSON objects with the same keys; named placeholders
such as `{state}`, `{language}` and `{elapsed}` must match between languages.
Missing Thai strings fall back to English. Install the edited files with
`make install` and reload the GNOME session to load the changed catalogs.
This setting controls the companion UI; core/provider messages retain their
original content and response language.

Character size
----------

Click the CharSize: 1-5 menu row to cycle the character size
1 → 2 → 3 → 4 → 5 → 1. Like Vim, it changes in place, keeps the menu open and
the label shows the current value. The sizes are 208 x 156 (1), 260 x 196 (2),
312 x 235 (3, the default), 390 x 295 (4) and 468 x 354 (5). She grows or
shrinks around her bottom centre, still clamped to the work area. The choice is
saved in ~/.config/zaiko/character-size (following XDG_CONFIG_HOME); a missing
or invalid value means 3.

Input Vim
----------

Vim is off by default. Click the Vim: off/on menu row or type /vim to toggle it;
the menu stays open and the row immediately shows the current value. The choice is saved in
~/.config/zaiko/input-vim-enabled (following XDG_CONFIG_HOME), independently of
zhyprbola. It applies to both the compact input and the Log input.

A small footer under the Log input shows the current model on the left and,
while Vim is on, the mode on the right: --NORMAL-- in purple (#c678dd, matching
[Aiko]), --INSERT-- in green (#98c379, matching Me) and --REPLACE-- in red.

Following zhyprbola Tasks, normal mode uses a steady block cursor. h/l or the
left/right arrows move by character, j/k move down/up a displayed row (keeping the
horizontal position), including rows wrapped automatically to fit either input.
0/$ move to the start/end, and b/w move by
word. i inserts before the cursor, a after it, and A at the end. ciw changes the
current word, C changes through the end, x deletes the character under the cursor, r replaces one character, and R replaces
continuously; Backspace restores overwritten characters in R mode. dd deletes
only the current line in the input draft, preserving the other lines; on a line
wrapped automatically, it deletes only the displayed row under the cursor.
gg goes to the first non-blank character of the first line, and G to that of
the last displayed row, so it reaches the bottom of a wrapped last line.
guiw/gUiw lowercase/uppercase the word under the cursor, and guu/gUU the
current row (the displayed row on a wrapped line, like dd). V starts visual
line mode (--VISUAL LINE-- in yellow #e5c07b), which highlights whole rows from
where it started to the cursor in blue #4a6988 (the inputs' selection color,
visible on the #3e4451 composer); motions such as j/k, gg and G extend it. In it,
d or x deletes the rows, c replaces them with an empty line in insert mode,
u/U change their case, o jumps to the other end, and Escape or V leaves.
Clicking or editing the text elsewhere also leaves visual mode.
u undoes and Ctrl+R redoes, keeping the 10 latest steps for each input. Each
command is one step, and an insert or replace session together with the command
that began it (such as o or ciw) is one step, like Vim. Changes made outside
Vim commands, including sending the draft, are a step too, so u after sending
brings the sent text back. A new change clears redo.
Conversation messages remain read-only.
o opens a blank line below the current logical line; O opens one above it.
Both enter insert mode and preserve the surrounding lines. Ctrl+J inserts a
newline at the cursor (replacing any selection) without sending, with Vim on or
off. In Vim normal or replace mode, Ctrl+J also enters insert mode.
Normal-mode commands follow physical US QWERTY key positions, so the I key
enters insert mode even with the Thai layout active. Shift selects uppercase
commands such as A and R. Insert mode, continuous replace, and the replacement
character after r keep using the active layout for text.

Escape returns to normal mode and keeps the input open. Enter still submits
normally; in Log, the input keeps its focus and Vim mode after sending. Busy
inputs cannot be edited. Mouse clicks place the caret and
select text natively without changing the Vim mode: only i, a, A and the other
insert commands enter insert mode, and in normal mode the caret stays on a
character. Clicking away preserves the draft and clears focus/selection. The
compact input then closes while keeping its Vim mode for the next input. Log
also keeps its mode when closed and reopened. Both inputs share the latest mode
while Zaiko is running; quitting and restarting begins in normal mode.
Copy/Paste stays available. Turning Vim off restores ordinary typing and Escape
behavior. Plain clicks on Log background or transcript text return focus to its
input without changing the current Vim mode.

Fixed appearance
----------

Zaiko uses a fixed One Half Dark palette: #282c34 surfaces at 90% opacity,
#dcdfe4 text, subdued gray outlines, rounded controls, and a slim scrollbar.
Controls, caret, selection, hover, and keyboard focus use the same neutral
foreground tones. Close uses a gray highlight; errors use brighter, heavier text.
The slash picker marks its selected row with a green bar and dark text.
Panels, controls, and menus have no box shadows. Floating replies use a dark
speech bubble without a text shadow. The conversation
has a 12 px outer radius and 16 px content padding. Both inputs use the same
expanding gray surface with 3 px corners, 13 px text and a leading prompt,
similar to a terminal composer. Each fits a single text row when the draft has
one row, and has no border, including when focused. Neither shows placeholder
text or a send icon. Clicking padding or gaps in either composer focuses its input. Clicking text still
positions/selects it normally, and embedded controls keep their own actions.
Row height reserves space for stacked Thai vowels and tone marks using the
current font and scaling, so adding marks does not resize a single text row.
Log prefixes
use green #98c379 for Me and magenta #c678dd for Aiko while message bodies
share the foreground color. Palette source: https://github.com/sonph/onehalf.

Theme selection and sync are removed and deferred to a future task. There is
no appearance page, palette registry, generated palette stylesheet, or preference
watcher. An old ~/.config/zaiko/ui.json is ignored and preserved; Zaiko does not
read zhyprbola configuration. Desktop font-family/scaling settings still apply.
Both inputs blink their native caret while focused and editable, following the
desktop cursor-blink, cursor-blink-time, and cursor-blink-timeout preferences.
Typing or moving the caret restarts blinking; hiding or unfocusing input stops it.

Computer tools
----------

Only terminal (zter) and vscode are supported. Opening terminal normally launches
or focuses the primary zter instance without adding a tab. An explicit new-tab
request uses its new-tab desktop action (--new-tab). If the primary instance is
absent, this creates its first window with one tab. An explicit new-terminal or
separate-window request uses new-window (--standalone). Default and tab requests
target the primary instance, even when standalone windows are open.

To open zter with a program running ("เปิด zter พร้อมรัน codex"), Aiko uses
run_command to start zter --new-tab --run '<command>' (or zter -s --run for
separate windows), once per requested terminal. zter types the command into a
new tab's shell, so any program available in zter works without a per-program
rule. This needs a zter build with --run. A new tab in a running zter starts in
the active tab's folder rather than the launching workdir, so a requested folder
goes into the command: zter --new-tab --run "cd '/path' && codex".

zter cannot type into or change the folder of a tab that is already open; the
prompt states this so Aiko does not look for a workaround. In general, when the
tools cannot do something, she says briefly that it is not supported, without
suggesting alternatives unless asked.

VS Code keeps opening a new window using new-empty-window (--new-window).
A launcher without a requested action reports an error; Zaiko does not substitute
another mode. Install the updated zter binary and desktop launcher for tab support.
Close and reopen the primary terminal after updating zter so the running instance
can receive --new-tab requests.
Success means the launch/activation request was submitted, not verified window or
tab visibility. Duplicate request IDs still cannot launch again.

General commands
----------

The run_command tool runs local Bash commands as the current desktop user.
It can inspect or edit files, invoke installed programs, and run scripts without
adding a tool for each program. Supported desktop actions still use open_app.
The command and a compact result appear in Log, including failures and partial
output. The model receives stdout, stderr, exit code, actual working directory,
and flags for timeout and output truncation before choosing its next action.

Commands use /bin/bash --noprofile --norc -c with closed stdin. workdir must be
an absolute existing directory, or null to use HOME. Each call has a fresh shell;
directory changes, shell variables, and startup-file aliases do not persist.
Installed programs are resolved through the core's inherited PATH.
Interactive sessions are unavailable. Explicitly detached jobs with redirected
stdin/stdout/stderr can survive normal shell completion. Capture their PIDs and
inspect or stop them through later commands; they are not tracked by the core,
and Cancel after command completion does not stop them. A background child that
keeps an output pipe open keeps the command active until EOF or timeout.

The default command timeout is 30 seconds; a call can request 1–120000 ms.
Each stream retains at most 8192 bytes while excess output is drained. Timeout,
Cancel and Quit stop the active command's process group. A request may run at
most 16 tool calls, and 4 failed calls in a row (rejected, nonzero exit, or
timed out) end it early. In either case the core sends one last request with
tools disabled (tool_choice none), so Aiko replies normally with what she did
and what is not supported, instead of an error; if that reply still asks for
a tool, a fixed Thai "not supported" reply is used. Changes already
made to files or external systems are not rolled back. Commands use normal user
permissions without an added filesystem sandbox or command allowlist.
OPENAI_API_KEY and DEEPSEEK_API_KEY are removed from the child environment;
the selected provider key is redacted from returned strings before they reach
the model or Log. Other local secrets require the same care as ordinary shell use.

Configuration and providers
----------

The character is Aiko; Zaiko is the application name. Her prompt is compiled from
crates/zaiko-core/prompts/aiko.md, adapted from wfchat's authoritative character
profile. Both providers use the same prompt: calm, warm, lightly playful, concise,
and feminine Thai speech, with short replies in plain words that put the answer
first. Her fixed profile is birthday 2000-05-27, height 175 cm,
and weight 58 kg. Dedicated desktop tools cover terminal and vscode; general
local work uses run_command within the user's requested scope.
Prompt edits take effect after rebuilding, reinstalling, and restarting the core.

The core reads configuration once at startup. Environment variables take
precedence over the explicitly selected dotenv file. Only the selected key is
required. Missing configuration appears in chat as an error; direct app requests
remain available. The selected provider key is redacted from conversation and
command results, and does not appear in provider error reports.

OpenAI uses Responses with function-call outputs and retained reasoning items.
DeepSeek uses Chat Completions. Model names come from configuration without
automatic substitution. Requests have a five-minute deadline and at most 16
tool calls. Cancel stops active command processes but cannot undo completed work.

Session limits
----------

One request runs at a time. Duplicate request IDs cannot execute again.
Input is limited to 8192 bytes; history keeps at most 32 messages / 64 KiB.
After 4096 request IDs, restart to begin a new in-memory session.
History is not persisted after stop/restart.
```

## Development

```bash
# ---------- bash ---------- #

# Install the extension first, then start the development core without opening
# input. Click the character when ready to type.
make run

# Rust tests, desktop protocol tests, and isolated installer/D-Bus smoke.
make test

# Formatting, Rust lint, and JavaScript syntax.
make check

# Isolated GNOME compositor: character input/answer/Log, native event checks,
# fixed glass styling, failure paths, and lifecycle. Saves screenshots and a shell log.
make test-desktop

# Only the command picker: eight-row limit, native arrows/mouse wheel, filtering,
# completion/submission, focus, Escape, Vim, and cleanup. No live provider calls.
ZAIKO_QA_COMMANDS_ONLY=1 python3 tests/overlay-shell.py
```

## Details

```text
Verification boundary
==========

make test covers mock provider flows, request validation/cancellation, protocol
helpers, literal transcript presentation, and an isolated installer/session-bus
harness, including retired-module cleanup and configuration preservation. make check covers lint
and syntax. These commands do not call a live provider or start GNOME Shell.

Additional checks ran in a separate GNOME 50.1 compositor: rendered character and
chat, native virtual-pointer click/drag, Thai text retention, focus release,
disable/re-enable cleanup, and real zter/VS Code launch and repeated activation
before the change to new-window actions.
Live OpenAI conversation and tool follow-up passed using gpt-6.1-sol with a
simulated desktop tool target. Live DeepSeek and a physical Thai IME were not
tested. Updated extension code loads after logging out of GNOME and back in.

The terminal modes were checked with a real zter release build in a private
GNOME session: repeated default activation kept one primary window/tab, tab
requests added shells to the same process, standalone created a separate process,
and subsequent default/tab requests targeted the primary while standalone stayed
open. Cold tab startup created one primary tab. VS Code dispatch was checked
with a temporary launcher; provider mode routing used mock HTTP responses.

make test-desktop runs a private GNOME compositor and D-Bus session with temporary
HOME/XDG directories, no core or API credentials, and deterministic Submit/Cancel
responses. It exercises native pointer/keyboard input, Log conversation, repeated
character clicks and outside-click dismissal, five actual Pango rows including
the Aiko prefix, font scaling and disconnect
draft restoration, ignored legacy appearance settings, a narrow synthetic work
area, focus/menu
release, and disable/re-enable cleanup. Artifacts remain in the printed temporary
directory. A physical Thai IME and live providers are not exercised by this UI
test. The isolated run emitted Clutter input-focus warnings without extension
exceptions or observed failed interactions; their cause was not established.
Physical Thai IME, hardware scaling, and real lock/fullscreen transitions still
need hands-on verification.

Paths
==========

Launcher: ~/.local/bin/zaiko
Core and launcher support: ~/.local/share/zaiko/
Extension: ~/.local/share/gnome-shell/extensions/zaiko@znnn.local/
Configuration: ~/.config/zaiko/.env
Log: ~/.local/state/zaiko/core.log

The default installed runtime is independent of the source checkout.
XDG_CONFIG_HOME, XDG_DATA_HOME, and XDG_STATE_HOME override the default locations.
The development launcher uses the repository .env with the debug core.
Installed and development commands share the same session service; stop the
current core before switching builds or configuration paths.

Installer testing
----------

scripts/install.py supports --binary PATH, --config-source PATH, and --no-enable.
Reinstallation removes only retired theme modules/tests from the installed
extension, backs up replaced API configuration, and preserves ignored old ui.json and unrelated
files. The integration harness uses temporary HOME/XDG paths, synthetic keys, a private
session bus, and a fake desktop service. It never calls a provider or opens apps.
These checks do not by themselves verify pointer gestures or a real Thai IME.
```

[IPC contract](ipc.md)

[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

[DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/)

[Documentation](README.md)
