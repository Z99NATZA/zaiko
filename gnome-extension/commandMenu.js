import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
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
        this._indicators = [];
        this._names = [];
        this._items = new Map();
        this._selected = 0;
        this._open = false;
        this._layoutSource = 0;
        this._revealSource = 0;
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
        connect(this._list, 'notify::allocation', () => this._queueLayout());
        // Registered before VimInput, so picker navigation wins while it is open.
        connect(entry, 'captured-event', (_actor, event) => this._event(event));
        connect(this._scroll, 'notify::allocation', () => this._queueRevealSelected());
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
            const items = new Map();
            matches.forEach((command, index) => {
                let item = this._items.get(command.name);
                if (!item || item.description !== command.description)
                    item = this._createRow(command);
                item.index = index;
                if (!item.button.get_parent())
                    this._list.add_child(item.button);
                if (this._list.get_child_at_index(index) !== item.button)
                    this._list.set_child_at_index(item.button, index);
                items.set(command.name, item);
            });
            // Keep surviving actors and their selection styles across keystrokes.
            for (const [name, item] of this._items) {
                if (items.get(name) !== item)
                    item.button.destroy();
            }
            this._items = items;
            this._rows = [...items.values()].map(item => item.button);
            this._indicators = [...items.values()].map(item => item.indicator);
            this._names = [...items.values()].map(item => item.name);
            this._scroll.get_vadjustment().value = 0;
            this._select(0, false);
        }
        this._open = true;
        this.layout();
    }

    _createRow(command) {
        const button = new St.Button({
            style_class: 'zaiko-command-row', x_expand: true, can_focus: false,
            accessible_name: `${command.name}: ${command.description}`,
        });
        const row = new St.BoxLayout({x_expand: true, style_class: 'zaiko-command-columns'});
        const indicator = new St.Label({text: '›', style_class: 'zaiko-command-indicator', opacity: 0});
        const name = new St.Label({text: command.name, style_class: 'zaiko-command-name'});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const description = new St.Label({
            text: command.description, style_class: 'zaiko-command-description', x_expand: true,
        });
        description.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        for (const label of [indicator, name, description])
            row.add_child(label);
        button.set_child(row);
        const item = {button, indicator, name, description: command.description, index: 0};
        // Read the current index because filtering can move a retained row.
        button.connect('motion-event', () => {
            this._select(item.index, false);
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', () => {
            this._select(item.index, false);
            this._activate(true);
        });
        return item;
    }

    _queueLayout() {
        if (!this._open || this._layoutSource)
            return;
        this._layoutSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._layoutSource = 0;
            this.layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    layout() {
        // Before allocation, a BoxLayout can report its text's minimum width
        // instead of its on-screen width. Keep the previous popup geometry until
        // the composer's allocation signal supplies the real bounds.
        if (!this._open)
            return;
        if (!this._composer.has_allocation()) {
            this._queueLayout();
            return;
        }
        if (this._layoutSource)
            GLib.Source.remove(this._layoutSource);
        this._layoutSource = 0;
        const area = this._workArea();
        if (!area)
            return;
        const [x, y] = this._composer.get_transformed_position();
        const [composerWidth, composerHeight] = this._composer.get_transformed_size();
        // A just-opened composer can report invalid transforms until its first
        // allocation. Its allocation signal will position the picker afterwards.
        if (![x, y, composerWidth, composerHeight].every(Number.isFinite) || composerWidth <= 0)
            return;
        const width = Math.min(composerWidth, Math.max(1, area.width - 16));
        if (this.actor.width !== width)
            this.actor.width = width;
        for (const name of this._names)
            name.ensure_style();
        const nameWidth = Math.ceil(Math.min(width * 0.4,
            Math.max(1, ...this._names.map(name => name.clutter_text.get_preferred_width(-1)[1]))));
        for (const name of this._names) {
            if (name.width !== nameWidth)
                name.width = nameWidth;
        }
        const rowsHeight = this._rows.slice(0, COMMAND_VISIBLE_ROWS)
            .reduce((height, row) => height + row.get_preferred_height(width)[1], 0);
        const gap = 4;
        const above = y - area.y - 8 - gap;
        const below = area.y + area.height - y - composerHeight - 8 - gap;
        const scrollHeight = Math.max(1, Math.min(rowsHeight, Math.max(above, below)));
        if (this._scroll.height !== scrollHeight)
            this._scroll.height = scrollHeight;
        const height = this.actor.get_preferred_height(width)[1];
        const targetY = above >= height ? y - height - gap : y + composerHeight + gap;
        const position = clampPosition(x, targetY, width, height, area);
        if (this.actor.x !== position.x || this.actor.y !== position.y)
            this.actor.set_position(position.x, position.y);
        this.actor.show();
    }

    _select(index, reveal = true) {
        this._selected = Math.max(0, Math.min(index, this._rows.length - 1));
        this._rows.forEach((row, rowIndex) => {
            const selected = rowIndex === this._selected;
            this._indicators[rowIndex].opacity = selected ? 255 : 0;
            if (row.has_style_pseudo_class('selected') !== selected) {
                if (selected)
                    row.add_style_pseudo_class('selected');
                else
                    row.remove_style_pseudo_class('selected');
            }
        });
        if (reveal)
            this._queueRevealSelected();
    }

    _queueRevealSelected() {
        if (this._revealSource)
            return;
        // Selection styles invalidate row allocations; wait for their new positions.
        this._revealSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._revealSource = 0;
            this._revealSelected();
            return GLib.SOURCE_REMOVE;
        });
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
        if (!this._open || event.type() !== Clutter.EventType.KEY_PRESS ||
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
        this._open = false;
        if (this._layoutSource)
            GLib.Source.remove(this._layoutSource);
        this._layoutSource = 0;
        if (this._revealSource)
            GLib.Source.remove(this._revealSource);
        this._revealSource = 0;
        this.actor.hide();
        this._query = null;
    }

    destroy() {
        this.hide();
        for (const [actor, id] of this._signals)
            actor.disconnect(id);
        this._signals = [];
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this._items.clear();
    }
}
