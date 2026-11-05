import Clutter from 'gi://Clutter';
import {InputVim} from './vim.js';

export class VimInput {
    constructor(entry, caret, submit) {
        this.entry = entry;
        this._text = entry.clutter_text;
        this._caret = caret;
        this._submit = submit;
        this._state = new InputVim();
        this._enabled = false;
        this._available = false;
        this._cursorSize = this._text.get_cursor_size();
        this._signals = [];
        const connect = (actor, name, callback) => this._signals.push([actor, actor.connect(name, callback)]);
        connect(entry, 'captured-event', (_actor, event) => this._event(event));
        connect(this._text, 'key-focus-out', () => {
            if (!entry.menu?.isOpen)
                this.leave();
        });
        connect(this._text, 'key-focus-in', () => this._normalCursor());
        connect(this._text, 'notify::cursor-position', () => {
            if (!this._updating)
                this._state.history = [];
            this._syncCursor();
        });
        connect(this._text, 'text-changed', () => {
            if (!this._updating) {
                this._state.pending = '';
                this._state.history = [];
            }
            this._syncCursor();
        });
        connect(entry, 'style-changed', () => this._syncCursor());
    }

    setEnabled(enabled) {
        this._enabled = enabled;
        this.leave();
    }

    setAvailable(available) {
        this._available = available;
        this._sync();
    }

    leave() {
        this._state.reset();
        this._normalCursor();
        this._sync();
    }

    _normalCursor() {
        if (!this._enabled || this._state.mode !== 'normal' || this._text.get_selection())
            return;
        const length = Array.from(this._text.text).length;
        const cursor = this._text.get_cursor_position();
        const position = Math.max(0, Math.min(cursor < 0 ? length : cursor, length - 1));
        this._text.set_selection(position, position);
    }

    _sync() {
        const mode = this._enabled && this._available ? this._state.mode : null;
        this._text.editable = this._available && mode !== 'normal';
        this._caret.setVimMode(mode);
        this._syncCursor();
    }

    _syncCursor() {
        const block = this._enabled && this._available && this._state.mode !== 'insert';
        let size = this._cursorSize;
        if (block) {
            const length = Array.from(this._text.text).length;
            const cursor = this._text.get_cursor_position();
            const position = cursor < 0 ? length : cursor;
            const [startOk, x] = this._text.position_to_coords(position);
            const [endOk, nextX] = this._text.position_to_coords(Math.min(length, position + 1));
            size = startOk && endOk ? Math.max(8, Math.round(Math.abs(nextX - x))) : 8;
        }
        this._text.set_cursor_size(size);
        const color = this.entry.get_theme_node().get_color('caret-color');
        if (block)
            color.alpha = 100;
        this._text.set_cursor_color(color);
    }

    _event(event) {
        if (!this._enabled || !this._available)
            return Clutter.EVENT_PROPAGATE;
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this._state.reset('insert');
            this._sync();
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        if (event.get_state() & (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)) {
            if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) &&
                [Clutter.KEY_v, Clutter.KEY_V, Clutter.KEY_x, Clutter.KEY_X].includes(symbol)) {
                this._state.reset('insert');
                this._sync();
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol)) {
            if (!this._text.single_line_mode && event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
                this._state.reset('insert');
                this._sync();
                return Clutter.EVENT_PROPAGATE;
            }
            this._submit();
            this.leave();
            return Clutter.EVENT_STOP;
        }
        const special = new Map([
            [Clutter.KEY_Escape, 'Escape'], [Clutter.KEY_Left, 'Left'], [Clutter.KEY_Right, 'Right'],
            [Clutter.KEY_Home, 'Home'], [Clutter.KEY_End, 'End'], [Clutter.KEY_BackSpace, 'BackSpace'],
        ]);
        const unicode = event.get_key_unicode();
        const character = typeof unicode === 'number' ? (unicode ? String.fromCodePoint(unicode) : '') : unicode;
        const key = special.get(symbol) ?? character;
        if (!key)
            return Clutter.EVENT_PROPAGATE;
        const result = this._state.handle(this._text.text, this._text.get_cursor_position(), key);
        if (!result.handled)
            return Clutter.EVENT_PROPAGATE;
        this._updating = true;
        try {
            if (result.text !== this._text.text)
                this._text.set_text(result.text);
            this._text.set_selection(result.cursor, result.cursor);
        } finally {
            this._updating = false;
        }
        this._sync();
        return Clutter.EVENT_STOP;
    }

    destroy() {
        for (const [actor, id] of this._signals)
            actor.disconnect(id);
        this._signals = [];
        this._text.set_cursor_size(this._cursorSize);
        this._caret.setVimMode(null);
    }
}
