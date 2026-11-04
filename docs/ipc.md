# Zaiko IPC

## Contract

```text
Transport
==========

Use the current user's session D-Bus. Never send API keys over D-Bus.
The Rust core owns org.zaiko.Companion at /org/zaiko/Companion.
The GNOME extension owns org.zaiko.Desktop at /org/zaiko/Desktop.
Each interface has the same name as its bus service.

Core methods
----------

Submit(request_id: s, text: s) -> ()
OpenApp(request_id: s, app: s) -> ()
Cancel(request_id: s) -> ()
GetSnapshot() -> s
Show() -> ()
Quit() -> ()

Submit and OpenApp enqueue a bounded request and return immediately.
Reject a second active request and duplicate request IDs without executing again.
Only terminal and vscode are valid app aliases.
Cancel accepts the active request ID; it does not undo a completed app launch.
Show emits a present event and requests the desktop to present the companion.
Quit cancels active work and releases the core service.

Core signal
----------

Event(payload: s)

Payload is JSON with type and optional request_id, state, content, role, message.
Types: state, message, error, present. States: idle, thinking, working, error.
All user-visible conversation and request state can be recovered from GetSnapshot.
Snapshot JSON: messages [{role, content}], state, request_id, error, provider, model.
API keys and provider HTTP bodies are never included.

Desktop methods
----------

Present() -> ()
OpenApp(app: s) -> (success: b, message: s)

OpenApp requests a new window on every call. Success means a new-window launch
was requested, not independently verified window visibility. Unknown aliases and
launchers missing the required desktop action fail explicitly.
Use desktop IDs io.github.z99natza.zter.desktop and code.desktop/code-oss.desktop.
Use action new-window for zter (--standalone) and new-empty-window for VS Code
(--new-window). Existing windows are left open.

Lifecycle
----------

The extension watches the core service and shows the character while it is present.
Subscribe before loading the snapshot so a completed request cannot be missed.
Hiding chat preserves the core session and leaves the character visible.
Core disappearance disables chat requests and removes the companion overlay.
Disabling the extension removes its actors, subscriptions, timers and bus service.
The core can remain running after extension disable; zaiko stop ends it explicitly.
```
