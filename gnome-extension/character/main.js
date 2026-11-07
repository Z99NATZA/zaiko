// Zaiko character window: a transparent, undecorated GTK window whose
// WebKit view renders the Live2D model on the GPU. The GNOME extension starts
// it, places it, and sends commands on stdin as JSON lines:
//   {"expression": "happy"}   neutral, happy, shy, sad, surprised
//   {"speaking": true}         animate the mouth while a reply streams
// It prints "ready" on stdout once the model is shown.
//
// Usage: gjs -m main.js [--model Mao] [--width 200] [--height 260]
//                       [--exit-with-stdin] [--snapshot out.png]
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const EXPRESSIONS = new Set(['neutral', 'happy', 'shy', 'sad', 'surprised']);

function parseArgs(argv) {
    const options = {model: 'Mao', width: 200, height: 260, exitWithStdin: false, snapshot: null};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--model')
            options.model = argv[++i];
        else if (arg === '--width')
            options.width = Number.parseInt(argv[++i], 10);
        else if (arg === '--height')
            options.height = Number.parseInt(argv[++i], 10);
        else if (arg === '--exit-with-stdin')
            options.exitWithStdin = true;
        else if (arg === '--snapshot')
            options.snapshot = argv[++i];
        else
            throw new Error(`unknown argument: ${arg}`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(options.model))
        throw new Error('model name may only contain letters, digits, _ and -');
    return options;
}

class CharacterWindow {
    constructor(options) {
        this._options = options;
        this._ready = false;
        this._pending = [];

        this._window = new Gtk.Window({
            title: 'Zaiko Character',
            decorated: false,
            app_paintable: true,
            resizable: false,
            accept_focus: false,
            skip_taskbar_hint: true,
            skip_pager_hint: true,
        });
        this._window.set_default_size(options.width, options.height);
        const visual = this._window.get_screen().get_rgba_visual();
        if (visual)
            this._window.set_visual(visual);
        this._window.connect('destroy', () => Gtk.main_quit());

        const manager = new WebKit2.UserContentManager();
        manager.register_script_message_handler('zaiko');
        manager.connect('script-message-received::zaiko', (_manager, result) => {
            const value = typeof result.get_js_value === 'function' ? result.get_js_value() : result;
            this._onPageMessage(value.to_string());
        });

        this._view = new WebKit2.WebView({user_content_manager: manager});
        const settings = this._view.get_settings();
        settings.enable_webgl = true;
        settings.allow_file_access_from_file_urls = true;
        settings.enable_write_console_messages_to_stdout = true;
        settings.hardware_acceleration_policy = WebKit2.HardwareAccelerationPolicy.ALWAYS;
        this._view.set_background_color(new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 0}));
        this._view.connect('context-menu', () => true);
        this._window.add(this._view);

        const page = GLib.build_filenamev([HERE, 'web', 'index.html']);
        const query = `?model=${encodeURIComponent(options.model)}`;
        this._view.load_uri(GLib.filename_to_uri(page, null) + query);
        this._window.show_all();
    }

    _onPageMessage(message) {
        if (message === 'ready') {
            this._ready = true;
            print('ready');
            for (const script of this._pending.splice(0))
                this._run(script);
            if (this._options.snapshot)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => this._snapshot());
        } else {
            printerr(`zaiko-character: ${message}`);
            if (message.startsWith('error') && this._options.snapshot)
                Gtk.main_quit();
        }
    }

    _snapshot() {
        this._view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.TRANSPARENT_BACKGROUND,
            null, (view, result) => {
                try {
                    view.get_snapshot_finish(result).writeToPNG(this._options.snapshot);
                    print(`snapshot ${this._options.snapshot}`);
                } catch (error) {
                    printerr(`zaiko-character: snapshot failed: ${error.message}`);
                }
                Gtk.main_quit();
            });
        return GLib.SOURCE_REMOVE;
    }

    _run(script) {
        if (!this._ready) {
            this._pending.push(script);
            return;
        }
        if (typeof this._view.evaluate_javascript === 'function')
            this._view.evaluate_javascript(script, -1, null, null, null, null);
        else
            this._view.run_javascript(script, null, null);
    }

    command(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            printerr(`zaiko-character: ignoring non-JSON command: ${line}`);
            return;
        }
        if (EXPRESSIONS.has(message.expression))
            this._run(`window.zaiko.setExpression(${JSON.stringify(message.expression)})`);
        if (typeof message.speaking === 'boolean')
            this._run(`window.zaiko.setSpeaking(${message.speaking})`);
    }
}

function readCommands(character, exitWithStdin) {
    const input = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({fd: 0, close_fd: false}),
    });
    const next = () => input.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
        let line = null;
        try {
            [line] = stream.read_line_finish_utf8(result);
        } catch (error) {
            printerr(`zaiko-character: stdin: ${error.message}`);
        }
        if (line === null) {
            // The extension closed our stdin: it is gone, so we go too.
            if (exitWithStdin)
                Gtk.main_quit();
            return;
        }
        if (line.trim())
            character.command(line);
        next();
    });
    next();
}

GLib.set_prgname('zaiko-character');
Gtk.init(null);
const options = parseArgs(ARGV);
const character = new CharacterWindow(options);
readCommands(character, options.exitWithStdin);
Gtk.main();
