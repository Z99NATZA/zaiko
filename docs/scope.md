# Zaiko Log UI Scope

Updated 2026-11-02. Rewritten from scratch at the user's request. This document
contains only the latest authorized UI requirements and their acceptance plan.

## Current Requirements

| Area | Required behavior |
|---|---|
| Design | Use Zaiko's own simple layout rather than copying zhyprbola components |
| Alignment | All conversation text is left aligned |
| Messages | Place text directly in the transcript, with no bubble, card, or separate role heading |
| User prefix | Display `[Me]` before the message |
| Assistant prefix | Display `[Aiko]` before the message |
| Prefix colors | Use different theme-compatible colors for `[Me]` and `[Aiko]` only |
| Body color | Use the same message text color for both participants |
| Theme colors | Conversation surface, composer, body text, close control, and scrollbar follow the selected palette |
| Header | No visible Log title or header row in the conversation view |
| Close control | A circular floating button at the panel corner, outside content layout; support click and Escape |
| Scroll | Slim, rounded themed track/thumb with breathing room beside text |
| Character menu | Compact 8 px rounded frame with selected-palette colors; Log, Theme, Quit only, without a separator; input Copy/Paste menus remain native without added hints |
| Log composer | Include input and an embedded send/cancel icon in Log; Enter sends |
| After a Log send | Clear the submitted Log draft and keep Log open for continued conversation |
| Input exclusivity | While Log is open, character clicks and Present focus Log input; never open the normal character input |
| Closing Log | Allow the normal character input again after Log closes |
| Drafts | Keep each input's draft separate; hiding, failed submission, or core loss must not silently lose or overwrite drafts |
| Shared requests | Both inputs use the existing single-request guard, request IDs, cancellation, and error reporting |
| Thinking time | Show `[Aiko] Thinking... (3s)`, `(1m 30s)`, or `(2h 1m 30s)` using measured elapsed time; omit leading zero units |

Tool messages may use `[Action]`. Message contents are literal text: markup-like
input must render as text rather than being interpreted as formatting. Wrapped
and multiline messages retain their original contents in the transcript.
Changing theme must recolor prefixes without changing body-role colors, drafts,
or conversation. Existing appearance controls remain available; the new layout
is independent of their original reference application's component geometry.

## Retained Behavior

The character is still draggable. Outside Log, clicking the character shows its
compact input and an outside click hides it without consuming that click.
Successful compact submissions hide compact input; failures preserve the draft.
Plain messages above the head have no bubble, use at most five actual rendered
rows, and completed/error messages disappear after 12 seconds; the transcript
retains the full messages. Active Thinking status updates once per second and
remains visible until the request finishes. The elapsed clock continues across
tool phases of the same request, and stops on completion, core loss, or disable.
While Log is open, its transcript replaces the floating message. The countdown
continues, and closing Log restores the floating copy only if it has not expired.
`make run` does not request input presentation. Log/Theme/Quit remain reachable
from the character menu. Existing shell visibility and cleanup rules remain.

## Boundaries

Change the GJS UI, supporting presentation helpers, documentation, and relevant
checks. Keep the Rust core, providers, tools, assets, IPC, saved appearance
format, and installer behavior. No new persistent history or provider calls are
needed for verification.

## Plan and Team

| Stage | Owner | Deliverable |
|---|---|---|
| Scope | Lead `/root` | Clear the old plan and record these latest requirements |
| Implementation | Lead `/root` | Complete the delegated draft: flat transcript, prefix-only coloring, Log composer, exclusive input routing, focused checks |
| Independent review | `/root/log_review` | Review code and failure paths without production edits; independently approve the corrected result |
| Integration | Lead + reviewer | Native GNOME checks, repository checks, usage docs, and screenshot review |
| Installation | Lead | Install reviewed source and verify installed files |

The production author and reviewer must be different agents. The reviewer must
not edit production code and then approve that same edit. The lead owns docs,
shared verification wiring, native fixtures, integration, and installation.
The original delegated pair became unavailable; the lead completed implementation
and a new reviewer is checking the integrated result separately.

## Acceptance Checks

1. Transcript rows render `[Me] message` and `[Aiko] message` flush left without
   bubble/card backgrounds, rounded message containers, or separate headings.
2. Only prefixes have participant-specific colors. Body text uses the same color
   for both roles. Thai, newlines, long text, emoji, and `<>&` render literally.
3. Enter and the embedded icon send from Log exactly once, leave Log open, and
   keep the normal character input closed. Pending requests cannot overlap.
4. While Log is open, click/Present routes focus to Log input. After closing it,
   clicking the character opens normal input. Switching to Theme is handled
   explicitly without leaving both conversation inputs active.
5. Drafts are separate and restored to the originating input after failure/core
   loss. Log input and its context menu release focus correctly on hide/disable.
6. Cancel/errors work from Log; theme changes recolor prefixes without altering
   drafts or messages. Timed compact messages and make-run behavior remain.
7. Repository checks and the isolated GNOME fixture pass. Record physical IME,
   live-provider, hardware, or real lock/fullscreen limits separately.

## Progress

- Scope rewritten with the latest requirements, including prefix-only coloring.
- Implementation complete with plain transcript rows, per-prefix colors, and a
  source-aware Log composer that shares the existing request/cancel path.
- `make test` passed, including 15 Node cases, real Pango/Gio checks, Rust tests,
  and isolated installer/D-Bus smoke. `make check` and diff checks passed.
- `make test-desktop` passed in a private GNOME compositor: actual shaped
  prefix/body colors, literal Thai/markup-like text, Log Enter/icon/cancel,
  exclusive input routing, drafts and core loss, theme updates, expiry,
  overlapping-text prevention, and focus/menu/disable cleanup.
- `/root/log_review` independently approved the final code, scope, native result,
  and screenshot. The author and reviewer are separate agents.
- Verification used deterministic request fixtures; physical IME, live providers,
  hardware scaling, and real lock/fullscreen transitions were not exercised.
- `make install` passed and installed UI files match the reviewed source.
  Log out of GNOME and back in to load the updated extension code.
- Follow-up native checks passed for all eight themed surfaces, hidden header,
  floating circular close and Escape, actual themed scrollbar geometry/color
  and wheel events, live Thinking seconds, long-duration formatting, and ticker
  cleanup. Active status does not use the completed-message expiry countdown.
- `/root/log_review` independently approved this follow-up after reviewing the
  code, final native result, and screenshots. `make install` passed and installed
  files match this verified source.
- Context-menu styling applies only to Log / Theme / Quit on the character.
  The earlier added edit-menu labels are removed; Copy/Paste menus are native.
  Quit has no separator. Native menu/action/palette checks and `make check`
  passed for the corrected scope.

[Runtime and development](runtime.md) · [Documentation](README.md)
