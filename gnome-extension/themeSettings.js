import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAppearance, resolveAppearance, themeFor} from './themes.js';

// Only Zaiko's ui.json is writable here. zhyprbola remains a read-only source.
export class ThemeSettings {
    constructor(onChanged, configRoot = GLib.get_user_config_dir()) {
        this._onChanged = onChanged;
        this._root = configRoot;
        this._directory = GLib.build_filenamev([configRoot, 'zaiko']);
        this._path = GLib.build_filenamev([this._directory, 'ui.json']);
        this._externalDirectory = GLib.build_filenamev([configRoot, 'zhyprbola']);
        this._externalPath = GLib.build_filenamev([this._externalDirectory, 'theme']);
        this._monitors = [];
        this._refreshSource = 0;
        this._destroyed = false;
        this.error = null;
    }

    start() {
        if (GLib.mkdir_with_parents(this._directory, 0o700) !== 0)
            this.error = 'Could not create appearance settings directory.';
        this._refresh();
    }

    _read(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes) : null;
        } catch (_error) {
            return null;
        }
    }

    _refresh() {
        if (this._destroyed)
            return;
        this.settings = parseAppearance(this._read(this._path));
        this.appearance = resolveAppearance(this.settings,
            this.settings.syncZhyprbola ? this._read(this._externalPath) : null);
        this._watchDirectories();
        this._onChanged(this);
    }

    _watchDirectories() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        const paths = [this._root, this._directory];
        if (this.settings.syncZhyprbola)
            paths.push(this._externalDirectory);
        for (const path of paths) {
            if (!GLib.file_test(path, GLib.FileTest.IS_DIR))
                continue;
            try {
                const monitor = Gio.File.new_for_path(path)
                    .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                monitor.connect('changed', (_monitor, file, otherFile) => {
                    const names = [file?.get_basename(), otherFile?.get_basename()];
                    if (names.some(name => ['ui.json', 'theme', 'zaiko', 'zhyprbola'].includes(name)))
                        this._queueRefresh();
                });
                this._monitors.push(monitor);
            } catch (_error) {
                this.error = 'Could not watch theme changes. Reopen Zaiko to refresh.';
            }
        }
    }

    _queueRefresh() {
        if (this._refreshSource || this._destroyed)
            return;
        // Coalesce writes and re-arm directory watches after atomic replacement.
        this._refreshSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
            this._refreshSource = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    setTheme(id) {
        if (this.settings.syncZhyprbola)
            return;
        this._save({...this.settings, theme: themeFor(id).id});
    }

    setSync(enabled) {
        this._save({...this.settings, syncZhyprbola: enabled === true});
    }

    _save(settings) {
        try {
            if (GLib.mkdir_with_parents(this._directory, 0o700) !== 0)
                throw new Error('Cannot create settings directory');
            Gio.File.new_for_path(this._path).replace_contents(
                new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`),
                null, false, Gio.FileCreateFlags.PRIVATE, null);
            this.error = null;
        } catch (_error) {
            this.error = 'Could not save appearance settings.';
        }
        this._refresh();
    }

    destroy() {
        this._destroyed = true;
        if (this._refreshSource)
            GLib.Source.remove(this._refreshSource);
        this._refreshSource = 0;
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        this._onChanged = null;
    }
}
