# Zaiko

## Setup

```bash
# ---------- bash ---------- #

# Create .env without replacing an existing file.
[ -e .env ] || cp .env.example .env

# Set your API key in .env before installing.
# Installed config: `~/.config/zaiko/.env`
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
