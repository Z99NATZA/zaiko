import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {InputVim} from './vim.js';

// Linux evdev positions, independent of the active keyboard layout.
const NORMAL_KEYS = new Map([
    [5, ['4', '$']], [11, ['0', ')']],
    [17, ['w', 'W']], [19, ['r', 'R']], [23, ['i', 'I']], [24, ['o', 'O']],
    [22, ['u', 'U']], [30, ['a', 'A']], [32, ['d', 'D']], [34, ['g', 'G']], [35, ['h', 'H']],
    [36, ['j', 'J']], [37, ['k', 'K']], [38, ['l', 'L']], [45, ['x', 'X']], [46, ['c', 'C']],
    [47, ['v', 'V']], [48, ['b', 'B']],
]);

export class VimInput {
    constructor(entry, caret, submit, keepsFocus = null, onMode = null, modeState = null) {
        this.entry = entry;
        this._text = entry.clutter_text;
        this._caret = caret;
        this._submit = submit;
        this._onMode = onMode;
        this._modeState = modeState;
        this._state = new InputVim();
        this._restoreMode();
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
        connect(this._text, 'key-focus-in', () => {
            this._restoreMode();
            this._state.track(this._text.text, this._text.get_cursor_position());
            this._normalCursor();
            this._sync();
        });
        connect(this._text, 'notify::cursor-position', () => {
            if (!this._updating)
                this._state.history = [];
            this._queueCursor();
        });
        connect(this._text, 'text-changed', () => {
            if (!this._updating) {
                this._state.pending = '';
                this._state.history = [];
                this._leaveVisual();
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
        this._restoreMode();
        this._leaveVisual();
        this._state.reset(this._state.mode);
        this._rememberMode();
        this._normalCursor();
        this._sync();
    }

    // The modes are shared between inputs, but a visual selection belongs to
    // one input; without its anchor, continue in normal mode.
    _restoreMode() {
        this._state.mode = this._modeState?.mode ?? this._state.mode;
        if (this._state.mode === 'visual' && this._state.anchor === null)
            this._state.mode = 'normal';
    }

    // Drops the visual selection and keeps the caret where it was moving.
    _leaveVisual() {
        if (this._state.mode !== 'visual')
            return;
        const head = this._state.head;
        this._state.reset();
        this._rememberMode();
        if (head !== null) {
            this._updating = true;
            try {
                this._text.set_selection(head, head);
            } finally {
                this._updating = false;
            }
        }
        this._sync();
    }

    _rememberMode() {
        if (this._modeState)
            this._modeState.mode = this._state.mode;
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
        this._text.editable = this._available && mode !== 'normal' && mode !== 'visual';
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
        if (event.type() === Clutter.EventType.KEY_PRESS)
            this._restoreMode();
        if (event.type() === Clutter.EventType.KEY_PRESS && !this._text.single_line_mode &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK &&
            !(event.get_state() & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)) &&
            (event.get_event_code() === 36 || [Clutter.KEY_j, Clutter.KEY_J].includes(event.get_key_symbol()))) {
            if (this._available) {
                this._leaveVisual();
                this._state.reset('insert');
                this._rememberMode();
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
            this._leaveVisual();
            this._state.pending = '';
            this._clicked = true;
            return Clutter.EVENT_PROPAGATE;
        }
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        this._restoreMode();
        const symbol = event.get_key_symbol();
        const modifiers = event.get_state() & (Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK);
        // Ctrl+R redoes in normal mode; match the physical R under any layout.
        const redo = modifiers === Clutter.ModifierType.CONTROL_MASK && this._state.mode === 'normal' &&
            (event.get_event_code() === 19 || [Clutter.KEY_r, Clutter.KEY_R].includes(symbol));
        if (modifiers && !redo) {
            if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) &&
                [Clutter.KEY_v, Clutter.KEY_V, Clutter.KEY_x, Clutter.KEY_X].includes(symbol)) {
                this._state.reset('insert');
                this._rememberMode();
                this._sync();
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol)) {
            if (!this._text.single_line_mode && event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
                this._state.reset('insert');
                this._rememberMode();
                this._sync();
                return Clutter.EVENT_PROPAGATE;
            }
            // Keep the mode after sending.
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
        const physical = ['normal', 'visual'].includes(this._state.mode) && this._state.pending !== 'r'
            ? NORMAL_KEYS.get(event.get_event_code()) : null;
        const key = redo ? 'C-r' : special.get(symbol) ?? (physical
            ? physical[event.get_state() & Clutter.ModifierType.SHIFT_MASK ? 1 : 0] : character);
        if (!key)
            return Clutter.EVENT_PROPAGATE;
        const result = this._state.handle(this._text.text, this._text.get_cursor_position(), key,
            position => {
                const [, x, y] = this._text.position_to_coords(position);
                return {x, y};
            });
        if (!result.handled)
            return Clutter.EVENT_PROPAGATE;
        this._updating = true;
        try {
            if (result.text !== this._text.text)
                this._text.set_text(result.text);
            // Clutter puts the cursor at the first position and the bound at the second.
            const [bound, cursor] = result.selection ?? [result.cursor, result.cursor];
            this._text.set_selection(cursor, bound);
        } finally {
            this._updating = false;
        }
        this._rememberMode();
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
