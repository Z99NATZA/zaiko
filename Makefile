.PHONY: build install run test check

build:
	cargo build --release --locked

install:
	python3 scripts/install.py

run:
	cargo build --locked
	python3 scripts/launcher.py

test:
	cargo test --workspace --locked
	cargo build --workspace --locked
	node --test gnome-extension/tests/*.test.mjs
	gjs -m gnome-extension/tests/theme-settings.mjs
	python3 tests/smoke.py

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	node --check gnome-extension/extension.js
	node --check gnome-extension/themes.js
	node --check gnome-extension/themeSettings.js
