# zaiko

## Setup

```bash
# ---------- bash ---------- #

# Create .env without replacing an existing file.
[ -e .env ] || cp .env.example .env

# Set your API key in .env before installing.
# make install copies .env to ~/.config/zaiko/.env and backs up the old one
# as ~/.config/zaiko/.env.backup-<timestamp>.
make install
```

## Run

```bash
# ---------- bash ---------- #

zaiko
zaiko status
zaiko restart
zaiko stop
```

[Requirements and configuration](docs/runtime.md)

[Documentation](docs/README.md)
