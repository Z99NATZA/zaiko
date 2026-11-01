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
Only the selected provider's API key is required.

The installer copies the project .env to ~/.config/zaiko/.env on first install.
Reinstallation preserves existing keys and configuration. Edit the installed
file for subsequent changes, then run zaiko restart.

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

The GNOME 50 extension renders a 200 x 260 character on the primary monitor.
The 360 x 440 chat panel adapts to the available work area.
The companion follows workspaces and hides in Overview, fullscreen, and lock.
It reserves no desktop space and does not grab the keyboard globally.

The character appears while the Rust core owns its session D-Bus service.
The extension can be disabled without stopping the core. zaiko stop ends both
the core session and its visible companion; enabling the extension reconnects
to an existing core.

App tools
----------

Click the character to show or hide chat; drag her to move.
Cancel stops an in-progress request. Hiding chat preserves the conversation;
Quit or zaiko stop ends it.

Appearance
----------

The Theme button opens appearance settings; Back or Escape returns to chat.
Zaiko uses zhyprbola's eight palettes: Purple (default), White Mist, White Sky,
Forest Calm, One Half Gray, Red, Sakura, and Silver Dawn. Its flat card surface,
26 px outer corners, 11 px controls, 8/16 px gaps, desktop font family, 14 px
body, 12 px details, and semibold headings follow zhyprbola's cards and Settings.

Sync with zhyprbola is off by default. Turn it on to follow the theme saved in
~/.config/zhyprbola/theme, including changes while Zaiko is running. The file
is read-only to Zaiko; zhyprbola does not need to be running. While syncing,
manual theme buttons are disabled. Turning sync off restores your last manual
choice. A missing or unknown source uses that manual choice and waits for a
supported theme to appear. The legacy rose-galaxy name maps to Sakura.

Appearance is saved separately in ~/.config/zaiko/ui.json, with theme and
syncZhyprbola fields. Changes apply immediately and survive reinstalls and
restarts. Missing or corrupt settings fall back to Purple with sync off.
XDG_CONFIG_HOME overrides the config root for both applications.

Only terminal (zter) and vscode are supported. Existing windows are focused
without minimizing them; otherwise the app's desktop launcher is activated.
Success reports a launch/activation request, not verified window visibility.

Configuration and providers
----------

The character is Aiko; Zaiko is the application name. Her prompt is compiled from
crates/zaiko-core/prompts/aiko.md, adapted from wfchat's authoritative character
profile. Both providers use the same prompt: calm, warm, lightly playful, concise,
and feminine Thai speech. Her fixed profile is birthday 2000-05-27, height 175 cm,
and weight 58 kg. The desktop tool permissions remain terminal and vscode only.
Prompt edits take effect after rebuilding, reinstalling, and restarting the core.

The core reads configuration once at startup. Environment variables take
precedence over the explicitly selected dotenv file. Only the selected key is
required. Missing configuration appears in chat as an error; direct app requests
remain available. API keys never cross D-Bus or appear in provider error reports.

OpenAI uses Responses with function-call outputs and retained reasoning items.
DeepSeek uses Chat Completions. Model names come from configuration without
automatic substitution. Requests have a 90-second deadline and at most four
tool calls. Cancel cannot undo a launch already requested.

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

# Install the extension first, then build and run the development core.
make run

# Rust tests, desktop protocol tests, and isolated installer/D-Bus smoke.
make test

# Formatting, Rust lint, and JavaScript syntax.
make check
```

## Details

```text
Verification boundary
==========

make test covers mock provider flows, request validation/cancellation, protocol
helpers, live Gio theme monitoring/persistence in temporary directories, and an
isolated installer/session-bus harness. make check covers lint
and syntax. These commands do not call a live provider or start GNOME Shell.

Additional checks ran in a separate GNOME 50.1 compositor: rendered character and
chat, native virtual-pointer click/drag, Thai text retention, focus release,
disable/re-enable cleanup, and real zter/VS Code launch and repeated activation.
Live OpenAI conversation and tool follow-up passed using gpt-6.1-sol with a
simulated desktop tool target. Live DeepSeek and a physical Thai IME were not
tested. The installed extension still needs first discovery on the user's login.

Appearance was also checked in a separate GNOME 50 compositor: all eight
rendered palettes, theme controls, sync and restore, and disable/re-enable
cleanup. This uses a test conversation and no live provider calls.

Paths
==========

Launcher: ~/.local/bin/zaiko
Core and launcher support: ~/.local/share/zaiko/
Extension: ~/.local/share/gnome-shell/extensions/zaiko@znnn.local/
Configuration: ~/.config/zaiko/.env
Appearance: ~/.config/zaiko/ui.json
Log: ~/.local/state/zaiko/core.log

The default installed runtime is independent of the source checkout.
XDG_CONFIG_HOME, XDG_DATA_HOME, and XDG_STATE_HOME override the default locations.
The development launcher uses the repository .env with the debug core.
Installed and development commands share the same session service; stop the
current core before switching builds or configuration paths.

Installer testing
----------

scripts/install.py supports --binary PATH, --config-source PATH, and --no-enable.
The integration harness uses temporary HOME/XDG paths, synthetic keys, a private
session bus, and a fake desktop service. It never calls a provider or opens apps.
These checks do not by themselves verify pointer gestures or a real Thai IME.
```

[IPC contract](ipc.md)

[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

[DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/)

[Documentation](README.md)
