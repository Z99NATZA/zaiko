import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {commandMatches, COMMAND_VISIBLE_ROWS, SLASH_COMMANDS} from './commands.js';
import {clampPosition} from './protocol.js';

export class CommandMenu {
    constructor(entry, composer, workArea, submit, styleScrollbar) {
        this.entry = entry;
        this._composer = composer;
        this._workArea = workArea;
        this._submit = submit;
        this._available = false;
        this._signals = [];
        this._matches = [];
        this._commands = SLASH_COMMANDS;
        this._rows = [];
        this._selected = 0;
        this.actor = new St.BoxLayout({
            vertical: true, style_class: 'zaiko-command-menu', visible: false,
            reactive: true,
        });
        this._scroll = new St.ScrollView({style_class: 'zaiko-scroll', x_expand: true});
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        styleScrollbar(this._scroll);
        this._list = new St.BoxLayout({vertical: true, x_expand: true});
        this._scroll.set_child(this._list);
        this.actor.add_child(this._scroll);
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: false});
        const connect = (actor, name, callback) => this._signals.push([actor, actor.connect(name, callback)]);
        connect(entry.clutter_text, 'text-changed', () => {
            this._dismissedText = null;
            this.sync();
        });
        connect(entry.clutter_text, 'key-focus-in', () => {
            this._dismissedText = null;
            this.sync();
        });
        connect(entry.clutter_text, 'key-focus-out', () => this.hide());
        connect(entry, 'notify::mapped', () => this.sync());
        connect(composer, 'notify::allocation', () => this.layout());
        // Registered before VimInput, so picker navigation wins while it is open.
        connect(entry, 'captured-event', (_actor, event) => this._event(event));
        connect(this._scroll, 'notify::allocation', () => this._revealSelected());
        connect(this.actor, 'style-changed', () => this.layout());
    }

    setAvailable(available) {
        this._available = available;
        this.sync();
    }

    sync() {
        const text = this.entry.get_text();
        if (!this._available || !this.entry.mapped || !this.entry.clutter_text.has_key_focus() ||
            text === this._dismissedText) {
            this.hide();
            return;
        }
        const matches = commandMatches(text, this._commands);
        if (!matches.length) {
            this.hide();
            return;
        }
        if (this._query !== text) {
            this._query = text;
            this._matches = matches;
            this._list.destroy_all_children();
            this._rows = matches.map((command, index) => {
                const button = new St.Button({
                    style_class: 'zaiko-command-row', x_expand: true, can_focus: false,
                    accessible_name: `${command.name}: ${command.description}`,
                });
                const row = new St.BoxLayout({x_expand: true, style_class: 'zaiko-command-columns'});
                row.add_child(new St.Label({text: command.name, style_class: 'zaiko-command-name'}));
                const description = new St.Label({
                    text: command.description, style_class: 'zaiko-command-description', x_expand: true,
                });
                description.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                row.add_child(description);
                button.set_child(row);
                // A stationary pointer must not override keyboard selection when
                // filtering or scrolling moves a different row underneath it.
                button.connect('motion-event', () => {
                    this._select(index, false);
                    return Clutter.EVENT_PROPAGATE;
                });
                button.connect('clicked', () => {
                    this._select(index, false);
                    this._activate(true);
                });
                this._list.add_child(button);
                return button;
            });
            this._scroll.get_vadjustment().value = 0;
            this._select(0, false);
        }
        this.actor.show();
        this.layout();
    }

    layout() {
        if (!this.actor.visible)
            return;
        const area = this._workArea();
        if (!area)
            return;
        const [x, y] = this._composer.get_transformed_position();
        const [, composerHeight] = this._composer.get_transformed_size();
        // A just-opened composer can report invalid transforms until its first
        // allocation. Its allocation signal will position the picker afterwards.
        if (![x, y, composerHeight].every(Number.isFinite))
            return;
        const width = Math.min(460, Math.max(1, area.width - 16));
        this.actor.width = width;
        const rowsHeight = this._rows.slice(0, COMMAND_VISIBLE_ROWS)
            .reduce((height, row) => height + row.get_preferred_height(width)[1], 0);
        const above = y - area.y - 8;
        const below = area.y + area.height - y - composerHeight - 8;
        this._scroll.height = Math.max(1, Math.min(rowsHeight, Math.max(above, below) - 16));
        const height = this.actor.get_preferred_height(width)[1];
        const targetY = above >= height + 6 ? y - height - 6 : y + composerHeight + 6;
        const position = clampPosition(x, targetY, width, height, area);
        this.actor.set_position(position.x, position.y);
    }

    _select(index, reveal = true) {
        this._selected = Math.max(0, Math.min(index, this._rows.length - 1));
        this._rows.forEach((row, rowIndex) => {
            if (rowIndex === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        if (reveal)
            this._revealSelected();
    }

    _revealSelected() {
        if (!this.actor.visible)
            return;
        const row = this._rows[this._selected];
        const adjustment = this._scroll.get_vadjustment();
        if (!row || !adjustment.page_size)
            return;
        if (row.y < adjustment.value)
            adjustment.value = row.y;
        else if (row.y + row.height > adjustment.value + adjustment.page_size)
            adjustment.value = Math.min(adjustment.upper - adjustment.page_size,
                row.y + row.height - adjustment.page_size);
    }

    _activate(submit) {
        const command = this._matches[this._selected];
        this.entry.set_text(command.name);
        this.entry.clutter_text.set_selection(-1, -1);
        this.entry.grab_key_focus();
        this._dismissedText = command.name;
        this.hide();
        if (submit)
            this._submit();
    }

    _event(event) {
        if (!this.actor.visible || event.type() !== Clutter.EventType.KEY_PRESS ||
            event.get_state() & (Clutter.ModifierType.CONTROL_MASK |
                Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK))
            return Clutter.EVENT_PROPAGATE;
        const symbol = event.get_key_symbol();
        if (!this.entry.clutter_text.single_line_mode && event.get_state() & Clutter.ModifierType.SHIFT_MASK &&
            [Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(symbol))
            return Clutter.EVENT_PROPAGATE;
        if ([Clutter.KEY_Up, Clutter.KEY_Down].includes(symbol))
            this._select(this._selected + (symbol === Clutter.KEY_Down ? 1 : -1));
        else if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_Tab].includes(symbol))
            this._activate(symbol !== Clutter.KEY_Tab);
        else if (symbol === Clutter.KEY_Escape) {
            this._dismissedText = this.entry.get_text();
            this.hide();
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    hide() {
        this.actor.hide();
        this._query = null;
    }

    destroy() {
        for (const [actor, id] of this._signals)
            actor.disconnect(id);
        this._signals = [];
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}
