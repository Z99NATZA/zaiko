# Zaiko

## Setup

```bash
# ---------- bash ---------- #

# Create .env without replacing an existing file.
[ -e .env ] || cp .env.example .env

# Set your API key in .env before installing.
make install
```

After the first installation, log out and back in if GNOME does not show Zaiko.

## Run

```bash
# ---------- bash ---------- #

zaiko
zaiko status
zaiko restart
zaiko stop
```

Installed config: `~/.config/zaiko/.env`.

Click Aiko to type; click elsewhere to hide input. Enter or the send icon sends
and hides input. Replies appear as `[Aiko] message` for 12 seconds. Right click for **Log**,
**Theme**, or **Quit**, including optional **Sync with zhyprbola**.

Log shows flat `[Me]` / `[Aiko]` text with colored prefixes and a built-in input.
While Log is open, character clicks focus its input instead of the compact one.

[Requirements and configuration](docs/runtime.md)

[Documentation](docs/README.md)
