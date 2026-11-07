# Zaiko

## Overview

```text
Desktop companion
==========

A small 3D chibi AI character for Linux, with compact input at her bottom, answers
above her head, and a full conversation Log available through right click.
Click the character to type and click elsewhere to hide input. Replies are
plain text; the old comparison panel is removed.
Log has its own input and flat left-aligned messages. Participant prefixes use
different colors while message bodies share one color. Log owns conversation
input while it is open. All surfaces use a fixed One Half Dark palette;
there is no theme chooser or sync.

Use Rust as the core. Start with GNOME on Wayland.
The first tools open zter and VS Code from chat.

Current state
----------

The Rust core, GNOME extension, app tools, and user-local installer are implemented.
The target desktop runs GNOME Shell 50.1 on Wayland.
```

## Documentation

| Document | Purpose |
|---|---|
| [Setup and run](../README.md) | Main entry point for local configuration and application commands |
| [Runtime and development](runtime.md) | Lifecycle, configuration, paths, limits, and verification commands |
| [IPC contract](ipc.md) | Rust/GNOME session D-Bus methods, signals, and ownership |
| [Scope](scope.md) | Current character UI plan, implementation/review ownership, and acceptance evidence |
| [Docs format guide](docs-format-guide.md) | Layout examples for project documentation |

## Notes

```text
Documentation policy
==========

Write documentation in English. Keep it concise and immediately understandable.
Put essential information first. Place optional explanations and extended detail
near the end of each file for readers who want the full context.

Follow docs-format-guide.md. scope.md retains its existing Markdown structure.

Environment files
----------

Whenever variables are added, removed, or renamed in .env, update .env.example
in the same change. Both files must have exactly the same variable names.
Keep API keys and other secrets empty in .env.example.

Commits
----------

Commit format: 1 line en https://www.conventionalcommits.org/en/v1.0.0
```

## Details

```text
Workspace and references
==========

Project: /home/znnn/my_code/zaiko

zter and zhyprbola provide examples of desktop tools already used on this machine.
Aiko's desktop character is authored in Blender as a rigged 3D model, exported
to gnome-extension/assets/models/aiko/aiko.glb, and rendered live in the Shell
actor with expression changes driven by chat state.
The confirmed terminal is zter. The note tool is deferred from the MVP.

Configuration
----------

The local .env is ready for OpenAI and DeepSeek API keys and is excluded from Git.
.env.example has the same four variables with empty keys and can be committed.
See the main README for the setup command, which preserves an existing .env.
Provider/model selection uses environment configuration at startup.
The installed runtime reads the user-local configuration copied at first install.

Current UI iteration
----------

The 2026-11-02 UI scope replaces the original MVP plan. The lead integrates,
a desktop agent implements, and a different agent independently reviews.
See scope.md for the active requirements and verification status.
```
