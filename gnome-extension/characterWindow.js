import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const MODEL = 'Mao';
const RUNTIME_FILES = ['live2dcubismcore.min.js', 'pixi.min.js', 'cubism4.min.js'];

// Starts character/main.js (a GTK + WebKit window that renders the Live2D
// model on the GPU) as this compositor's own Wayland client, then keeps that
// window above other windows, on every workspace, out of Alt+Tab and the
// Overview, and under the extension's character actor. The actor stays on top
// of it and keeps handling clicks and drags, so the window never takes input.
export class CharacterWindow {
    static available(dir) {
        const live2d = dir.get_child('assets').get_child('live2d');
        return RUNTIME_FILES.every(name => live2d.get_child(name).query_exists(null)) &&
            live2d.get_child(MODEL).get_child(`${MODEL}.model3.json`).query_exists(null);
    }

    constructor(dir, width, height, {onReady, onExit}) {
        this._dir = dir;
        this._width = width;
        this._height = height;
        this._onReady = onReady;
        this._onExit = onExit;
        this._ready = false;
        this._visible = false;
        this._position = null;
        this._expression = 'neutral';
        this._window = null;
        this._windowSignals = [];
        this._writes = [];
        this._writing = false;
        this._speakSource = 0;
        this._destroyed = false;
        this._processState = null;
    }

    start() {
        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs)
            throw new Error('gjs is not installed');
        const main = this._dir.get_child('character').get_child('main.js').get_path();
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE,
        });
        this._focusBefore = global.display.focus_window;
        this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, [
            gjs, '-m', main, '--exit-with-stdin', '--model', MODEL,
            '--width', `${this._width}`, '--height', `${this._height}`,
        ]);
        this._process = this._client.get_subprocess();
        this._stdin = this._process.get_stdin_pipe();
        this._mapSignal = global.window_manager.connect_after('map',
            (_wm, actor) => this._adopt(actor.get_meta_window()));
        this._readOutput(new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()}));
        const state = this._processState = {exited: false};
        this._process.wait_async(null, () => {
            state.exited = true;
            if (this._destroyed)
                return;
            console.warn('Zaiko: Live2D character window exited');
            this._onExit?.();
        });
        this._send({expression: this._expression});
    }

    _readOutput(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            let line = null;
            try {
                [line] = source.read_line_finish_utf8(result);
            } catch {
                return;
            }
            if (line === null || this._destroyed)
                return;
            if (line === 'ready') {
                this._ready = true;
                this._apply();
                this._onReady?.();
            } else if (line.trim()) {
                console.log(`Zaiko character: ${line}`);
            }
            this._readOutput(stream);
        });
    }

    _adopt(window) {
        if (!window || this._window || this._destroyed || !this._client.owns_window(window))
            return;
        this._window = window;
        window.make_above();
        window.stick();
        if (typeof window.hide_from_window_list === 'function')
            window.hide_from_window_list();
        else
            this._client.hide_from_window_list?.(window);
        this._windowSignals.push(window.connect('unmanaged', () => {
            this._window = null;
            this._windowSignals = [];
        }));
        // A new window takes focus when it maps; give it back to the user's window.
        const previous = this._focusBefore;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._destroyed && this._window && global.display.focus_window === this._window &&
                previous && previous.get_compositor_private())
                previous.activate(global.get_current_time());
            return GLib.SOURCE_REMOVE;
        });
        this._apply();
    }

    // Keep the window where the character actor is, and show it only once
    // the model is on screen and the extension wants the character visible.
    _apply() {
        const window = this._window;
        if (!window)
            return;
        if (this._position)
            window.move_frame(true, this._position.x, this._position.y);
        const actor = window.get_compositor_private();
        if (actor)
            actor.visible = this._ready && this._visible;
    }

    setPosition(x, y) {
        this._position = {x: Math.round(x), y: Math.round(y)};
        this._apply();
    }

    setVisible(visible) {
        this._visible = visible;
        this._apply();
    }

    setExpression(name) {
        this._expression = name;
        this._send({expression: name});
    }

    // Move the mouth for a while, roughly matching the length of a reply.
    speak(characters) {
        if (this._speakSource)
            GLib.Source.remove(this._speakSource);
        this._send({speaking: true});
        const duration = Math.max(800, Math.min(6000, characters * 55));
        this._speakSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            this._speakSource = 0;
            this._send({speaking: false});
            return GLib.SOURCE_REMOVE;
        });
    }

    _send(message) {
        if (!this._stdin || this._destroyed)
            return;
        this._writes.push(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
        this._flush();
    }

    _flush() {
        if (this._writing || !this._writes.length || this._destroyed)
            return;
        this._writing = true;
        const bytes = this._writes.shift();
        this._stdin.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            this._writing = false;
            try {
                stream.write_bytes_finish(result);
            } catch {
                this._writes = [];
                return;
            }
            this._flush();
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._speakSource)
            GLib.Source.remove(this._speakSource);
        this._speakSource = 0;
        if (this._mapSignal)
            global.window_manager.disconnect(this._mapSignal);
        this._mapSignal = 0;
        for (const id of this._windowSignals)
            this._window?.disconnect(id);
        this._windowSignals = [];
        this._window = null;
        this._writes = [];
        // Closing stdin makes the window exit (--exit-with-stdin); force it
        // if it has not gone after a moment.
        const process = this._process;
        const state = this._processState;
        this._stdin?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this._stdin = null;
        if (process) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                if (!state.exited)
                    process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._process = null;
        this._client = null;
        this._onReady = null;
        this._onExit = null;
    }
}
