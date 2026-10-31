# Zaiko Scope and Work Plan

Created on 2026-10-31; updated on 2026-11-01. This document separates confirmed requirements, implementation decisions, and remaining acceptance work. The first app tools open zter and VS Code; the note tool is deferred.

## Authorized Work for This Round

The user authorized implementing the system, including user-local installation and the `zaiko` command. Use the root `README.md` for setup and run instructions, following the short command-focused style of `zdotfiles`. Keep `docs/README.md` as the documentation index and writing policy.

The local `.env` and its non-secret example are prepared. The implementation covers the Rust core, environment loader, OpenAI/DeepSeek adapters, app tools, GNOME overlay/chat, existing image assets, installer, and launcher. QA must distinguish verified backend/static behavior from real desktop and live-provider acceptance.

## Confirmed User Requirements

| Topic | Scope |
| --- | --- |
| Location | New project at `/home/znnn/my_code/zaiko` |
| Target system | Linux, primarily GNOME |
| Language and tools | Rust as the core language; add other tools where appropriate |
| Character | Start with 2D and a small overlay sized for conversation |
| Chat | Show or hide chat while keeping the character visible on the desktop |
| AI and tools | Chat with AI and ask it to open zter and VS Code in the first stage; defer the note tool |
| Terminal | Use zter |
| Install and launch | `make install` installs for the current user; `zaiko` starts or shows the companion without a duplicate core |
| Model selection | Select provider and model through environment configuration first |
| Providers and keys | Support OpenAI and DeepSeek; prepare `.env` now for local API key entry |
| Documentation | English; concise essentials first and extended details near the end; root README for setup/run |
| Code references | Inspect `zter` and `zhyprbola` to learn from tools and approaches already used on this machine |
| Image references | The implementation team may choose existing Aiko images or redraw them; preserve the palette if redrawn |

## Observed Findings

The inspected machine runs GNOME Shell 50.1 on Wayland. This is the initial environment for validating behavior, not a guarantee of support for every GNOME version or desktop environment.

| Reference | Findings relevant to Zaiko |
| --- | --- |
| [zter/Cargo.toml](../../zter/Cargo.toml) | Terminal written in Rust using GTK4 and VTE |
| [zter desktop entry](../../zter/data/io.github.z99natza.zter.desktop) | Has a `new-window` desktop action that runs `zter --standalone` |
| [zhyprbola architecture](../../zhyprbola/docs/architecture.md) | Separates GNOME Shell/GJS, Qt Quick/QML, and the C++ backend |
| [zhyprbola extension](../../zhyprbola/gnome-extension/extension.js) | Uses Shell chrome, desktop ID app lookup, and app activation |
| [zhyprbola screenshot edge](../../zhyprbola/gnome-extension/screenshotEdge.js) | Uses Shell actors, a D-Bus client, service tracking, and window show/hide behavior |
| [zhyprbola main.cpp](../../zhyprbola/main.cpp) | Screenshots has a resident process and a Show/Hide interface on session D-Bus |
| [Aiko images](../../wfchat/apps/web/public/images/aiko-pngtuber/) | Neutral, happy, shy, sad, and surprised PNGs with alpha and different dimensions |
| [wfchat PNGTuber renderer](../../wfchat/apps/web/src/features/avatar/renderers/pngtuber/PngTuberRenderer.tsx) | Uses separate expression images and motion applied to each whole image |
| [zdotfiles README](../../zdotfiles/README.md) | Short setup commands and links to detailed documentation |

The installed default for `text/plain` is GNOME Text Editor (`org.gnome.TextEditor.desktop`). This is reference information only; the user has removed the note tool from the current MVP.

These projects are references. Work on Zaiko does not include changing their code, settings, or installations, and they have not been selected as runtime dependencies.

## Architecture

The implementation uses a Rust core + GNOME Shell Extension/GJS + session D-Bus, with the interface defined in [IPC](ipc.md). Desktop acceptance remains a separate QA gate.

```text
GNOME Shell Extension / GJS
  2D character + chat + keyboard focus + app launching through GNOME
                       ↕ session D-Bus
Rust core
  Session conversation + LLM adapter + tool dispatch + request results
```

| Component | Responsibility |
| --- | --- |
| Rust core | Manage conversation, contact the LLM, validate tool calls, and track request state |
| GJS UI | Display the character and chat, accept text, manage focus, and connect app launching to GNOME |
| D-Bus | Exchange requests and results between UI and core, using request IDs to match responses |
| Asset manifest | Map expression and state names to images, including display dimensions and anchor points |

Rust is a confirmed requirement. GJS and D-Bus implement the responsibility split above. If desktop testing exposes problems that conflict with the goals, revisit the approach before expanding it. GTK4 and Qt Quick/QML are reference options, not runtime dependencies of Zaiko.

## MVP Behavior

### Character and Chat

- Display a small character with chat that can be shown or hidden. Hiding chat keeps the character visible and preserves the current session conversation.
- Accept Thai text and show status while waiting for AI or a tool.
- Click the character to toggle chat and drag it to reposition. Dragging does not toggle chat.
- The initial character area is 200 x 260 pixels; the chat area is 360 x 440, constrained to the primary monitor's work area.
- The companion follows workspaces and hides during Overview, fullscreen, and lock. Chat takes focus only when presented and releases it when hidden.
- Quit or `zaiko stop` ends the core session. Hiding chat preserves it. Disabling the extension removes the UI and leaves the core running.

### App Launch Tool

Use one tool that selects an app from two aliases:

```text
open_app(app: terminal | vscode)
```

Rust validates the app name before sending a launch request to the desktop side. Each alias maps to an agreed desktop ID or action, with app names and launch commands taken from predefined system configuration.

| Alias | Confirmed target | Window behavior |
| --- | --- | --- |
| `terminal` | zter: `io.github.z99natza.zter.desktop` | Focus an existing window, otherwise launch |
| `vscode` | `code.desktop`, with `code-oss.desktop` as a fallback | Focus an existing window, otherwise launch |

"Open" launches an app when it is not running and focuses an existing window otherwise. Explicit requests for a new window are outside the current tool contract. Do not reuse dock toggle behavior directly: the reference code minimizes an app when it already has focus.

Running `zter` again may create a window in the existing process. Choose a launch or activation method that matches the agreed behavior rather than inferring behavior from the command name alone.

Results must distinguish "launch requested" from "window confirmed visible" and report only what the system can verify. Provide clear results for invalid aliases, unavailable apps, and unresponsive services. The LLM must not claim launch success without a supporting tool result.

### Images and Motion

The reference palette is dark navy-black, vivid blue, white, and light purple, with dark hair accented in blue, blue-purple eyes, and silver accessories with blue gemstones.

The initial asset set contains unchanged copies of the five existing Aiko PNGs, with neutral as the initial expression. A manifest aligns visible bounds and anchor points without modifying the originals. The source images stay in `wfchat`.

The user has delegated the artwork choice, so no further user selection is needed between reuse and redraw. If desktop testing shows that the existing images cannot meet the small-overlay layout, the team may redraw them with the same palette and a consistent base pose.

State changes select an expression from the copied images. The existing images have no blink frames, speaking mouth frames, or rig.

### Provider and Model Configuration

Support OpenAI and DeepSeek through environment configuration. Read the selected provider, model ID, and matching API key at startup. Switching configuration and restarting selects another provider/model; hot reload and an in-app model selector are outside this first configuration step.

The local `.env` is available for API key entry. The Rust core loads and validates the selected configuration at startup. Exact names and handling are specified in [Configuration Details](#configuration-details).

## Remaining Acceptance Work

The implementation has selected the initial dimensions, app activation behavior, and lifecycle described above. Remaining checks do not block independent work.

| Decision | Must be resolved before |
| --- | --- |
| User-session Thai input method and normal desktop interaction | Final hands-on acceptance after the first login with Zaiko installed |
| Live DeepSeek model/account validation when that provider is selected | Claiming live DeepSeek acceptance; its adapter already has mock coverage |
| Compatibility beyond GNOME 50.1 on Wayland | Extending the current support claim |

Hotkeys, multiple monitors, and automatic startup have no defined requirements. Define additional scope before including them in the MVP.

## Outside This MVP

- The note app tool; its installed target can be revisited in a later scope
- Directing Codex CLI or other coding agents
- Running commands inside a terminal, arbitrary shell commands, editing files, or controlling other apps with mouse and keyboard input
- Speech output, voice input, Live2D, and 3D
- Long-term memory and retrieval
- Supporting other desktop environments or platforms beyond Linux/GNOME

## Work Plan

Stage 0 covers documentation, planning, and local configuration preparation. Stages 1–5 are the proposed application development plan. Validate overlay and focus behavior first, then validate app launching with deterministic requests before connecting the LLM.

| Stage | Deliverables | Completion criteria | Depends on |
| --- | --- | --- | --- |
| 0 — Scope and preparation | Root setup/run README, docs index, scope, plan, agent reviews, and ignored local `.env` | Updated decisions recorded; working links; API key entry available without implementing the runtime | User's documentation and `.env` instructions |
| 1 — Overlay prototype | Character or placeholder and chat on GNOME 50.1 Wayland, with an initial IPC contract | Character remains visible when chat is toggled; Thai input and focus work; workspace/fullscreen behavior is documented; disable/enable leaves no duplicate UI; request/result contract and app launch ownership are agreed before stage 2 | Defined prototype scope |
| 2 — App tools | Tool dispatch and mappings for zter and VS Code, testable through direct requests | Both apps can be opened; missing apps and invalid aliases are handled; duplicate result delivery does not execute the same request again | Stage 1: IPC and app activation behavior |
| 3 — Images and chat | Prepared copies of Aiko images, session chat, and waiting/working/error states | Alpha renders correctly; expression changes do not jump; hiding chat preserves the session; UI stays responsive while waiting for the core | Stage 1 and image preparation |
| 4 — LLM integration | Env loader, OpenAI/DeepSeek adapters, conversation, and tool calls through the stage 2 path | Provider/model changes take effect on restart; selected credentials are validated; conversation and tool calls work; timeouts and malformed responses are handled; success claims do not exceed tool results | Stages 2–3 and usable model/key configuration |
| 5 — MVP acceptance | Validation on the real desktop and a run guide describing implemented behavior | Acceptance criteria below pass, with repeatable start/stop commands | Stage 4 |

Once IPC is agreed in stage 1, Rust/tools work can proceed in parallel with asset and UI preparation. LLM integration must wait for a validated app launch path.

Each stage is complete only after QA approves the reviewed work and Main accepts the integrated result. A worker's completion report alone does not close a stage.

## Agent Team

The agents assembled for the initial documentation reviews:

| Agent | Responsibility for this round |
| --- | --- |
| `/root` | Consolidate findings, maintain root and docs READMEs and scope, and prepare `.env` with `.gitignore` |
| `/root/scope_review` | Review requirements, scope, acceptance criteria, and unconfirmed decisions |
| `/root/architecture_review` | Review reference project evidence, Rust/GJS/D-Bus boundaries, and prototype validation needs |
| `/root/work_plan` | Plan dependencies, deliverables, and ownership for development |

Use Main plus three agents for development, following the user's team layout. The existing agents are reassigned to Desktop, Core, and QA for implementation and review.

```text
Main Agent — Lead / Integrator
  Plan work, define contracts, assign tasks, integrate, and accept results
  |
  +-- Desktop — GJS / GNOME overlay / focus / D-Bus / character assets
  +-- Core    — Rust / LLM / tool dispatch / state
  +-- QA      — testing / asset validation / integration review / rework requests
```

| Role / assigned agent | Responsibility | Proposed ownership |
| --- | --- | --- |
| Main / `/root` | Plan work, define IPC and acceptance criteria, assign ownership, integrate, and accept QA-approved results | `docs/`, IPC contract, workspace `Cargo.toml`, setup/run scripts, and shared project-level files |
| Desktop / `/root/architecture_review` | Overlay, chat input, focus, GNOME app launching, D-Bus UI integration, extension lifecycle, and asset preparation | `gnome-extension/` if GJS is selected, and `assets/` |
| Core / `/root/work_plan` | Rust core, env loading, provider adapters, tool dispatch, request state, and the core side of D-Bus | `crates/`, including `crates/*/Cargo.toml` |
| QA / `/root/scope_review` | Review scope compliance, test behavior and failure paths, validate assets, inspect integration, and request rework | Acceptance checks, test fixtures, and review reports; independently review production changes |

The implementation uses the ownership directories above. Each file has one primary owner. For IPC changes, root consolidates the contract before both sides implement it. Assign shared file ownership explicitly for each task.

QA validates images prepared by Desktop: transparency, edges, size, anchor alignment, and state transitions. QA does not create the production artwork it approves. Desktop and Core may add their own focused tests; QA independently checks the submitted behavior and evidence.

### Review and Rework

1. Main assigns a bounded task with an owner, affected files, dependencies, and acceptance criteria.
2. The worker implements it and submits `Ready for review` with changed files, verification results, and unresolved limits.
3. QA independently reviews the work against the assigned scope and criteria. Report `Changes required` for defects or missing required evidence, including the location, expected behavior, observed result, and conditions for acceptance. Use `Approved` only when the criteria are supported by evidence.
4. Main routes each finding to its owner. The worker fixes it and resubmits; QA repeats the affected review and checks until the findings are resolved.
5. Main integrates the approved work. QA checks the combined behavior before Main closes the stage. Changes after approval need review of the affected behavior again.

The reviewer must be a different agent from the author of the work under review. QA sends findings back to the owner rather than silently fixing production code and approving its own changes. If QA must author a production fix, Main assigns a different reviewer for that fix. Do not mark desktop acceptance as passed based only on headless checks; report unverified behavior explicitly.

## Proposed MVP Acceptance Criteria

1. On the target GNOME/Wayland environment, display a small character in the agreed form and repeatedly show or hide chat while keeping the character visible.
2. Accept Thai input, converse with the LLM, and preserve conversation within the session when chat is hidden.
3. Requests to open a terminal and VS Code through chat produce tool calls that launch zter and VS Code. The note alias is outside the supported tool set.
4. Unavailable apps, an unresponsive LLM, or a disconnected core produce understandable status, and the UI can return to use.
5. Report app launch results according to what the system can confirm, with the agreed focus/window behavior.
6. Repeatedly stop/start the companion or disable/enable the extension without stale UI or tools executing again from old requests.
7. OpenAI and DeepSeek can each be selected through env with a compatible model ID and the matching key. Configuration changes take effect on restart, and missing configuration produces a clear error.

Check Rust/tool validation and failure paths with checks appropriate to the behavior. Validate overlay, keyboard focus, app activation, and lifecycle in a real GNOME session. Headless checks alone cannot confirm desktop behavior.

## Validation Topics During Development

- Accepting text and returning keyboard focus on GNOME Shell without disrupting other apps
- Compatibility with the target GNOME version and overlay behavior across workspaces, Overview, and fullscreen
- The distinction between requesting an app launch and observing a ready window
- Character size or position jumps caused by different image dimensions and poses
- Waiting for the core, D-Bus, or LLM without freezing GNOME Shell

## Configuration Details

The following names are Zaiko's configuration contract. The local `.env` and non-secret [`.env.example`](../.env.example) have the same four variable names. The user selected `openai` with `gpt-6.1-sol`, which are also the template defaults.

Whenever variables are added, removed, or renamed in `.env`, update `.env.example` in the same change. Both files must have exactly the same variable names. Their values may differ; API keys and other secrets must remain empty in the example.

| Variable | Purpose |
| --- | --- |
| `ZAIKO_LLM_PROVIDER` | `openai` or `deepseek`; defaults to `openai` |
| `ZAIKO_LLM_MODEL` | Model ID for the selected provider; currently `gpt-6.1-sol` |
| `OPENAI_API_KEY` | Local OpenAI API key; empty in `.env.example`, filled only in `.env` |
| `DEEPSEEK_API_KEY` | Local DeepSeek API key; empty in `.env.example`, filled only in `.env` |

The loader reads the selected dotenv file at startup and lets existing process environment values override file values. Require a model ID and only the selected provider's key. An invalid provider, missing key, or missing model produces a clear configuration error rather than silently switching providers. Installed launches use the user-local config; development launches use the repository `.env`.

API keys stay in the Rust process and are excluded from UI/IPC payloads, logs, and Git. The root `.gitignore` excludes `.env` and `.env.*` and permits `.env.example` as a non-secret template. The setup command in the [main README](../README.md) copies the template only when `.env` does not exist, preserving local keys. The installer likewise preserves existing user-local configuration and never generates API keys.

Back to the [documentation index](README.md).
