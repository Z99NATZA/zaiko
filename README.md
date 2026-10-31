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

[Requirements and configuration](docs/runtime.md)

[Documentation](docs/README.md)
