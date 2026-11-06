import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {InputVim} from './vim.js';

// Linux evdev positions, independent of the active keyboard layout.
const NORMAL_KEYS = new Map([
    [5, ['4', '$']], [11, ['0', ')']],
    [17, ['w', 'W']], [19, ['r', 'R']], [23, ['i', 'I']], [24, ['o', 'O']],
    [30, ['a', 'A']], [32, ['d', 'D']], [35, ['h', 'H']], [36, ['j', 'J']], [37, ['k', 'K']],
    [38, ['l', 'L']], [46, ['c', 'C']], [48, ['b', 'B']],
]);

export class VimInput {
    constructor(entry, caret, submit, keepsFocus = null, onMode = null) {
        this.entry = entry;
        this._text = entry.clutter_text;
        this._caret = caret;
        this._submit = submit;
        this._onMode = onMode;
        this._state = new InputVim();
        this._enabled = false;
        this._available = false;
        this._cursorSize = this._text.get_cursor_size();
        this._cursorSource = 0;
        this._signals = [];
        const connect = (actor, name, callback) => this._signals.push([actor, actor.connect(name, callback)]);
        connect(entry, 'captured-event', (_actor, event) => this._event(event));
        if (keepsFocus) {
            connect(global.stage, 'notify::key-focus', () => {
                // Log stays open while focus is elsewhere, so keep its mode
                // for when the user comes back; closing Log calls leave().
                if (!entry.menu?.isOpen && !keepsFocus(global.stage.get_key_focus())) {
                    this._state.pending = '';
                    this._state.history = [];
                }
            });
        } else {
            connect(this._text, 'key-focus-out', () => {
                if (!entry.menu?.isOpen)
                    this.leave();
            });
        }
        connect(this._text, 'key-focus-in', () => this._normalCursor());
        connect(this._text, 'notify::cursor-position', () => {
            if (!this._updating)
                this._state.history = [];
            this._queueCursor();
        });
        connect(this._text, 'text-changed', () => {
            if (!this._updating) {
                this._state.pending = '';
                this._state.history = [];
            }
            this._queueCursor();
        });
        connect(entry, 'style-changed', () => this._queueCursor());
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
        const characters = Array.from(this._text.text);
        const length = characters.length;
        const cursor = this._text.get_cursor_position();
        const last = length - (characters.at(-1) === '\n' ? 0 : 1);
        const position = Math.max(0, Math.min(cursor < 0 ? length : cursor, last));
        this._text.set_selection(position, position);
    }

    _sync() {
        const mode = this._enabled && this._available ? this._state.mode : null;
        this._text.editable = this._available && mode !== 'normal';
        this._caret.setVimMode(mode);
        this._onMode?.(mode);
        this._syncCursor();
    }

    _queueCursor() {
        if (this._cursorSource)
            return;
        // Text-change signals can arrive before Clutter updates its Pango layout.
        this._cursorSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._cursorSource = 0;
            // A click can place the caret past the last character.
            if (this._clicked) {
                this._clicked = false;
                this._normalCursor();
            }
            this._syncCursor();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncCursor() {
        const block = this._enabled && this._available && this._state.mode !== 'insert';
        let size = this._cursorSize;
        if (block) {
            const length = Array.from(this._text.text).length;
            const cursor = this._text.get_cursor_position();
            const position = cursor < 0 ? length : Math.min(cursor, length);
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
        if (event.type() === Clutter.EventType.KEY_PRESS && !this._text.single_line_mode &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK &&
            !(event.get_state() & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)) &&
            (event.get_event_code() === 36 || [Clutter.KEY_j, Clutter.KEY_J].includes(event.get_key_symbol()))) {
            if (this._available) {
                this._state.reset('insert');
                this._updating = true;
                try {
                    this._text.delete_selection();
                    const position = this._text.get_cursor_position();
                    const cursor = position < 0 ? Array.from(this._text.text).length : position;
                    this._text.insert_text('\n', cursor);
                    this._text.set_selection(cursor + 1, cursor + 1);
                } finally {
                    this._updating = false;
                }
                this._sync();
            }
            return Clutter.EVENT_STOP;
        }
        if (!this._enabled || !this._available)
            return Clutter.EVENT_PROPAGATE;
        // Clicks only place the caret natively; entering insert mode needs i.
        if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this._state.pending = '';
            this._clicked = true;
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
            // Keep the mode after sending; the compact input resets when it closes.
            this._state.pending = '';
            this._state.history = [];
            this._submit();
            return Clutter.EVENT_STOP;
        }
        const special = new Map([
            [Clutter.KEY_Escape, 'Escape'], [Clutter.KEY_Left, 'Left'], [Clutter.KEY_Right, 'Right'],
            [Clutter.KEY_Home, 'Home'], [Clutter.KEY_End, 'End'], [Clutter.KEY_BackSpace, 'BackSpace'],
        ]);
        const unicode = event.get_key_unicode();
        const character = typeof unicode === 'number' ? (unicode ? String.fromCodePoint(unicode) : '') : unicode;
        // The character after r, insert mode and continuous replace mode must
        // keep the active layout: they are text, rather than Vim commands.
        const physical = this._state.mode === 'normal' && this._state.pending !== 'r'
            ? NORMAL_KEYS.get(event.get_event_code()) : null;
        const key = special.get(symbol) ?? (physical
            ? physical[event.get_state() & Clutter.ModifierType.SHIFT_MASK ? 1 : 0] : character);
        if (!key)
            return Clutter.EVENT_PROPAGATE;
        const result = this._state.handle(this._text.text, this._text.get_cursor_position(), key,
            position => this._text.position_to_coords(position)[1]);
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
        if (this._cursorSource)
            GLib.Source.remove(this._cursorSource);
        this._cursorSource = 0;
        for (const [actor, id] of this._signals)
            actor.disconnect(id);
        this._signals = [];
        this._text.set_cursor_size(this._cursorSize);
        this._caret.setVimMode(null);
    }
}
