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
OpenTerminal(request_id: s, mode: s) -> ()
Cancel(request_id: s) -> ()
GetSnapshot() -> s
Show() -> ()
Quit() -> ()

Submit, OpenApp, and OpenTerminal enqueue a bounded request and return immediately.
Reject a second active request and duplicate request IDs without executing again.
Submit recognizes /status after trimming whitespace and responds locally without
constructing a provider client or running tools, including when configuration is
invalid. It reports the state before reserving this request, provider/model, and
current permission boundaries. It also recognizes /model: without arguments it
reports the active provider/model; /model <model-id> switches the model used by
later provider requests for this core session only, switching provider and key
when the model belongs to the other provider (a restart returns to configuration).
A successful switch, including to the active model, finishes during Submit: it adds
no message (so nothing reaches the provider history), skips the thinking state and
emits only an idle state event.
Invalid IDs, IDs equal to the API key, and
switches while configuration is invalid are rejected with a reply and without changing the model.
A rejected request (active slot or duplicate ID) never switches the model.
/exit never reaches Submit: the extension calls
Quit instead. Arguments and unknown slash commands receive local
usage/unsupported replies. Local replies use the normal message/state events and
retained history; the same active-slot and request-ID guards apply.
Only terminal and vscode are valid app aliases.
OpenApp uses default mode. OpenTerminal accepts default, tab, or standalone;
unknown modes fail before reserving a request ID.
Cancel accepts the active request ID and stops an active command process group;
it does not undo completed changes or app launches.
Show emits a present event and requests the desktop to present the companion.
Quit cancels active work and releases the core service.

Core signal
----------

Event(payload: s)

Payload is JSON with type and optional request_id, state, content, role, message.
Types: state, message, error, present. States: idle, thinking, working, error.
All user-visible conversation and request state can be recovered from GetSnapshot.
Snapshot JSON: messages [{role, content}], state, request_id, error, provider, model.
provider and model are the active session pair, including a /model switch. models lists
picker choices: ZAIKO_LLM_MODEL, then ZAIKO_LLM_MODELS, then IDs switched to
in this session; empty when configuration is invalid.
The selected provider API key and provider HTTP bodies are never included.
Commands and compact command results are retained as assistant messages.

Desktop methods
----------

Present() -> ()
OpenApp(app: s) -> (success: b, message: s)
OpenTerminal(mode: s) -> (success: b, message: s)

OpenApp("terminal") requests the primary zter instance, presenting its existing
window or opening it with one tab. OpenTerminal("default") does the same.
OpenTerminal("tab") adds a tab to the primary instance via new-tab (--new-tab),
or opens its first window with one tab if absent. OpenTerminal("standalone")
opens a separate instance via new-window (--standalone). Default and tab never
target a standalone instance. OpenApp("vscode") opens a new VS Code window via
new-empty-window (--new-window).

Success means the activation, tab, or window request was submitted, not verified
visibility. Unknown aliases, modes, and missing desktop actions fail explicitly.
Use desktop IDs io.github.z99natza.zter.desktop and code.desktop/code-oss.desktop.

The provider open_app tool accepts app plus nullable mode (default, tab,
standalone). Omitted/null mode defaults to default. Only terminal accepts tab or
standalone; VS Code uses default. Duplicate tool calls for the same app and mode
within a request execute once; different modes are distinct actions.

The run_command provider tool accepts command, nullable workdir, and nullable
timeout_ms. It executes in the Rust core; no raw-command method is exported by
the desktop service. Output contains success, exit_code, stdout, stderr,
timed_out, truncated, and workdir, or success=false plus a validation/start error.
Tool call IDs are replay-protected. A new ID can run the same command again,
allowing reads to observe changes made by earlier commands.

Lifecycle
----------

The extension watches the core service and shows the character while it is present.
Subscribe before loading the snapshot so a completed request cannot be missed.
Hiding chat preserves the core session and leaves the character visible.
Core disappearance disables chat requests and removes the companion overlay.
Disabling the extension removes its actors, subscriptions, timers and bus service.
The core can remain running after extension disable; zaiko stop ends it explicitly.
```
