# Zaiko Character UI Plan

Updated 2026-11-02 for the user's follow-up authorized with `ok impl`.
This supersedes the temporary comparison interface from the previous iteration.

## Objective

Remove the old chat/comparison interface. Use character input that opens on click
and dismisses on an outside click, and display the latest answer as plain text
in the form `[Aiko] message`. Keep zhyprbola themes and the full retained Log.

## Requirements and Decisions

| Area | Required behavior |
|---|---|
| Old UI | Remove the old comparison panel, its composer, and automatic comparison presentation |
| Left click | Always show and focus compact input; clicking the character again keeps it open |
| Outside click | Hide input when pressing outside input and character; let the same click reach its original target |
| Input interaction | Clicking text, send/cancel, or its text-edit context menu keeps input usable; retain the draft when hiding |
| Input position | Overlay the bottom of the character, with the embedded send icon and Enter support |
| Input styling | Use the reference's slim translucent outlined strip, tinted by the selected Zaiko palette; 38 px height, 13 px text, and a small outlined send icon |
| Answer | Display only text above the character, prefixed `[Aiko] `; no card surface, border, padding, or reserved bubble space |
| Line limit | Grow to actual content height, capped at five rendered wrapped lines including the prefix; keep full response in Log |
| Right click | Keep Log available in the character menu; use an on-demand read-only transcript without the old composer |
| Appearance and exit | Keep Theme, optional zhyprbola sync, and Quit reachable from the character menu |
| Dragging | Preserve left-button dragging and click/drag arbitration |
| Request behavior | Keep whitespace validation, single active submission, Enter/icon sending, cancellation, and draft restoration on failure/core loss |
| After sending | Hide input and release its focus after successful submission; keep it open and restore the draft if submission fails |
| Message lifetime | Hide each displayed message after 12 seconds without extending it on repaint/theme/input changes; retain full text in Log |
| Lifecycle | Keep visibility/focus behavior and remove outside-click handlers, menus, actors, monitors, and timers on disable |

The initial connected character has no automatic conversation panel. Presenting
Zaiko through its normal launcher opens input; `make run` uses `--no-present`
and starts without requesting input. Click the character to type. Only explicit
Log/Theme actions open a support panel. Input dismissal does not remove the latest answer or draft.
Outside-click observation must not take a modal grab or consume/replay events.
The entry's own text-edit menu is treated as part of input interaction.

## Boundaries

Keep the Rust core, provider configuration, app tools, assets, D-Bus contract,
installer, and saved appearance format. Log means all messages retained in the
current session under existing history limits. Persistent logs, voice, artwork,
and physical input-method configuration are outside this change.

## Work Plan

| Stage | Owner | Deliverable | Acceptance |
|---|---|---|---|
| 1. Updated contract | Lead + reviewer | Record removal of comparison UI and revised pointer/text behavior | Current user instructions reflected in this document |
| 2. Implementation | Desktop author | Single composer, outside-click dismissal, transparent answer, read-only Log and Theme access | Code and focused checks submitted for review |
| 3. Independent review | Reviewer | Check event propagation/exclusions, focus, prefix/line limits, and cleanup | Findings fixed and checked by someone other than the author |
| 4. Verification | Lead + reviewer | Native pointer/keyboard GNOME fixture plus repository checks | Repeat-click, outside click, Log, theme, requests, shaping, and lifecycle pass |
| 5. Installation | Lead | Install verified source and update usage docs | Installed files match source; explain GNOME reload requirement |

## Agent Team

| Agent | Role | Ownership |
|---|---|---|
| `/root` | Lead / integrator | Documentation, shared check wiring, native desktop fixture, integration and installation |
| `/root/desktop_impl` | Implementation author | GJS UI, layout/content helpers, palettes/styles and focused author tests |
| `/root/ui_review` | Independent reviewer | Code/scope review, separate acceptance checks, findings and final review |

Continue the separately assigned implementer/reviewer team from this UI task.
The reviewer reports findings rather than changing production code and approving
that same change. The author fixes findings and the reviewer checks them again.

## Acceptance Checks

1. No legacy panel/composer is created or shown by startup or Present. Log is
   read-only and opens only on request; Theme and Quit remain accessible.
2. Repeated character clicks always leave input visible and focused. An outside
   press hides it and still activates the original target exactly once.
3. Input descendants and the entry context menu remain usable. Clicking send,
   Enter, cancellation, drag, and right click preserve their intended behavior.
4. Answers have transparent surroundings with no padding/card and show the
   literal `[Aiko] ` prefix. Short answers use only their real height; long Thai,
   explicit newlines, unbroken text, emoji, and scaled fonts stay within five
   actual visual rows. Log retains the full original text.
5. Drafts survive hiding, failed requests, and core disconnection. Busy requests
   cannot overlap; a new draft is not overwritten by an old failure.
6. All theme choices and live sync apply; screen-edge/narrow-layout and focus/menu
   cleanup work; disable/re-enable does not leave duplicate outside-click handlers.
7. Repository and native desktop fixture checks pass. Physical IME/hardware and
   real lock/fullscreen verification remain distinct from the isolated fixture.

## Progress and Evidence

- Implementation complete: old comparison/composer actors removed; one input,
  direct transparent prefixed answer label, and explicit read-only Log/Theme.
- Native desktop verification passed: repeated character clicks, entry/context
  menu exclusions, outside focusable and nonfocusable targets receiving exactly
  one click, preserved drafts, Enter/send/cancel/core-loss recovery, five actual
  text rows with prefix/font scaling, themes/sync and cleanup. GNOME 50 resolves
  event targets with stage.get_event_actor; the fixture checks that handler is
  disconnected after disable.
- Follow-up native verification passed for hiding input after Enter/icon submit,
  keeping failed drafts visible, a real twelve-second message timeout with no
  restart on repaint/theme/input, Log retention, identical new replies, and
  expiry-timer cleanup on disable.
- Repository verification passed: `make test` (12 Node cases, real Pango/Gio,
  Rust and installer/D-Bus suites), `make check`, and `git diff --check`.
- Independent review: `/root/ui_review` approved the revised source, usage docs,
  and native fixture after checking the final result and plain-text screenshot.
- Local installation: `make install` passed and installed UI files match the
  reviewed source. Log out of GNOME and back in to load the updated code.
- Verification boundary: isolated GNOME uses deterministic request fixtures and
  no live provider calls; physical Thai IME is not part of that test.

[Runtime and development](runtime.md) · [IPC contract](ipc.md) ·
[Documentation](README.md)
