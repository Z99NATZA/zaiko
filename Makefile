.PHONY: build install run test test-desktop check

build:
	cargo build --release --locked

install:
	python3 scripts/install.py

run:
	cargo build --locked
	python3 scripts/launcher.py --no-present

test:
	cargo test --workspace --locked
	cargo build --workspace --locked
	node --test gnome-extension/tests/*.test.mjs
	gjs -m gnome-extension/tests/theme-settings.mjs
	gjs -m gnome-extension/tests/answer-preview.mjs
	python3 tests/smoke.py

# Starts a private GNOME compositor/session; never connects to a live provider.
test-desktop:
	python3 tests/overlay-shell.py

check:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	node --check gnome-extension/extension.js
	node --check gnome-extension/themes.js
	node --check gnome-extension/themeSettings.js
	node --check gnome-extension/answerPreview.js
