import GLib from 'gi://GLib';

// St.Entry handles focus and caret styling, but Clutter.Text does not blink it.
// Keep the native caret and follow the desktop's accessibility preferences.
export class CaretBlink {
    constructor(text, settings) {
        this._text = text;
        this._settings = settings;
        this._source = 0;
        this._signals = [];
        const reset = () => {
            this._reset();
            return false;
        };
        for (const signal of ['key-focus-in', 'key-focus-out', 'notify::mapped',
            'notify::editable', 'text-changed', 'notify::cursor-position',
            'notify::selection-bound', 'key-press-event', 'button-press-event'])
            this._signals.push([text, text.connect(signal, reset)]);
        for (const key of ['cursor-blink', 'cursor-blink-time', 'cursor-blink-timeout'])
            this._signals.push([settings, settings.connect(`changed::${key}`, reset)]);
        this._signals.push([text, text.connect('destroy', () => this.destroy())]);
        this._reset();
    }

    _stop() {
        if (this._source)
            GLib.Source.remove(this._source);
        this._source = 0;
    }

    _reset() {
        this._stop();
        const active = this._text.mapped && this._text.has_key_focus() && this._text.editable;
        this._text.set_cursor_visible(active);
        const timeout = this._settings.get_int('cursor-blink-timeout');
        if (!active || !this._settings.get_boolean('cursor-blink') || timeout <= 0)
            return;

        const deadline = GLib.get_monotonic_time() + timeout * 1_000_000;
        const interval = Math.max(1, Math.round(this._settings.get_int('cursor-blink-time') / 2));
        this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            if (GLib.get_monotonic_time() >= deadline) {
                this._source = 0;
                this._text.set_cursor_visible(true);
                return GLib.SOURCE_REMOVE;
            }
            this._text.set_cursor_visible(!this._text.get_cursor_visible());
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._stop();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._text = null;
        this._settings = null;
    }
}
