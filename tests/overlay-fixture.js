// Appended only to a temporary copy by overlay-shell.py; no real core/provider.
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {EXPRESSIONS} from './assets/manifest.js';

function qaPause(milliseconds) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function qaAssert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function qaColor(actual, hex) {
    return [actual.red, actual.green, actual.blue].every((value, index) =>
        value === Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16));
}

function qaContainsText(actor, text) {
    return (actor instanceof St.Label && actor.text.includes(text)) ||
        actor.get_children().some(child => qaContainsText(child, text));
}

function qaFindActor(actor, predicate) {
    if (predicate(actor))
        return actor;
    for (const child of actor.get_children()) {
        const match = qaFindActor(child, predicate);
        if (match)
            return match;
    }
    return null;
}

function qaTextColorAt(label, byteIndex) {
    const iterator = label.clutter_text.get_layout().get_attributes().get_iterator();
    do {
        const [start, end] = iterator.range();
        if (byteIndex >= start && byteIndex < end)
            return iterator.get(Pango.AttrType.FOREGROUND)?.as_color().color.to_string();
    } while (iterator.next());
    return null;
}

async function qaCaretPhases(text, duration = 550) {
    const phases = new Set();
    const deadline = GLib.get_monotonic_time() + duration * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        phases.add(text.get_cursor_visible());
        await qaPause(25);
    }
    return phases;
}

export default class OverlayQA extends ZaikoExtension {
    enable() {
        super.enable();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._runQA().catch(error => this._qaResult({ok: false, error: error.message, stack: error.stack}));
            return GLib.SOURCE_REMOVE;
        });
    }

    _qaResult(value) {
        GLib.file_set_contents(`${GLib.get_home_dir()}/qa-result.json`, JSON.stringify(value));
    }

    async _shot(name) {
        const stream = Gio.File.new_for_path(`${GLib.get_home_dir()}/${name}.png`)
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }

    async _click(actor, button = Clutter.BUTTON_PRIMARY) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height / 2);
        await qaPause(40);
        this._pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.PRESSED);
        await qaPause(50);
        this._pointer.notify_button(GLib.get_monotonic_time(), button, Clutter.ButtonState.RELEASED);
        await qaPause(140);
    }

    async _key(keyval) {
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
        await qaPause(140);
    }

    async _checkMenuHover(menu, composer = null) {
        const layers = Main.uiGroup.get_children();
        qaAssert([this._inputOverlay, this._panel, this._answerLabel, this._character]
            .every(actor => layers.indexOf(menu.actor) > layers.indexOf(actor)),
        'Context menu is stacked above all companion surfaces');
        if (composer) {
            const [, menuY] = menu.actor.get_transformed_position();
            const [, menuHeight] = menu.actor.get_transformed_size();
            const [, composerY] = composer.get_transformed_position();
            const [, composerHeight] = composer.get_transformed_size();
            qaAssert(menuY + menuHeight < composerY || menuY > composerY + composerHeight,
                'Input context menu clears the entire composer border');
        }
        const item = menu._getMenuItems().find(candidate => candidate.reactive);
        const [x, y] = item.get_transformed_position();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + item.width / 2, y + item.height / 2);
        await qaPause(80);
        qaAssert(item.hover && item.get_theme_node().get_background_color().alpha > 0,
            'Menu row highlights while the pointer is over it');
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        await qaPause(80);
        qaAssert(menu.isOpen && !item.hover && item.get_theme_node().get_background_color().alpha === 0,
            'Menu row returns to its normal color after the pointer leaves despite retained key focus');
        await this._key(Clutter.KEY_Down);
        const focused = menu._getMenuItems().find(candidate => candidate.has_key_focus());
        qaAssert(focused && focused.get_theme_node().get_background_color().alpha > 0,
            'Keyboard navigation still highlights the focused menu row');
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 110, 80);
        await qaPause(80);
        qaAssert(focused.get_theme_node().get_background_color().alpha === 0,
            'Pointer movement clears the keyboard highlight');
    }

    async _checkMessageCopy(label) {
        const text = label.clutter_text;
        const draft = this._logEntry.get_text();
        this._logEntry.set_text('log click draft');
        for (const target of [this._panel, label, text]) {
            global.stage.set_key_focus(null);
            await qaPause(450);
            await this._click(target);
            qaAssert(this._logEntry.clutter_text.has_key_focus(),
                `A plain click in Log background or a message focuses the input: ${JSON.stringify({target: target.toString(), selection: text.get_selection(), focus: global.stage.get_key_focus()?.toString()})}`);
            qaAssert(this._logEntry.get_text() === 'log click draft' && this._panel.visible,
                'Log clicks preserve the draft and keep the conversation open');
        }
        this._logEntry.set_text(draft);
        const clipboard = St.Clipboard.get_default();
        const readClipboard = () => new Promise(resolve =>
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => resolve(value)));
        const [x, y] = text.get_transformed_position();
        const [startOk, startX, startY, lineHeight] = text.position_to_coords(0);
        const [endOk, endX, endY] = text.position_to_coords(4);
        qaAssert(startOk && endOk, 'Transcript selection coordinates are available');
        const [labelX] = label.get_transformed_position();
        const [lastOk, lastX] = text.position_to_coords(-1);
        qaAssert(lastOk, 'The last character has selection coordinates');
        for (const [paddingX, paddingY] of [
            [labelX + label.width - 2, y + lineHeight / 2],
            [Math.min(x + lastX + 2, labelX + label.width - 2), y + text.height + 2],
        ]) {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), paddingX, paddingY);
            await qaPause(25);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            for (let step = 1; step <= 4; step++) {
                this._pointer.notify_absolute_motion(GLib.get_monotonic_time(),
                    paddingX + (x + startX - paddingX) * step / 4,
                    paddingY + (y + startY + lineHeight / 2 - paddingY) * step / 4);
                await qaPause(25);
            }
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await qaPause(40);
            qaAssert(text.get_selection() === label.text && !this._selectionDrag,
                `Dragging from the right/bottom padding selects the whole message: ${JSON.stringify({selection: text.get_selection(), expected: label.text})}`);
        }
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + startX + 1, y + startY + lineHeight / 2);
        await qaPause(25);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        for (let step = 1; step <= 4; step++) {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(),
                x + startX + (endX - startX) * step / 4, y + endY + lineHeight / 2);
            await qaPause(25);
        }
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await qaPause(40);
        const selection = text.get_selection();
        qaAssert(selection && selection.length < label.text.length, 'Dragging selects part of a read-only transcript message');
        qaAssert(text.has_key_focus() && !text.editable, 'Transcript selection receives keyboard focus without enabling edits');
        qaAssert(qaColor(text.get_selection_color(), '#3e4451') &&
            qaColor(text.get_selected_text_color(), '#dcdfe4'), 'Transcript selection uses the existing visible selection palette');
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'before copy');
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        await this._key(Clutter.KEY_c);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        qaAssert(await readClipboard() === selection, 'Ctrl+C copies the selected transcript text');

        text.set_selection(7, -1);
        const body = text.get_selection();
        await this._click(label, Clutter.BUTTON_SECONDARY);
        qaAssert(label.menu.isOpen && text.get_selection() === body, 'Right-click preserves the text selection');
        qaAssert(label.menu.actor.has_style_class_name('zaiko-context') &&
            qaColor(label.menu.box.get_theme_node().get_background_color(), '#282c34'), 'Message Copy menu reuses the existing context menu style');
        await this._checkMenuHover(label.menu);
        await this._shot('message-copy-menu');
        await this._click(label.menu._getMenuItems()[0].actor);
        qaAssert(await readClipboard() === body && this._panel.visible, 'Context Copy preserves Thai, symbols and emoji while keeping Log open');
        text.set_selection(0, 0);
        await this._click(label, Clutter.BUTTON_SECONDARY);
        await this._click(label.menu._getMenuItems()[0].actor);
        qaAssert(await readClipboard() === label.text, 'Context Copy copies the full message when there is no selection');
        await this._click(label, Clutter.BUTTON_SECONDARY);
        this._hidePanel();
        qaAssert(!label.menu.isOpen && !this._panel.visible, 'Hiding Log closes its message menu');
        this._showLog();
    }

    async _checkComposerHitArea(entry, button) {
        const composer = entry === this._logEntry ? this._logComposer : this._inputOverlay;
        const [x, y] = composer.get_transformed_position();
        const [width, height] = composer.get_transformed_size();
        const [entryX, entryY] = entry.get_transformed_position();
        const clickAt = async (targetX, targetY) => {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), targetX, targetY);
            await qaPause(25);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await qaPause(25);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await qaPause(50);
        };
        entry.set_text('focus area draft');
        const [buttonX] = button ? button.get_transformed_position() : [x + width];
        for (const [targetX, targetY] of [
            [x + 2, y + height / 2], [x + width - 2, y + height / 2],
            [x + width / 2, y + 2], [x + width / 2, y + height - 2],
            [buttonX - 2, y + height / 2],
        ]) {
            (button ?? composer).grab_key_focus();
            await clickAt(targetX, targetY);
            qaAssert(entry.clutter_text.has_key_focus(), 'Clicking inside each edge or gap focuses input');
            qaAssert(composer.visible && composer.has_style_pseudo_class('focus'), 'Padding clicks retain input and its focus highlight');
            qaAssert(entry.get_text() === 'focus area draft', 'Padding clicks do not submit or clear the draft');
        }
        entry.clutter_text.set_cursor_position(-1);
        await clickAt(entryX + 10, entryY + entry.height / 2);
        qaAssert(entry.clutter_text.get_cursor_position() >= 0 && entry.clutter_text.get_cursor_position() < 5,
            'Native text clicks still place the caret near the clicked character');
        entry.set_text('');
    }

    async _checkFocusDismiss(label) {
        const text = label.clutter_text;
        const entry = this._logEntry;
        const draft = entry.get_text();
        entry.set_text('focus dismissal draft');
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
        await this._click(this._logScroll);
        qaAssert(!entry.clutter_text.get_selection() && entry.clutter_text.has_key_focus(),
            'Blank space inside Log clears input selection and focuses input');
        qaAssert(this._panel.visible && entry.get_text() === 'focus dismissal draft',
            'Log stays open with its draft after a background click');

        text.grab_key_focus();
        text.set_selection(7, -1);
        await this._click(entry);
        qaAssert(!text.get_selection() && entry.contains(global.stage.get_key_focus()),
            'Clicking input clears the old message selection and focuses the input');
        entry.clutter_text.set_selection(0, -1);
        await this._click(label);
        qaAssert(!entry.clutter_text.get_selection() && entry.clutter_text.has_key_focus(),
            'Clicking a message clears the old input selection and returns focus to input');

        const outside = new St.Widget({reactive: true, width: 80, height: 48});
        outside.set_position(300, 100);
        let presses = 0;
        outside.connect('button-press-event', () => { presses++; return Clutter.EVENT_PROPAGATE; });
        Main.uiGroup.add_child(outside);
        try {
            await qaPause(60);
            text.set_selection(7, -1);
            await this._click(outside);
            qaAssert(!text.get_selection() && !this._ownsFocus(global.stage.get_key_focus()) && presses === 1,
                `A nonfocusable outside target clears message selection/focus and receives the same press once: ${JSON.stringify({selection: text.get_selection(), focus: global.stage.get_key_focus()?.toString(), presses})}`);
            text.grab_key_focus();
            text.set_selection(7, -1);
            await this._click(label, Clutter.BUTTON_SECONDARY);
            await this._click(outside);
            qaAssert(!label.menu.isOpen && !text.get_selection() &&
                !this._ownsFocus(global.stage.get_key_focus()),
            `Outside click closes Copy and clears its selection/focus: ${JSON.stringify({open: label.menu.isOpen, selection: text.get_selection(), focus: global.stage.get_key_focus()?.toString()})}`);
            const beforeInputClick = presses;
            entry.grab_key_focus();
            entry.clutter_text.set_selection(0, -1);
            await this._click(outside);
            qaAssert(!entry.clutter_text.get_selection() && !entry.clutter_text.has_key_focus() &&
                this._panel.visible && entry.get_text() === 'focus dismissal draft' && presses === beforeInputClick + 1,
            'Outside click releases Log input and selection while preserving the panel and draft');
        } finally {
            outside.destroy();
            entry.set_text(draft);
        }
    }

    async _checkCommandHighlight(entry, menu) {
        // Filter to /status first; the checks below type within one match set.
        await this._key(Clutter.KEY_s);
        const statusRow = menu._rows[0];
        let remapped = 0;
        const mappingSignal = statusRow.connect('notify::mapped', () => { remapped++; });
        const colors = [];
        const pixels = [];
        const bounds = [menu.actor.x, menu.actor.y, menu.actor.width, menu.actor.height];
        const geometryChanges = [];
        const geometrySignals = ['notify::x', 'notify::y', 'notify::width', 'notify::height'].map(signal =>
            menu.actor.connect(signal, () => {
                const current = [menu.actor.x, menu.actor.y, menu.actor.width, menu.actor.height];
                if (current.some((value, index) => value !== bounds[index]))
                    geometryChanges.push(current);
            }));
        let samplePixels = true;
        const [rowX, rowY] = statusRow.get_transformed_position();
        const pixelReader = new Shell.Screenshot();
        const pixelTask = (async () => {
            while (samplePixels) {
                const [color] = await pixelReader.pick_color(Math.round(rowX + 2), Math.round(rowY + statusRow.height / 2));
                pixels.push([color.red, color.green, color.blue]);
                await qaPause(1);
            }
        })();
        const colorSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            colors.push(menu.actor.visible && statusRow.mapped &&
                qaColor(statusRow.get_theme_node().get_background_color(), '#98c379'));
            return GLib.SOURCE_CONTINUE;
        });
        try {
            for (const character of 'tatus') {
                await this._key(character.codePointAt(0));
                qaAssert(menu._rows[0] === statusRow && statusRow.has_style_pseudo_class('selected') &&
                    entry.clutter_text.has_key_focus(),
                    'Typing a slash command retains its selected row and input focus');
            }
            qaAssert(colors.length > 0 && colors.every(Boolean) && remapped === 0,
                'The green selection stays visible without fading or remapping while typing');
        } finally {
            samplePixels = false;
            await pixelTask;
            GLib.Source.remove(colorSource);
            statusRow.disconnect(mappingSignal);
            geometrySignals.forEach(signal => menu.actor.disconnect(signal));
        }
        qaAssert(geometryChanges.length === 0,
            `The picker never shrinks or moves while typing a matching prefix: ${JSON.stringify({bounds, changes: geometryChanges})}`);
        qaAssert(pixels.length > 0 && pixels.every(([r, g, b]) => r === 152 && g === 195 && b === 121),
            `Rendered selection pixels stay green while typing: ${JSON.stringify({count: pixels.length, colors: [...new Set(pixels.map(pixel => pixel.join(',')))]})}`);
    }

    async _checkCommandMenus() {
        const drafts = [this._overlayEntry.get_text(), this._logEntry.get_text()];
        const catalogs = this._commandMenus.map(menu => menu._commands);
        const originalCall = this._callCore;
        const calls = [];
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            return [];
        };
        try {
            this._hidePanel();
            this._showInput();
            const entry = this._overlayEntry;
            const menu = this._commandMenus.find(candidate => candidate.entry === entry);
            entry.set_text('/');
            await qaPause(180);
            qaAssert(menu.actor.visible && menu._rows.length === 2 &&
                menu._matches.map(command => command.name).join() === '/status,/exit',
                'The production picker contains only supported commands');
            await this._checkCommandHighlight(entry, menu);
            this._showLog();
            this._logEntry.set_text('/');
            await qaPause(180);
            await this._checkCommandHighlight(this._logEntry,
                this._commandMenus.find(candidate => candidate.entry === this._logEntry));
            this._hidePanel();
            this._showInput();
            entry.set_text('/');
            // Large-list fixtures exist only in this isolated compositor test.
            const fixtures = [...menu._commands, ...Array.from({length: 20}, (_, index) => ({
                name: `/test${String(index + 1).padStart(3, '0')}`,
                description: 'Isolated picker test fixture',
            }))];
            for (const picker of this._commandMenus) {
                picker._commands = fixtures;
                picker.hide();
                picker.sync();
            }
            const retained = menu._rows[fixtures.findIndex(command => command.name === '/test001')];
            entry.set_text('/test00');
            qaAssert(menu._rows[0] === retained, 'Filtering moves a surviving row instead of rebuilding it');
            entry.set_text('/');
            await qaPause(100);
            const adjustment = menu._scroll.get_vadjustment();
            const visibleRowsHeight = menu._rows.slice(0, 8).reduce((height, row) => height + row.height, 0);
            await this._shot('command-menu-eight-rows');
            const [composerX, composerY] = this._inputOverlay.get_transformed_position();
            const [menuX, menuY] = menu.actor.get_transformed_position();
            qaAssert(menuX === composerX && menu.actor.width === this._inputOverlay.width &&
                menuY + menu.actor.height <= composerY &&
                menu.actor.get_theme_node().get_border_width(St.Side.LEFT) === 0 &&
                menu.actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT) === 0,
                'The flat command list aligns above the full composer width without a card border');
            const descriptionXs = menu._rows.map(row => row.get_child().get_children()[2].get_transformed_position()[0]);
            qaAssert(descriptionXs.every(value => Math.abs(value - descriptionXs[0]) < 1),
                `Descriptions align in one column even when command names differ in length: ${JSON.stringify({xs: descriptionXs, widths: menu._names.map(name => name.width), allocated: this._inputOverlay.has_allocation()})}`);
            qaAssert(menu._indicators[0].opacity === 255 && menu._indicators.slice(1).every(marker => marker.opacity === 0) &&
                qaColor(menu._rows[0].get_theme_node().get_background_color(), '#98c379') &&
                qaColor(menu._rows[0].get_child().get_children()[2].get_theme_node().get_foreground_color(), '#151820'),
                'Selection uses a leading marker and dark text on a full-row green bar');
            qaAssert(Math.abs(adjustment.page_size - visibleRowsHeight) <= 1 && adjustment.upper > adjustment.page_size,
                `Picker displays eight rows and scrolls the rest: ${JSON.stringify({page: adjustment.page_size, visibleRowsHeight, upper: adjustment.upper, actor: [menu.actor.width, menu.actor.height, menu.actor.mapped], scroll: [menu._scroll.width, menu._scroll.height, menu._scroll.mapped]})}`);
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
            await this._key(Clutter.KEY_Up);
            qaAssert(menu._selected === 0 && adjustment.value === 0,
                'Up at the first command stays at the start instead of wrapping');
            for (let index = 0; index < 9; index++)
                await this._key(Clutter.KEY_Down);
            qaAssert(menu._selected === 9 && adjustment.value > 0 &&
                menu._rows[9].y + menu._rows[9].height <= adjustment.value + adjustment.page_size + 1,
            `Arrow navigation scrolls the selected command into view: ${JSON.stringify({selected: menu._selected, value: adjustment.value, page: adjustment.page_size, y: menu._rows[9].y, height: menu._rows[9].height})}`);
            qaAssert(menu._indicators[9].opacity === 255 && menu._indicators[0].opacity === 0,
                'The leading marker follows keyboard selection');
            for (let index = 0; index < 13; index++)
                await this._key(Clutter.KEY_Down);
            qaAssert(menu._selected === fixtures.length - 1 && Math.abs(adjustment.value - (adjustment.upper - adjustment.page_size)) <= 1,
                'Repeated Down stops at the final command and end of the scroll range');
            for (let index = 0; index < 11; index++)
                await this._key(Clutter.KEY_Up);
            await this._key(Clutter.KEY_Tab);
            qaAssert(entry.get_text() === '/test009' && !menu.actor.visible && !calls.length && entry.clutter_text.has_key_focus(),
                'Tab completes the highlighted command without executing or losing focus');
            await this._key(Clutter.KEY_Return);
            qaAssert(calls.length === 1 && calls[0].args[1] === '/test009' && !this._inputOverlay.visible,
                'Enter after completion submits once through the existing input');

            this._showLog();
            const log = this._logEntry;
            const logMenu = this._commandMenus.find(candidate => candidate.entry === log);
            log.set_text('/test00');
            await qaPause(180);
            qaAssert(logMenu.actor.visible && logMenu._rows.length === 9 && !menu.actor.visible,
                'Log filters command prefixes independently of compact input');
            const [x, y] = logMenu._scroll.get_transformed_position();
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + 110, y + 100);
            await qaPause(40);
            this._pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
            await qaPause(180);
            qaAssert(logMenu._scroll.get_vadjustment().value > 0, 'Native mouse wheel scrolls the command list');
            await this._click(logMenu._rows[8]);
            qaAssert(calls.length === 2 && calls[1].args[1] === '/test009' && this._panel.visible && log.clutter_text.has_key_focus(),
                'Clicking a test fixture submits once and preserves Log focus');
            log.set_text('/sta');
            await qaPause(80);
            qaAssert(logMenu._rows.length === 1 && logMenu._matches[0].name === '/status',
                'Typing narrows the picker to the matching command');
            await this._key(Clutter.KEY_Return);
            qaAssert(calls.length === 3 && calls[2].args[1] === '/status', 'Enter executes the highlighted match once');
            log.set_text('/ex');
            await qaPause(80);
            qaAssert(logMenu._rows.length === 1 && logMenu._matches[0].name === '/exit', 'The picker offers /exit');
            await this._key(Clutter.KEY_Return);
            qaAssert(calls.length === 4 && calls[3].method === 'Quit' && calls[3].args === undefined &&
                log.get_text() === '',
            `/exit quits like the Quit menu instead of submitting: ${JSON.stringify(calls.slice(3))}`);
            log.set_text('/s');
            await qaPause(80);
            await this._key(Clutter.KEY_Escape);
            this._renderSnapshot();
            qaAssert(!logMenu.actor.visible && this._panel.visible && log.get_text() === '/s',
                'Escape dismisses suggestions while preserving the composer and draft across repaints');
            log.set_text('ordinary text');
            qaAssert(!logMenu.actor.visible, 'Ordinary text has no command suggestions');
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
            await qaPause(40);
            this._toggleVim();
            log.set_text('/s');
            await qaPause(80);
            await this._key(Clutter.KEY_Down);
            await this._key(Clutter.KEY_Tab);
            qaAssert(log.get_text() === '/status' && !logMenu.actor.visible,
                `Command navigation takes priority over Vim input handling: ${JSON.stringify({text: log.get_text(), visible: logMenu.actor.visible, selected: logMenu._selected, matches: logMenu._matches.map(command => command.name), focus: log.clutter_text.has_key_focus()})}`);
            this._toggleVim();
            log.set_text('/s');
            this._snapshot.state = 'thinking';
            this._renderSnapshot();
            qaAssert(!logMenu.actor.visible, 'Busy requests hide and disable command suggestions');
            this._snapshot.state = 'idle';
            this._renderSnapshot();
            this._hidePanel();
            await qaPause(80);
            qaAssert(!logMenu.actor.visible, 'Closing the composer hides its command list');
        } finally {
            this._callCore = originalCall;
            this._commandMenus.forEach((menu, index) => {
                menu._commands = catalogs[index];
                menu.hide();
            });
            this._overlayEntry.set_text(drafts[0]);
            this._logEntry.set_text(drafts[1]);
        }
    }

    async _checkThaiVimKeys() {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
        const sources = settings.get_value('sources');
        const manager = Keyboard.getInputSourceManager();
        const previous = manager.currentSource?.id;
        const entries = [this._overlayEntry, this._logEntry];
        const drafts = entries.map(entry => entry.get_text());
        const physical = async (code, shift = false) => {
            if (shift)
                this._keyboard.notify_key(GLib.get_monotonic_time(), 42, Clutter.KeyState.PRESSED);
            this._keyboard.notify_key(GLib.get_monotonic_time(), code, Clutter.KeyState.PRESSED);
            this._keyboard.notify_key(GLib.get_monotonic_time(), code, Clutter.KeyState.RELEASED);
            if (shift)
                this._keyboard.notify_key(GLib.get_monotonic_time(), 42, Clutter.KeyState.RELEASED);
            await qaPause(60);
        };
        const ctrlJ = async () => {
            this._keyboard.notify_key(GLib.get_monotonic_time(), 29, Clutter.KeyState.PRESSED);
            await physical(36);
            this._keyboard.notify_key(GLib.get_monotonic_time(), 29, Clutter.KeyState.RELEASED);
        };
        try {
            settings.set_value('sources', new GLib.Variant('a(ss)', [['xkb', 'us'], ['xkb', 'th']]));
            await qaPause(120);
            const thai = Object.values(manager.inputSources).find(source => source.id === 'th');
            qaAssert(thai, 'The isolated session provides a real Thai keyboard layout');
            thai.activate(false);
            await qaPause(120);
            for (const entry of entries) {
                if (entry === this._overlayEntry) {
                    this._hidePanel();
                    this._showInput();
                } else {
                    this._showLog();
                }
                const vim = this._vimInputs.find(candidate => candidate.entry === entry);
                entry.set_text('');
                entry.grab_key_focus();
                vim.leave();
                entry.set_text('abc');
                {
                    const [entryX, entryY] = entry.get_transformed_position();
                    const [entryWidth, entryHeight] = entry.get_transformed_size();
                    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(),
                        entryX + entryWidth - 6, entryY + entryHeight / 2);
                    await qaPause(40);
                    this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                    await qaPause(50);
                    this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
                    await qaPause(140);
                }
                qaAssert(vim._state.mode === 'normal' && entry.clutter_text.get_cursor_position() === 2 &&
                    entry.get_text() === 'abc',
                `Clicking past the text keeps normal mode with the caret on the last character: ${JSON.stringify({mode: vim._state.mode, cursor: entry.clutter_text.get_cursor_position()})}`);
                entry.set_text('');
                vim.leave();
                await physical(23); // US I / Thai ร
                qaAssert(vim._state.mode === 'insert' && entry.get_text() === '',
                    'Physical I enters insert mode under Thai without inserting a character');
                await physical(23);
                await physical(30); // US A / Thai ฟ
                qaAssert(entry.get_text() === 'รฟ', 'Insert mode keeps the active Thai layout');
                await this._key(Clutter.KEY_Escape);
                await physical(35); // H
                qaAssert(entry.clutter_text.get_cursor_position() === 0, 'Physical H moves left under Thai');
                await physical(38); // L
                qaAssert(entry.clutter_text.get_cursor_position() === 1, 'Physical L moves right under Thai');
                await physical(30, true); // A
                await physical(23);
                qaAssert(entry.get_text() === 'รฟร', 'Shift+A appends under Thai and keeps subsequent text in Thai');
                await this._key(Clutter.KEY_Escape);
                entry.set_text('xyz');
                entry.clutter_text.set_cursor_position(0);
                await physical(19); // r
                await physical(23);
                qaAssert(entry.get_text() === 'รyz', 'The replacement character after r follows the Thai layout');
                await physical(19, true); // R
                await physical(30);
                qaAssert(entry.get_text() === 'ฟyz', 'Continuous replace also keeps Thai characters');
                await this._key(Clutter.KEY_Escape);
                entry.set_text('one two');
                entry.clutter_text.set_cursor_position(0);
                for (const code of [46, 23, 17]) // ciw
                    await physical(code);
                await physical(23);
                qaAssert(entry.get_text() === 'ร two', 'Physical ciw commands work while Thai is active');
                await this._key(Clutter.KEY_Escape);
                entry.set_text('one\ntwo');
                entry.clutter_text.set_cursor_position(1);
                await physical(24); // o
                qaAssert(entry.get_text() === 'one\n\ntwo' && vim._state.mode === 'insert',
                    'Physical o opens a line below under Thai');
                await physical(23);
                qaAssert(entry.get_text() === 'one\nร\ntwo', 'Typing after o inserts Thai on the new line');
                await this._key(Clutter.KEY_Escape);
                await physical(24, true); // O
                qaAssert(entry.get_text() === 'one\n\nร\ntwo' && entry.clutter_text.get_cursor_position() === 4 &&
                    vim._state.mode === 'insert', 'Physical O opens a line above under Thai');
                await this._key(Clutter.KEY_Escape);
                entry.set_text('ab');
                entry.clutter_text.set_selection(1, 1);
                await ctrlJ();
                qaAssert(entry.get_text() === 'a\nb' && vim._state.mode === 'insert' && entry.mapped,
                    `Ctrl+J inserts a newline and enters insert mode without sending under Thai: ${JSON.stringify({text: entry.get_text(), mode: vim._state.mode, cursor: entry.clutter_text.get_cursor_position(), mapped: entry.mapped})}`);
                entry.set_text('a🙂b');
                entry.clutter_text.set_selection(1, 2);
                await ctrlJ();
                qaAssert(entry.get_text() === 'a\nb' && entry.clutter_text.get_cursor_position() === 2,
                    'Ctrl+J replaces the selection with one newline');
                await this._key(Clutter.KEY_Escape);
                entry.set_text('hello\nworld');
                entry.clutter_text.set_selection(10, 10);
                await physical(32); // d
                await physical(32);
                qaAssert(entry.get_text() === 'hello' && vim._state.mode === 'normal' && entry.mapped,
                    'Physical dd under Thai deletes only the current row in each composer');
                this._toggleVim();
                entry.set_text('');
                await physical(23);
                qaAssert(entry.get_text() === 'ร', 'Disabling Vim restores ordinary Thai typing');
                await ctrlJ();
                qaAssert(entry.get_text() === 'ร\n' && entry.mapped, 'Ctrl+J inserts a newline with Vim disabled too');
                this._toggleVim();
            }
        } finally {
            if (!this._vimEnabled)
                this._toggleVim();
            settings.set_value('sources', sources);
            await qaPause(120);
            Object.values(manager.inputSources).find(source => source.id === previous)?.activate(false);
            await qaPause(100);
            entries.forEach((entry, index) => entry.set_text(drafts[index]));
            this._showLog();
        }
    }

    async _checkLogVimFocus() {
        const entry = this._logEntry;
        const vim = this._vimInputs.find(candidate => candidate.entry === entry);
        const draft = entry.get_text();
        const label = this._wrappedLabel('[Aiko] focus test', 'zaiko-log-message');
        this._makeMessageCopyable(label);
        this._logHistory.add_child(label);
        const outside = new St.Widget({reactive: true, width: 80, height: 48, x: 100, y: 100});
        Main.uiGroup.add_child(outside);
        try {
            await qaPause(80);
            for (const [key, mode] of [[null, 'normal'], ['i', 'insert'], ['R', 'replace']]) {
                entry.set_text('focus draft');
                entry.grab_key_focus();
                vim.leave();
                entry.clutter_text.set_selection(2, 2);
                if (key)
                    await this._key(key.codePointAt(0));
                for (const target of [this._logScroll, label]) {
                    await this._click(target);
                    qaAssert(vim._state.mode === mode && entry.clutter_text.has_key_focus() &&
                        entry.clutter_text.get_cursor_position() === 2 && entry.get_text() === 'focus draft',
                    `Plain Log clicks preserve Vim mode, caret and draft: ${JSON.stringify({mode, actual: vim._state.mode, cursor: entry.clutter_text.get_cursor_position()})}`);
                }
                if (mode === 'insert') {
                    await this._key(Clutter.KEY_x);
                    qaAssert(entry.get_text() === 'foxcus draft',
                        'Typing continues in insert mode immediately after a Log click');
                }
                await this._click(outside);
                qaAssert(vim._state.mode === mode && !entry.clutter_text.has_key_focus(),
                    `Clicking outside Log keeps its Vim mode: ${JSON.stringify({mode, actual: vim._state.mode})}`);
                await this._click(this._logScroll);
                qaAssert(vim._state.mode === mode && entry.clutter_text.has_key_focus(),
                    'Returning to Log continues in the same Vim mode');
            }
            vim._state.reset('insert');
            this._hidePanel();
            this._showLog();
            qaAssert(vim._state.mode === 'normal', 'Closing Log returns its input to normal mode');
        } finally {
            outside.destroy();
            label.destroy();
            entry.set_text(draft);
            entry.grab_key_focus();
        }
    }

    async _checkLanguage() {
        const snapshot = this._snapshot;
        const drafts = [this._overlayEntry.get_text(), this._logEntry.get_text()];
        const uiError = this._uiError;
        const vimEnabled = this._vimEnabled;
        try {
            qaAssert(this._language === 'en' && this._langMenuItem.label.text === 'Lang: en',
                'Language defaults to English and exposes the current selection');
            this._overlayEntry.set_text('compact ภาษาไทย draft');
            this._logEntry.set_text('log ภาษาไทย draft');
            this._snapshot = {...snapshot, state: 'idle', request_id: null, error: null, messages: [
                {role: 'user', content: 'ข้อความเดิม <tag> 🙂'},
                {role: 'assistant', content: 'Original reply stays literal.'},
            ]};
            this._uiError = null;
            this._renderSnapshot();
            const messages = JSON.stringify(this._snapshot.messages);
            this._showLog();
            const expiry = this._answerHideSource;
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), this._character.x + 100, this._character.y + 100);
            await qaPause(40);
            this._openCharacterMenu();
            await qaPause(200);
            await this._click(this._langMenuItem);
            qaAssert(this._language === 'th' && this._characterMenu.isOpen &&
                this._characterMenu._getMenuItems().map(item => item.label.text).join(',') ===
                `พูดคุย,ขนาด: ${this._characterSize},ภาษา: th,Vim: ${vimEnabled ? 'เปิด' : 'ปิด'},ปิด`,
                `Lang toggles to Thai, updates every menu row and keeps the menu open: ${JSON.stringify({language: this._language, open: this._characterMenu.isOpen, rows: this._characterMenu._getMenuItems().map(item => item.label.text)})}`);
            qaAssert(this._loadLanguage() === 'th', 'The language choice persists in language.json');
            qaAssert(this._answerHideSource === expiry && JSON.stringify(this._snapshot.messages) === messages &&
                this._overlayEntry.get_text() === 'compact ภาษาไทย draft' && this._logEntry.get_text() === 'log ภาษาไทย draft',
                'Switching languages preserves drafts, conversation content and reply expiry');
            const row = this._logHistory.get_child_at_index(0);
            const prefixBytes = new TextEncoder().encode('[ฉัน]').length;
            qaAssert(row.text === '[ฉัน] ข้อความเดิม <tag> 🙂' &&
                qaTextColorAt(row, prefixBytes - 1) !== qaTextColorAt(row, prefixBytes + 1),
                'Thai speaker prefixes retain their color without coloring the message body');
            qaAssert(row.menu._getMenuItems()[0].label.text === 'คัดลอก' &&
                this._logEntry.menu._copyItem.label.text === 'คัดลอก' &&
                this._overlayEntry.menu._pasteItem.label.text === 'วาง', 'Copy/Paste follows the selected UI language');
            qaAssert(this._commandMenus.every(menu => menu._commands[0].name === '/status' &&
                menu._commands[0].description === 'แสดงโมเดล สถานะ และสิทธิ์ปัจจุบัน'),
                'Slash commands keep their identifiers and translate their descriptions');
            await this._shot('language-th-menu');
            await this._click(this._vimMenuItem);
            qaAssert(this._vimEnabled !== vimEnabled && this._vimMenuItem.label.text ===
                `Vim: ${this._vimEnabled ? 'เปิด' : 'ปิด'}`, 'Vim remains independently switchable in Thai');
            await this._click(this._vimMenuItem);
            this._snapshot.state = 'thinking';
            this._snapshot.request_id = 'qa-language-request';
            this._renderSnapshot();
            const ticker = this._thinkingSource;
            qaAssert(this._logStatus.text.startsWith('[Aiko] กำลังคิด...') && this._logCancel.label === 'หยุด',
                'Thai translates request status and the Stop control');
            await this._click(this._langMenuItem);
            qaAssert(this._language === 'en' && this._characterMenu.isOpen && this._thinkingSource === ticker &&
                this._logStatus.text.startsWith('[Aiko] Thinking...') && this._logCancel.label === 'Stop',
                'Lang toggles back to English without restarting an active request clock');
            this._snapshot.state = 'idle';
            this._snapshot.request_id = null;
            this._uiError = 'error.send';
            this._renderSnapshot();
            const errorExpiry = this._answerHideSource;
            await this._click(this._langMenuItem);
            qaAssert(this._logStatus.text === '[Aiko] ส่งข้อความไม่ได้ กรุณาลองอีกครั้ง' &&
                this._answerHideSource === errorExpiry, 'Existing UI errors translate without extending their expiry');
        } finally {
            if (this._language !== 'en')
                this._toggleLanguage();
            if (this._vimEnabled !== vimEnabled)
                this._toggleVim();
            this._characterMenu.close();
            this._snapshot = snapshot;
            this._uiError = uiError;
            this._overlayEntry.set_text(drafts[0]);
            this._logEntry.set_text(drafts[1]);
            this._historySignature = null;
            this._renderSnapshot();
            this._hidePanel();
            this._hideInput();
        }
    }

    async _checkMotion() {
        const snapshot = this._snapshot;
        const breath = () => this._body.get_transition('zaiko-breath');
        try {
            qaAssert(St.Settings.get().enable_animations && this._character.visible && breath()?.is_playing() &&
                breath().get_repeat_count() === -1, 'The visible character breathes in an endless loop');
            const calm = breath().duration;
            this._snapshot = {...snapshot, state: 'thinking', request_id: 'qa-motion', error: null};
            this._renderSnapshot();
            const frame = this._frame;
            qaAssert(breath().duration < calm && this._image.get_transition('scale-x') &&
                EXPRESSIONS.thinking.includes(frame) && this._frameCycleSource,
                'Thinking breathes faster, pops in a thinking frame and schedules the next one');
            await qaPause(400);
            qaAssert(this._image.scale_x === 1 && this._image.opacity === 255, 'The frame pop settles at full size');
            this._showNextFrame();
            qaAssert(this._frame !== frame && EXPRESSIONS.thinking.includes(this._frame),
                'Frame rotation picks another frame of the same mood');
            this._character.visible = false;
            this._motion.setActive(false);
            qaAssert(!breath() && this._body.scale_y === 1, 'Hiding the character stops breathing');
            this._motion.setActive(true);
            this._character.visible = true;
            qaAssert(breath()?.is_playing(), 'Showing the character resumes breathing');
        } finally {
            this._snapshot = snapshot;
            this._renderSnapshot();
            this._updateVisibility();
        }
    }

    async _checkCharacterSize() {
        const size = this._characterSize;
        try {
            qaAssert(size === 3 && this._character.width === 312 && this._sizeMenuItem.label.text === 'CharSize: 3',
                'Character size defaults to 3');
            this._positionCharacter(500, 400);
            await qaPause(60);
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), this._character.x + 100, this._character.y + 100);
            await qaPause(40);
            this._openCharacterMenu();
            await qaPause(200);
            const rows = this._characterMenu._getMenuItems().map(item => item.label.text).join(',');
            qaAssert(rows === `Log,CharSize: 3,Lang: en,Vim: ${this._vimEnabled ? 'on' : 'off'},Quit`,
                `Log is first, Quit is last and the rows between are sorted A-Z: ${rows}`);
            const anchor = () => [this._character.x + this._character.width / 2, this._character.y + this._character.height];
            const start = anchor();
            const seen = [];
            for (let step = 0; step < 6; step++) {
                await this._click(this._sizeMenuItem);
                await qaPause(60);
                seen.push({size: this._characterSize, width: this._character.width, height: this._character.height,
                    image: this._image.width, label: this._sizeMenuItem.label.text, open: this._characterMenu.isOpen,
                    saved: this._loadCharacterSize(), anchor: anchor()});
            }
            qaAssert(seen.map(row => row.size).join() === '4,5,1,2,3,4' &&
                seen.map(row => row.width).join() === '390,468,208,260,312,390' &&
                seen.every(row => row.label === `CharSize: ${row.size}` && row.open && row.saved === row.size &&
                    row.image > row.width * 0.9 && Math.abs(row.anchor[0] - start[0]) <= 1 &&
                    Math.abs(row.anchor[1] - start[1]) <= 1),
                `CharSize cycles 1-5, keeps the menu open, saves the choice and keeps her bottom centre: ${JSON.stringify(seen)}`);
        } finally {
            while (this._characterSize !== size)
                this._cycleCharacterSize();
            this._characterMenu.close();
        }
    }

    async _checkVimInputs() {
        const drafts = [this._overlayEntry.get_text(), this._logEntry.get_text()];
        const originalCall = this._callCore;
        const messages = JSON.stringify(this._snapshot.messages);
        const calls = [];
        this._callCore = async (method, parameters) => { calls.push({method, args: parameters?.deep_unpack()}); return []; };
        const keys = async value => {
            for (const character of value)
                await this._key(character.codePointAt(0));
        };
        const controller = entry => this._vimInputs.find(vim => vim.entry === entry);
        try {
            this._openCharacterMenu();
            await qaPause(200);
            qaAssert(!this._vimEnabled && this._vimMenuItem.label.text === 'Vim: off', 'Input Vim defaults to off');
            await this._click(this._vimMenuItem);
            qaAssert(this._vimEnabled && this._vimMenuItem.label.text === 'Vim: on' && this._characterMenu.isOpen,
                `Clicking Vim toggles on, updates its label and keeps the menu open: ${JSON.stringify({enabled: this._vimEnabled, label: this._vimMenuItem.label.text, open: this._characterMenu.isOpen, panel: this._panel.visible, hover: this._vimMenuItem.hover})}`);
            await this._click(this._vimMenuItem);
            qaAssert(!this._vimEnabled && this._vimMenuItem.label.text === 'Vim: off' && this._characterMenu.isOpen,
                'Clicking Vim again toggles off without closing the menu');
            await this._click(this._vimMenuItem);
            qaAssert(this._loadVimEnabled(), 'The input Vim preference is saved in Zaiko configuration');
            await this._key(Clutter.KEY_Escape);
            this._showLog();
            const entry = this._logEntry;
            const text = entry.clutter_text;
            entry.set_text('alpha beta tail');
            text.set_cursor_position(0);
            await keys('wciwnew');
            await this._key(Clutter.KEY_Escape);
            qaAssert(entry.get_text() === 'alpha new tail' && controller(entry)._state.mode === 'normal' && this._panel.visible,
                'Log Vim changes the inner word and Escape keeps the input open in normal mode');
            qaAssert(!text.editable && text.get_cursor_visible() && text.get_cursor_size() >= 8 &&
                (await qaCaretPhases(text, 200)).size === 1, 'Normal mode has a steady block cursor and blocks plain typing');
            this._snapshot.model = 'gpt-6.1-sol';
            this._renderSnapshot();
            qaAssert(this._logFooter.visible && this._logModel.text === 'gpt-6.1-sol' &&
                this._logVimMode.text === '--NORMAL--' &&
                qaColor(this._logVimMode.get_theme_node().get_foreground_color(), '#c678dd'),
            'Log footer shows the model on the left and a purple --NORMAL-- on the right');
            const [footerX] = this._logFooter.get_transformed_position();
            const [modeX] = this._logVimMode.get_transformed_position();
            qaAssert(modeX + this._logVimMode.width >= footerX + this._logFooter.width - 3 &&
                this._logFooter.get_transformed_position()[1] >= this._logComposer.get_transformed_position()[1] + this._logComposer.height,
            'Vim mode is right-aligned below the input');
            await this._shot('vim-normal-input');
            await keys('i');
            qaAssert(this._logVimMode.text === '--INSERT--' &&
                qaColor(this._logVimMode.get_theme_node().get_foreground_color(), '#98c379'),
            'Insert mode shows a green --INSERT--');
            await this._shot('vim-insert-footer');
            await this._key(Clutter.KEY_Escape);
            await keys('0rX');
            qaAssert(entry.get_text() === 'Xlpha new tail', 'Native key events replace a single input character');
            await keys('RZQ');
            await this._key(Clutter.KEY_BackSpace);
            await this._key(Clutter.KEY_Escape);
            qaAssert(entry.get_text() === 'Zlpha new tail', 'Replace-mode Backspace restores the overwritten input character');
            text.set_selection(0, 5);
            await this._click(entry, Clutter.BUTTON_SECONDARY);
            await this._click(entry.menu._getMenuItems()[0]);
            const clipboard = St.Clipboard.get_default();
            const copied = await new Promise(resolve =>
                clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, value) => resolve(value)));
            qaAssert(copied === 'Zlpha', 'Native context Copy still works in Vim normal mode');
            text.grab_key_focus();
            text.set_selection(-1, -1);
            clipboard.set_text(St.ClipboardType.CLIPBOARD, ' pasted');
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            await this._key(Clutter.KEY_v);
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            qaAssert(entry.get_text() === 'Zlpha new tail pasted' && controller(entry)._state.mode === 'insert',
                'Ctrl+V enters insert mode and preserves normal clipboard pasting');
            await this._checkLogVimFocus();
            await this._key(Clutter.KEY_Escape);
            await keys('dd');
            qaAssert(entry.get_text() === '' && JSON.stringify(this._snapshot.messages) === messages,
                'dd clears only the input draft and preserves conversation history');
            await keys('ihello');
            await this._key(Clutter.KEY_Return);
            qaAssert(calls.filter(call => call.method === 'Submit').length === 1 && calls.at(-1).args[1] === 'hello' &&
                this._panel.visible && entry.get_text() === '', 'Vim Enter sends once and keeps Log open');
            await qaPause(100);
            qaAssert(controller(entry)._state.mode === 'insert' && text.has_key_focus() && text.editable &&
                this._logVimMode.text === '--INSERT--',
            `Sending keeps the Vim mode and input focus: ${JSON.stringify({mode: controller(entry)._state.mode, focus: text.has_key_focus()})}`);
            await this._checkThaiVimKeys();
            this._snapshot.state = 'thinking';
            this._renderSnapshot();
            await keys('iX');
            qaAssert(entry.get_text() === '' && !text.editable, 'Vim cannot edit input while a request is busy');
            this._snapshot.state = 'idle';
            this._renderSnapshot();
            this._hidePanel();
            this._showInput();
            const compact = this._overlayEntry;
            compact.set_text('draft');
            compact.clutter_text.set_cursor_position(0);
            await keys('A!');
            await this._key(Clutter.KEY_Escape);
            qaAssert(compact.get_text() === 'draft!' && controller(compact)._state.mode === 'normal' && this._inputOverlay.visible,
                'Compact input supports append and Escape without hiding the draft');
            await this._click(compact);
            qaAssert(controller(compact)._state.mode === 'normal' && !compact.clutter_text.editable &&
                compact.get_text() === 'draft!',
            'Mouse clicks keep normal mode; only insert commands such as i enter insert mode');
            await keys('i');
            qaAssert(controller(compact)._state.mode === 'insert' && compact.clutter_text.editable,
                'i enters insert mode after a click');
            this._openCharacterMenu();
            await qaPause(200);
            const beforeToggle = compact.get_text();
            await this._click(this._vimMenuItem);
            qaAssert(!this._vimEnabled && this._characterMenu.isOpen && compact.get_text() === beforeToggle,
                'Disabling Vim preserves the input draft and keeps its menu open');
            await this._key(Clutter.KEY_Escape);
            this._showInput();
            compact.clutter_text.set_selection(-1, -1);
            await keys('h');
            qaAssert(compact.get_text() === 'draft!h' && compact.clutter_text.get_cursor_size() < 8,
                `Vim off restores ordinary typing and the normal insertion caret: ${JSON.stringify({text: compact.get_text(), size: compact.clutter_text.get_cursor_size(), enabled: this._vimEnabled, editable: compact.clutter_text.editable, focus: compact.clutter_text.has_key_focus()})}`);
        } finally {
            this._callCore = originalCall;
            this._snapshot.state = 'idle';
            this._overlayEntry.set_text(drafts[0]);
            this._logEntry.set_text(drafts[1]);
            this._hidePanel();
            this._hideInput();
            this._renderSnapshot();
        }
    }

    async _checkFastCharacterDrag() {
        this._hidePanel();
        this._hideInput();
        this._positionCharacter(760, 400);
        await qaPause(60);
        const start = {x: this._character.x, y: this._character.y};
        const pointer = {x: start.x + 100, y: start.y + 130};
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), pointer.x, pointer.y);
        await qaPause(30);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await qaPause(30);
        qaAssert(global.stage.get_grab_actor() === this._character,
            'The initial press holds pointer ownership before the first fast movement');
        for (const [dx, dy] of [[-360, -220], [-80, -40], [-500, -280], [-140, -20]]) {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), pointer.x + dx, pointer.y + dy);
            await qaPause(40);
            qaAssert(Math.abs(this._character.x - start.x - dx) <= 1 &&
                Math.abs(this._character.y - start.y - dy) <= 1,
            `Fast drag follows jumps beyond its previous hit area: ${JSON.stringify({dx, dy, x: this._character.x, y: this._character.y, start, drag: Boolean(this._dragOrigin), grab: Boolean(this._characterGrab)})}`);
        }
        for (let burst = 0; burst < 12; burst++) {
            for (const [dx, dy] of [[-600, -250], [-80, -30], [-420, -190], [-200, -100]])
                this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), pointer.x + dx, pointer.y + dy);
        }
        await qaPause(60);
        qaAssert(Math.abs(this._character.x - (start.x - 200)) <= 1 &&
            Math.abs(this._character.y - (start.y - 100)) <= 1,
        'A rapid burst of direction reversals retains the original pointer offset');
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 10, 40);
        await qaPause(40);
        qaAssert(this._character.x === this._workArea().x + 8, 'A fast drag clamps at the work-area edge');
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), pointer.x - 300, pointer.y - 100);
        await qaPause(40);
        qaAssert(Math.abs(this._character.x - (start.x - 300)) <= 1 &&
            Math.abs(this._character.y - (start.y - 100)) <= 1,
        'Dragging back from a clamped edge follows the held pointer without reacquiring the character');
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await qaPause(50);
        qaAssert(!this._inputOpen && !this._dragOrigin && !this._characterGrab,
            'Fast dragging releases its pointer grab without opening input');
        const dropped = {x: this._character.x, y: this._character.y};
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        await qaPause(30);
        qaAssert(this._character.x === dropped.x && this._character.y === dropped.y,
            'The character stops following the pointer after release');
        await this._click(this._character);
        qaAssert(this._inputOpen && this._inputOverlay.visible, 'A click still opens input after a fast drag');
        this._hideInput();
        for (const cancel of ['escape', 'hide']) {
            const [x, y] = this._character.get_transformed_position();
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + 100, y + 130);
            await qaPause(30);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await qaPause(30);
            if (cancel === 'escape') {
                await this._key(Clutter.KEY_Escape);
            } else {
                this._overviewShowing = true;
                this._updateVisibility();
            }
            qaAssert(!this._characterGrab && !this._dragOrigin && global.stage.get_grab_actor() !== this._character,
                `${cancel} cancels the held drag and releases pointer ownership`);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await qaPause(40);
            this._overviewShowing = false;
            this._updateVisibility();
            qaAssert(!this._inputOpen, 'Releasing a cancelled drag does not open input');
        }
    }

    async _checkCharacterMenuPosition() {
        this._hidePanel();
        this._hideInput();
        const original = {x: this._character.x, y: this._character.y};
        const area = this._workArea();
        const width = this._character.width;
        const height = this._character.height;
        for (const [name, x, y, offsetX, offsetY] of [
            ['middle', area.x + area.width / 2 - width / 2, area.y + area.height / 2 - height / 2, 40, 60],
            ['top-left', area.x, area.y, 3, 3],
            ['top-right', area.x + area.width, area.y, width - 3, 3],
            ['bottom-left', area.x, area.y + area.height, 3, height - 3],
            ['bottom-right', area.x + area.width, area.y + area.height, width - 3, height - 3],
        ]) {
            this._positionCharacter(x, y);
            await qaPause(40);
            const pointerX = this._character.x + offsetX;
            const pointerY = this._character.y + offsetY;
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), pointerX, pointerY);
            await qaPause(25);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
            await qaPause(25);
            this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
            await qaPause(180);
            qaAssert(this._characterMenu.isOpen, `${name}: native right-click opens the character menu`);
            const [menuX, menuY] = this._characterMenu.actor.get_transformed_position();
            const [menuWidth, menuHeight] = this._characterMenu.actor.get_transformed_size();
            const distanceX = Math.max(menuX - pointerX, 0, pointerX - menuX - menuWidth);
            const distanceY = Math.max(menuY - pointerY, 0, pointerY - menuY - menuHeight);
            qaAssert(Math.hypot(distanceX, distanceY) <= 12,
                `${name}: the menu stays near the click: ${JSON.stringify({pointerX, pointerY, menuX, menuY, menuWidth, menuHeight, anchorX: this._characterMenuAnchor.x, anchorY: this._characterMenuAnchor.y, mapped: this._characterMenuAnchor.mapped, anchorPosition: this._characterMenuAnchor.get_transformed_position()})}`);
            qaAssert(menuX >= area.x && menuY >= area.y &&
                menuX + menuWidth <= area.x + area.width && menuY + menuHeight <= area.y + area.height,
            `${name}: the complete menu stays inside the monitor work area`);
            if (name === 'bottom-right')
                await this._shot('character-menu-at-screen-edge');
            await this._key(Clutter.KEY_Escape);
            qaAssert(!this._characterMenu.isOpen, `${name}: Escape closes the character menu`);
        }
        this._positionCharacter(original.x, original.y);
    }

    async _checkMultilineInput(entry = this._logEntry) {
        const compact = entry === this._overlayEntry;
        const composer = compact ? this._inputOverlay : this._logComposer;
        const viewport = compact ? this._overlayInputScroll : this._logInputScroll;
        const cancel = compact ? this._overlayCancel : this._logCancel;
        const originalCall = this._callCore;
        const draft = entry.get_text();
        const calls = [];
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            return [];
        };
        const newline = async () => {
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            await this._key(Clutter.KEY_Return);
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        };
        try {
            entry.set_text('');
            entry.grab_key_focus();
            await qaPause(80);
            const emptyHeight = composer.height;
            for (const value of ['a', 'ท', 'ที', 'ที่', 'ป', 'ปุ', 'ปู่', 'น้ำ', '']) {
                entry.set_text(value);
                await qaPause(50);
                qaAssert(composer.height === emptyHeight,
                    `Thai combining marks keep one-row input height stable: ${JSON.stringify({value, height: composer.height, emptyHeight})}`);
                const [, shapedHeight] = entry.clutter_text.get_layout().get_pixel_size();
                qaAssert(viewport.height >= shapedHeight, 'Reserved row height fits every Thai mark without clipping');
            }
            entry.set_text('a\nb');
            await qaPause(60);
            const twoRows = composer.height;
            entry.set_text('ที่\nปู่');
            await qaPause(60);
            qaAssert(composer.height === twoRows, 'Thai marks keep multiline input height stable too');
            entry.set_text('บรรทัดแรก');
            entry.clutter_text.set_selection(-1, -1);
            entry.grab_key_focus();
            await qaPause(80);
            const small = composer.height;
            const [, lineHeight] = entry.clutter_text.get_layout().get_pixel_size();
            qaAssert(small === emptyHeight && viewport.height >= lineHeight && small <= viewport.height + 12,
                `Single-line input uses one row plus padding: ${JSON.stringify({small, lineHeight, viewport: viewport.height})}`);
            qaAssert(!entry.hint_text && !cancel.visible &&
                composer.get_theme_node().get_border_width(St.Side.LEFT) === 0,
                'Log has no placeholder, send control or focus border');
            await newline();
            qaAssert(entry.get_text() === 'บรรทัดแรก\n' && !calls.length,
                'Shift+Enter inserts a newline without sending');
            await this._key(Clutter.KEY_a);
            qaAssert(entry.get_text() === 'บรรทัดแรก\na' && composer.height > small,
                'Multiline input grows and accepts typing on the second line');
            await this._key(Clutter.KEY_Return);
            qaAssert(calls.length === 1 && calls[0].args[1] === 'บรรทัดแรก\na' && !entry.get_text(),
                'Enter submits the whole multiline draft exactly once');
            if (compact)
                this._showInput();
            const pasted = Array.from({length: compact ? 100 : 18}, (_, index) => `บรรทัด ${index + 1} Lorem ipsum`).join('\n');
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, pasted);
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            await this._key(Clutter.KEY_v);
            this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
            qaAssert(entry.get_text() === pasted, 'Native paste preserves every line of a long draft');
            entry.clutter_text.set_selection(-1, -1);
            await qaPause(160);
            const scroll = viewport.get_vadjustment();
            qaAssert(scroll.upper > scroll.page_size && composer.height > this._panel.height / 2 &&
                (compact ? composer.height <= this._workArea().height - 16 :
                    composer.height < this._panel.height && this._logScroll.height > 0),
                `Long drafts scroll inside a bounded composer: ${JSON.stringify({upper: scroll.upper, page: scroll.page_size, height: composer.height})}`);
            qaAssert(scroll.value > 0, 'The last line and caret remain visible in a long draft');
            await this._shot(compact ? 'multiline-compact-input' : 'multiline-log-input');
            if (compact) {
                const area = this._workArea();
                qaAssert(composer.y >= area.y + 8 && composer.y + composer.height <= area.y + area.height - 8,
                    'Expanded compact input stays within the work area');
            }
            entry.clutter_text.set_cursor_position(0);
            await qaPause(60);
            qaAssert(scroll.value === 0, 'Moving to the first line scrolls the input back to the top');
            entry.set_text('Lorem ipsum '.repeat(30));
            await qaPause(100);
            qaAssert(entry.clutter_text.get_layout().get_line_count() > 1,
                'Long lines wrap within the composer');
            entry.set_text('');
            await qaPause(80);
            qaAssert(composer.height <= small, 'Clearing a draft shrinks the composer');
            await this._shot(compact ? 'single-row-compact-input' : 'single-row-log-input');
            this._toggleVim();
            entry.set_text('/s');
            entry.clutter_text.set_selection(-1, -1);
            await newline();
            qaAssert(entry.get_text() === '/s\n' && calls.length === 1,
                'Shift+Enter works with Vim enabled and the command picker open');
            this._toggleVim();
        } finally {
            if (this._vimEnabled)
                this._toggleVim();
            this._callCore = originalCall;
            entry.set_text(draft);
        }
    }

    async _checkCaret(entry, button) {
        await this._checkComposerHitArea(entry, button);
        const composer = entry === this._logEntry ? this._logComposer : this._inputOverlay;
        const settings = this._interfaceSettings;
        const text = entry.clutter_text;
        // These settings belong only to the private QA session.
        settings.set_int('cursor-blink-time', 200);
        settings.set_int('cursor-blink-timeout', 1);
        settings.set_boolean('cursor-blink', true);
        entry.grab_key_focus();
        entry.set_text('');
        qaAssert(text.has_key_focus(), 'Entry owns text focus');
        qaAssert(composer.has_style_pseudo_class('focus'), 'Input focus highlights the outer composer');
        qaAssert(entry.get_theme_node().get_background_color().alpha === 0 &&
            entry.get_theme_node().get_border_width(St.Side.LEFT) === 0 &&
            (!button || button.get_theme_node().get_border_width(St.Side.LEFT) === 0),
        'Input and send button share one outer surface without nested borders');
        qaAssert((await qaCaretPhases(text)).size === 2, 'Focused empty input caret visibly blinks');
        await qaPause(650);
        qaAssert(text.get_cursor_visible() && (await qaCaretPhases(text, 200)).size === 1,
            'Idle timeout leaves the caret steadily visible');
        entry.set_text('caret probe');
        qaAssert(text.get_cursor_visible(), 'Typing immediately reveals the caret');
        qaAssert((await qaCaretPhases(text)).size === 2, 'Typing restarts blinking after idle timeout');
        text.set_cursor_position(0);
        qaAssert(text.get_cursor_visible(), 'Moving the caret immediately reveals it');
        settings.set_boolean('cursor-blink', false);
        qaAssert(text.get_cursor_visible() && (await qaCaretPhases(text, 250)).size === 1,
            'Disabling desktop cursor blinking keeps a steady caret');
        settings.set_boolean('cursor-blink', true);
        text.editable = false;
        qaAssert(!text.get_cursor_visible(), 'Read-only input hides its insertion caret');
        text.editable = true;
        qaAssert(text.get_cursor_visible(), 'Editable input restores its focused caret');
        (button ?? composer).grab_key_focus();
        qaAssert(composer.has_style_pseudo_class('focus'),
            'Keyboard focus stays within the composer');
        qaAssert(!text.has_key_focus() && !text.get_cursor_visible(), 'Focus transfer hides the caret');
        qaAssert((await qaCaretPhases(text, 250)).size === 1, 'Unfocused caret stays hidden');
        entry.grab_key_focus();
        qaAssert(text.get_cursor_visible(), 'Refocusing immediately restores the caret');
        entry.set_text('');
        settings.set_int('cursor-blink-time', 1200);
        settings.set_int('cursor-blink-timeout', 10);
    }

    async _checkPanelClose() {
        const [x, y] = this._panel.get_transformed_position();
        const move = async (targetX, targetY) => {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), targetX, targetY);
            await qaPause(50);
        };
        await move(100, 80);
        qaAssert(!this._panelClose.visible && this._panel.visible, 'Close stays hidden while the pointer is outside Log');
        const [, historyY] = this._logHistory.get_transformed_position();
        const historyHeight = this._logScroll.height;
        qaAssert(historyY - y >= 16 && historyY - y <= 18, 'Transcript keeps normal 16 px top padding without a close row');
        await move(x + 20, y + 60);
        qaAssert(this._panelClose.visible, 'Entering Log immediately reveals close');
        const [closeX, closeY] = this._panelClose.get_transformed_position();
        qaAssert(Math.abs(closeY - y - 12) <= 1 &&
            Math.abs(x + this._panel.width - closeX - this._panelClose.width - 12) <= 1,
        'Close is inset 12 px from the top and right edges');
        qaAssert(this._logHistory.get_transformed_position()[1] === historyY && this._logScroll.height === historyHeight,
            'Showing the overlaid close leaves message position and available height unchanged');
        await move(closeX + 14, closeY + 14);
        await qaPause(300);
        qaAssert(this._panelClose.visible, 'Hovering close does not count as leaving Log');
        const [entryX, entryY] = this._logEntry.get_transformed_position();
        await move(entryX + 20, entryY + 10);
        await qaPause(300);
        qaAssert(this._panelClose.visible, 'Hovering the nested input keeps close visible');
        await move(100, 80);
        qaAssert(!this._panelClose.visible, 'Close hides immediately on leaving, before the old 300 ms delay');
        await move(x + 20, y + 60);
        qaAssert(this._panelClose.visible, 'Re-entering immediately restores close');
        await move(100, 80);
        this._renderSnapshot();
        qaAssert(!this._panelClose.visible, 'Snapshot refreshes do not restore close outside Log');
        qaAssert(this._logHistory.get_transformed_position()[1] === historyY && this._logScroll.height === historyHeight,
            'Hiding close does not resize or move the transcript');
        await move(x + 20, y + 60);
        await this._shot('log-close-inside');
    }

    async _runQA() {
        const {default: GObject} = await import('gi://GObject');
        if (this._coreWatch)
            Gio.bus_unwatch_name(this._coreWatch);
        this._coreWatch = 0;
        this._coreOwner = 'qa-only-no-provider';
        qaAssert(!this._themeSettings && !this._showAppearance && !this._paletteDirectory, 'Theme settings, chooser and generated palette loader are removed');
        this._refreshSnapshot = () => {};
        const calls = [];
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            return [];
        };
        const seat = global.stage.context.get_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        Main.overview.hide();
        await qaPause(700);
        this._snapshot = {messages: [], state: 'idle'};
        this._renderSnapshot();
        this._updateVisibility();
        if (GLib.getenv('ZAIKO_QA_COMMANDS_ONLY') === '1') {
            await this._checkCommandMenus();
            const menus = this._commandMenus.slice();
            this.disable();
            qaAssert(menus.every(menu => menu._signals.length === 0 && !menu.actor.get_parent()),
                'Disable disconnects and destroys command pickers');
            this._qaResult({ok: true, checked: 'command picker: eight rows, keyboard/mouse scrolling, filtering, Tab/Enter/click, focus, Escape, Vim, busy state, lifecycle'});
            return;
        }
        if (GLib.getenv('ZAIKO_QA_VIM_ONLY') === '1') {
            await this._checkVimInputs();
            this.disable();
            this._qaResult({ok: true, checked: 'Vim editing, physical Thai keys, o/O/Ctrl+J, busy state and lifecycle'});
            return;
        }
        if (GLib.getenv('ZAIKO_QA_LANGUAGE_ONLY') === '1') {
            await this._checkLanguage();
            this.disable();
            this._qaResult({ok: true, checked: 'th/en language menu, JSON preference, translated UI, draft/history/expiry preservation'});
            return;
        }
        qaAssert(!this._inputOverlay.visible && !this._panel.visible, 'No input or support panel auto-opens on core connection');
        qaAssert(!this._chat && !this._entry && !this._composer && !this._answerBubble, 'Legacy UI/composer/card actors removed');
        qaAssert(!this._answerLabel.visible, 'No empty answer placeholder');
        this._present();
        await qaPause(150);
        qaAssert(this._inputOverlay.visible && !this._panel.visible, 'Present opens only input');
        qaAssert(this._inputOverlay.y + this._inputOverlay.height <= this._character.y + this._character.height + 1,
            'Input overlays the bottom of character');
        await this._checkCaret(this._overlayEntry);
        await this._checkMultilineInput(this._overlayEntry);

        await this._click(this._character);
        qaAssert(this._inputOverlay.visible, 'Repeated character click keeps input open');
        await this._click(this._character);
        qaAssert(this._inputOverlay.visible, 'Character click is idempotent');
        this._overlayEntry.set_text('draft kept outside');
        await this._click(this._overlayEntry);
        qaAssert(this._inputOverlay.visible, 'Entry click does not dismiss input');
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, 'QA clipboard text');
        await this._click(this._overlayEntry, Clutter.BUTTON_SECONDARY);
        qaAssert(this._overlayEntry.menu.isOpen && this._inputOverlay.visible, 'Entry context menu does not dismiss input');
        const entryMenu = this._overlayEntry.menu;
        qaAssert(entryMenu.actor.has_style_class_name('zaiko-context') &&
            qaColor(entryMenu.box.get_theme_node().get_background_color(), '#282c34') &&
            entryMenu.box.get_theme_node().get_border_radius(St.Corner.TOPLEFT) === 8 &&
            entryMenu.actor.get_theme_node().get_font().to_string() ===
                this._characterMenu.actor.get_theme_node().get_font().to_string() &&
            !qaContainsText(entryMenu.box, 'Ctrl+C') && !qaContainsText(entryMenu.box, 'Ctrl+V'),
        'Copy/Paste uses the Log/Quit menu surface, corners and font without added shortcut labels');
        const editItems = entryMenu._getMenuItems();
        qaAssert(!editItems[0].reactive && editItems[1].reactive, 'Native Copy/Paste sensitivity is preserved');
        await this._checkMenuHover(entryMenu, this._inputOverlay);
        await this._shot('entry-context-menu');
        await this._click(editItems[1].actor);
        qaAssert(this._overlayEntry.get_text().includes('QA clipboard text') && this._inputOverlay.visible, 'Native Paste inserts clipboard text without hiding input');
        this._overlayEntry.set_text('draft kept outside');
        this._overlayEntry.clutter_text.set_selection(0, -1);
        await this._click(this._overlayEntry, Clutter.BUTTON_SECONDARY);
        qaAssert(editItems[0].reactive, 'Copy becomes enabled for a selection');
        await this._click(editItems[0].actor);
        const copied = await new Promise(resolve => clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text)));
        qaAssert(copied === 'draft kept outside' && this._inputOverlay.visible, 'Native Copy remains functional');
        this._overlayEntry.set_text('draft kept outside');

        // An unrelated target receives the same outside click exactly once.
        const outside = new St.Button({
            label: 'QA outside target', reactive: true, can_focus: true, width: 180, height: 48,
            style: 'background-color: #dddddd; color: #111111;',
        });
        outside.set_position(100, 100);
        let outsideClicks = 0;
        outside.connect('clicked', () => { outsideClicks++; outside.grab_key_focus(); });
        Main.uiGroup.add_child(outside);
        await qaPause(80);
        this._overlayEntry.clutter_text.set_selection(0, -1);
        await this._click(outside);
        qaAssert(!this._inputOverlay.visible && outsideClicks === 1, 'Outside click hides input and activates its target once');
        qaAssert(global.stage.get_key_focus() === outside, 'Outside click retains target focus');
        qaAssert(!this._overlayEntry.clutter_text.get_cursor_visible(), 'Hidden compact input has no active caret');
        qaAssert(!this._overlayEntry.clutter_text.get_selection(), 'Outside click also clears compact input selection');
        qaAssert(this._overlayEntry.get_text() === 'draft kept outside', 'Outside dismissal preserves draft');
        await this._click(this._character);
        qaAssert(this._inputOverlay.visible, 'Character click opens hidden input');
        const blank = new St.Widget({reactive: true, width: 80, height: 48});
        blank.set_position(300, 100);
        let blankPresses = 0;
        blank.connect('button-press-event', () => { blankPresses++; return Clutter.EVENT_PROPAGATE; });
        Main.uiGroup.add_child(blank);
        await qaPause(60);
        await this._click(blank);
        qaAssert(!this._inputOverlay.visible && blankPresses === 1,
            'Outside press dismisses even when the target never takes keyboard focus');
        blank.destroy();
        await this._click(this._character);

        this._snapshot.messages = [
            {role: 'user', content: 'สวัสดีค่ะ'},
            {role: 'assistant', content: 'สวัสดีค่ะ ไอโกะอยู่นี่นะคะ 😊'},
        ];
        this._renderSnapshot();
        await qaPause(160);
        const shortHeight = this._answerLabel.height;
        qaAssert(this._answerLabel.visible && this._answerLabel.text === '[Aiko] สวัสดีค่ะ ไอโกะอยู่นี่นะคะ 😊', 'Plain answer contains Aiko prefix');
        const bubble = this._answerLabel.get_theme_node();
        qaAssert(bubble.get_background_color().alpha === this._panel.get_theme_node().get_background_color().alpha &&
            bubble.get_border_width(St.Side.TOP) === 1 && qaColor(bubble.get_border_color(St.Side.TOP), '#3e4451'),
        'The bubble matches the Log transparency and border');
        qaAssert(qaColor(bubble.get_background_color(), '#282c34') && bubble.get_border_radius(St.Corner.TOPLEFT) === 12 &&
            bubble.get_padding(St.Side.LEFT) === 12 && bubble.get_padding(St.Side.TOP) === 8,
        'Answer is a rounded One Half Dark bubble with padding');
        qaAssert(this._answerLabel.width < 320, `Short answers shrink the bubble to their text: ${this._answerLabel.width}`);
        const prefixColor = qaTextColorAt(this._answerLabel, 1);
        const answerBodyColor = qaTextColorAt(this._answerLabel, 8);
        qaAssert(prefixColor?.startsWith('#c6c6') && answerBodyColor !== prefixColor && Number.parseInt(answerBodyColor?.slice(1, 3) ?? 'ff', 16) >= 0xd0,
            `The bubble prefix is purple and the body stays light: ${JSON.stringify({prefixColor, answerBodyColor})}`);
        qaAssert(this._answerLabel.clutter_text.get_layout().get_line_count() === 1,
            `A short reply fits on one line inside its bubble: ${JSON.stringify({width: this._answerLabel.width, height: this._answerLabel.height, natural: this._answerLabel.get_preferred_width(-1), textWidth: this._answerLabel.clutter_text.width, layout: this._answerLabel.clutter_text.get_layout().get_pixel_size(), lines: this._answerLabel.clutter_text.get_layout().get_line_count(), max: this._answerMaxWidth})}`);
        qaAssert(this._answerTail.visible && this._answerTail.y === this._answerLabel.y + this._answerLabel.height - 1 &&
            this._answerTail.y + this._answerTail.height <= this._character.y &&
            this._answerTail.x >= this._answerLabel.x && this._answerTail.x + this._answerTail.width <= this._answerLabel.x + this._answerLabel.width,
        'The bubble tail sits under the bubble and points at the character');
        qaAssert(this._answerLabel.y + this._answerLabel.height <= this._character.y, 'Answer above character');
        outside.hide();
        await this._shot('plain-answer-input');
        outside.show();

        const answerTimer = this._answerHideSource;
        await qaPause(3500);
        this._renderSnapshot();
        this._showInput();
        GLib.file_set_contents(`${GLib.get_user_config_dir()}/zaiko/ui.json`, '{"theme":"forest","syncZhyprbola":true}');
        GLib.file_set_contents(`${GLib.get_user_config_dir()}/zhyprbola/theme`, 'forest');
        qaAssert(this._answerHideSource === answerTimer, 'Unchanged message is not prolonged by repaint/input/ignored legacy preference changes');
        await this._click(this._character, Clutter.BUTTON_SECONDARY);
        qaAssert(this._characterMenu.isOpen && this._answerLabel.visible && this._answerHideSource === answerTimer,
            'Right click keeps the latest answer visible without restarting its countdown');
        const retainedLogItem = this._characterMenu._getMenuItems().find(item => item.label?.text === 'Log');
        await this._click(retainedLogItem.actor);
        qaAssert(this._panel.visible && !this._answerLabel.visible && this._answerHideSource === 0,
            'Choosing Log hides and dismisses the floating answer');
        qaAssert(!this._ownsFocus(global.stage.get_key_focus(), [this._answerLabel]), 'Dismissed answer does not keep focus');
        this._hidePanel();
        qaAssert(!this._answerLabel.visible, 'Closing Log does not bring back an answer already seen in Log');
        this._renderSnapshot();
        qaAssert(!this._answerLabel.visible, 'Repaint does not resurrect a dismissed answer');
        this._showLog();
        qaAssert(qaContainsText(this._logHistory, this._snapshot.messages[1].content), 'Dismissed answer remains in Log');
        this._hidePanel();
        this._showLog();
        this._snapshot.messages.push({...this._snapshot.messages[1]});
        this._renderSnapshot();
        qaAssert(!this._answerLabel.visible && this._answerHideSource === 0,
            'A new reply stays hidden outside while Log is open');
        this._hidePanel();
        qaAssert(!this._answerLabel.visible, 'A reply received while Log was open does not pop up after closing');
        this._snapshot.messages.push({...this._snapshot.messages[1]});
        this._renderSnapshot();
        qaAssert(this._answerLabel.visible && this._answerHideSource !== 0,
            'A new reply after Log closes gets its own display time');
        this._snapshot.messages.pop();
        this._snapshot.messages.pop();

        for (const text of [
            'หนึ่ง\nสอง\nสาม\nสี่\nห้า\nหก\nเจ็ด',
            'ภาษาไทยไม่มีช่องว่างเพื่อทดสอบการตัดบรรทัด'.repeat(30),
            'longunbrokentoken'.repeat(50),
            '👩🏽‍💻 hello 🇹🇭 family 👨‍👩‍👧‍👦 '.repeat(30),
        ]) {
            this._snapshot.messages[1].content = text;
            this._renderSnapshot();
            await qaPause(120);
            qaAssert(this._answerLabel.text.startsWith('[Aiko] '), 'Prefix retained for long preview');
            qaAssert(this._answerLabel.clutter_text.get_layout().get_line_count() <= 5, 'Prefix and body share five allocated Pango lines');
            qaAssert(this._snapshot.messages[1].content === text, 'Full answer remains in session');
            this._showLog();
            await qaPause(60);
            qaAssert(qaContainsText(this._logHistory, text), 'Read-only Log retains full answer');
            this._hidePanel();
            qaAssert(!this._answerLabel.visible, 'A long reply seen in Log stays dismissed outside');
        }
        // Show the last long reply again as a new message, outside Log.
        this._snapshot.messages[1].content += ' ';
        this._renderSnapshot();
        await qaPause(120);
        qaAssert(this._answerLabel.visible, 'A new reply outside Log is shown');
        qaAssert(this._answerLabel.height > shortHeight, 'Answer grows to actual content height');
        await this._shot('five-row-plain-answer');
        this._interfaceSettings.set_string('font-name', 'Serif 11');
        this._interfaceSettings.set_double('text-scaling-factor', 1.4);
        await qaPause(250);
        qaAssert(this._answerLabel.get_theme_node().get_font().get_family() === 'Serif', 'Desktop font family applies to plain answers');
        qaAssert(this._answerLabel.clutter_text.get_layout().get_line_count() <= 5, 'Text scaling keeps five rendered lines');
        qaAssert(Math.abs(this._answerLabel.height - this._answerLabel.get_theme_node().get_padding(St.Side.TOP) -
            this._answerLabel.get_theme_node().get_padding(St.Side.BOTTOM) - 2 -
            this._answerLabel.clutter_text.get_layout().get_pixel_size()[1]) <= 1, 'Text height matches actual shaped text');
        this._interfaceSettings.set_string('font-name', 'Sans 11');
        this._interfaceSettings.set_double('text-scaling-factor', 1.0);
        await qaPause(250);

        this._showInput();
        this._overlayEntry.set_text('ส่งด้วย Enter');
        this._overlayEntry.grab_key_focus();
        await this._key(Clutter.KEY_Return);
        qaAssert(calls.filter(call => call.method === 'Submit').length === 1, 'Enter sends exactly once');
        qaAssert(calls.at(-1).args[1] === 'ส่งด้วย Enter', 'Thai Enter payload');
        qaAssert(!this._inputOverlay.visible && !this._ownsFocus(global.stage.get_key_focus()), 'Enter hides input and releases focus after successful submit');
        this._showInput();
        let release;
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            if (method === 'Submit')
                await new Promise(resolve => { release = resolve; });
            return [];
        };
        this._overlayEntry.set_text('pending');
        const pending = this._submit();
        await qaPause(40);
        const before = calls.length;
        await this._submit();
        qaAssert(calls.length === before, 'Repeated send cannot overlap busy request');
        await this._click(this._overlayCancel);
        qaAssert(calls.at(-1).method === 'Cancel', 'Busy Stop control cancels');
        release();
        await pending;
        this._callCore = async () => { throw new Error('QA simulated failure'); };
        this._showInput();
        this._overlayEntry.set_text('คืนข้อความ');
        await this._submit();
        qaAssert(this._overlayEntry.get_text() === 'คืนข้อความ' && this._inputOverlay.visible,
            'Failed submit keeps input visible and restores source draft');
        this._uiError = null;
        const literal = 'สวัสดี <tag> & "quotes"\nบรรทัดที่สอง';
        this._snapshot.messages = [
            {role: 'user', content: literal},
            {role: 'assistant', content: 'คุยใน Log ได้เลยค่ะ <>& 😊'},
            {role: 'tool', content: 'App activation requested.'},
        ];
        this._renderSnapshot();

        await this._click(this._character, Clutter.BUTTON_SECONDARY);
        qaAssert(this._characterMenu.isOpen, 'Native right click opens menu');
        qaAssert(this._answerLabel.visible, 'Right-click menu keeps unexpired floating text visible');
        await qaPause(100);
        const layers = Main.uiGroup.get_children();
        qaAssert(layers.indexOf(this._answerLabel) < layers.indexOf(this._panel) &&
            layers.indexOf(this._answerLabel) < layers.indexOf(this._characterMenu.actor),
        'Floating reply is stacked below Log and the popup menu');
        await this._shot('character-context-menu');
        const items = this._characterMenu._getMenuItems();
        qaAssert(items.length === 5 &&
            items.map(item => item.label?.text).join(',') === 'Log,CharSize: 3,Lang: en,Vim: off,Quit',
            'Character menu shows Log first, Quit last and CharSize, Lang, Vim sorted between');
        qaAssert(this._characterMenu.box.get_theme_node().get_border_radius(St.Corner.TOPLEFT) === 8 &&
            qaColor(this._characterMenu.box.get_theme_node().get_background_color(), '#282c34'), 'Character menu uses the One Half Dark surface');
        const logItem = items.find(item => item.label?.text === 'Log');
        qaAssert(!items.some(item => item.label?.text === 'Theme') && items.some(item => item.label?.text === 'Quit'), 'Quit is reachable and theme selection is gone');
        await this._key(Clutter.KEY_Escape);
        qaAssert(this._answerLabel.visible, 'Closing menu keeps unexpired floating text visible');
        await this._click(this._character, Clutter.BUTTON_SECONDARY);
        await this._click(logItem.actor);
        qaAssert(this._panel.visible && !this._characterMenu.isOpen, 'Log opens only on request');
        qaAssert(this._logComposer.visible && !this._inputOverlay.visible, 'Log owns the active composer');
        await this._checkCaret(this._logEntry);
        await this._checkPanelClose();
        qaAssert(!this._answerLabel.visible, 'Opening Log hides the floating message');
        qaAssert(!this._panelHeader && !this._panelTitle, 'Conversation has no title/header row');
        qaAssert(this._panelClose.visible && this._panel.contains(this._panelClose), 'Close is an overlay inside Log');
        qaAssert(this._panelClose.width === this._panelClose.height &&
            this._panelClose.get_theme_node().get_border_radius(St.Corner.TOPLEFT) >= this._panelClose.width / 2,
        'Close is circular rather than a rounded rectangle');
        const rows = this._logHistory.get_children();
        qaAssert(rows.length === 3 && rows.every(row => row instanceof St.Label), 'Transcript is flat text without message containers');
        qaAssert(rows[0].text === `[Me] ${literal}` && rows[1].text === '[Aiko] คุยใน Log ได้เลยค่ะ <>& 😊', 'Role prefixes and literal contents render inline');
        for (const row of rows) {
            qaAssert(row.get_theme_node().get_background_color().alpha === 0 &&
                row.get_theme_node().get_padding(St.Side.LEFT) === 6 &&
                row.get_theme_node().get_padding(St.Side.TOP) === 4,
            'Transcript stays transparent with 6 px horizontal and 4 px vertical selection padding');
            qaAssert(row.clutter_text.get_line_alignment() === Pango.Alignment.LEFT, 'All text is left aligned');
            qaAssert(qaColor(row.get_theme_node().get_foreground_color(), '#dcdfe4'), 'Message bodies share the One Half Dark foreground');
        }
        const meColor = qaTextColorAt(rows[0], 1);
        const aikoColor = qaTextColorAt(rows[1], 1);
        const bodyColor = qaTextColorAt(rows[0], 5);
        qaAssert(meColor && aikoColor && meColor !== aikoColor, 'Participants have distinct rendered prefix colors');
        qaAssert(bodyColor === qaTextColorAt(rows[1], 7), 'Rendered message bodies share one color');
        qaAssert(meColor !== bodyColor && aikoColor !== bodyColor, 'Only prefixes carry participant-specific colors');
        await this._checkMessageCopy(rows[1]);
        this._overlayEntry.set_text('compact draft retained');
        await this._click(this._character);
        qaAssert(!this._inputOverlay.visible && this._logEntry.contains(global.stage.get_key_focus()), 'Character click routes to Log while open');
        this._present();
        qaAssert(!this._inputOverlay.visible && this._logEntry.contains(global.stage.get_key_focus()), 'Present cannot open compact input while Log is open');
        await this._click(this._logEntry, Clutter.BUTTON_SECONDARY);
        qaAssert(this._logEntry.menu.isOpen && this._panel.visible, 'Log text-edit menu remains usable');
        qaAssert(this._logEntry.menu.actor.has_style_class_name('zaiko-context') &&
            qaColor(this._logEntry.menu.box.get_theme_node().get_background_color(), '#282c34') &&
            this._logEntry.menu.box.get_theme_node().get_border_radius(St.Corner.TOPLEFT) === 8 &&
            !qaContainsText(this._logEntry.menu.box, 'Ctrl+C') && !qaContainsText(this._logEntry.menu.box, 'Ctrl+V'),
        'Log Copy/Paste uses the Log/Quit menu style without added shortcut labels');
        await this._checkMenuHover(this._logEntry.menu, this._logComposer);
        await this._key(Clutter.KEY_Escape);

        await this._checkFocusDismiss(rows[1]);
        await this._checkMultilineInput();
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            return [];
        };
        const submitCount = calls.filter(call => call.method === 'Submit').length;
        this._logEntry.set_text('ส่งจาก Log ด้วย Enter');
        this._logEntry.grab_key_focus();
        await this._key(Clutter.KEY_Return);
        qaAssert(calls.filter(call => call.method === 'Submit').length === submitCount + 1 && calls.at(-1).args[1] === 'ส่งจาก Log ด้วย Enter', 'Log Enter sends exactly once');
        qaAssert(this._panel.visible && this._logEntry.get_text() === '' && !this._inputOverlay.visible, 'Log stays open after sending');
        qaAssert(this._logEntry.contains(global.stage.get_key_focus()), 'Log input remains focused for continued conversation');
        qaAssert(this._overlayEntry.get_text() === 'compact draft retained', 'Log sends preserve compact draft');

        let releaseLog;
        this._callCore = async (method, parameters) => {
            calls.push({method, args: parameters?.deep_unpack()});
            if (method === 'Submit')
                await new Promise(resolve => { releaseLog = resolve; });
            return [];
        };
        this._logEntry.set_text('pending in Log');
        const pendingLog = this._submit(this._logEntry);
        await qaPause(40);
        const busyCount = calls.length;
        await this._submit(this._overlayEntry);
        await this._submit(this._logEntry);
        qaAssert(calls.length === busyCount && this._logStatus.visible, 'Both composers share the busy guard with in-Log status');
        qaAssert(this._logCancel.visible && this._logCancel.label === 'Stop', 'Busy Log exposes a text Stop control');
        await this._click(this._logCancel);
        qaAssert(calls.at(-1).method === 'Cancel', 'Log busy button cancels');
        releaseLog();
        await pendingLog;
        this._callCore = async () => { throw new Error('QA failed Log submission'); };
        this._logEntry.set_text('restore Log draft');
        await this._submit(this._logEntry);
        qaAssert(this._logEntry.get_text() === 'restore Log draft' && this._panel.visible && this._logStatus.visible, 'Failed Log send restores only its draft and shows error');
        qaAssert(this._overlayEntry.get_text() === 'compact draft retained', 'Log failure leaves compact draft unchanged');
        this._uiError = null;
        this._renderSnapshot();
        this._logEntry.set_text('style keeps this draft');
        this._interfaceSettings.set_string('font-name', 'Serif 11');
        await qaPause(100);
        qaAssert(qaTextColorAt(this._logHistory.get_child_at_index(1), 1) === aikoColor, 'Fixed prefix color survives desktop font changes');
        qaAssert(this._logEntry.get_text() === 'style keeps this draft' && qaContainsText(this._logHistory, literal), 'Font updates preserve draft and literal message');
        this._interfaceSettings.set_string('font-name', 'Sans 11');
        const originalMessages = this._snapshot.messages;
        this._snapshot.messages = Array.from({length: 30}, (_, index) => ({
            role: index % 2 ? 'assistant' : 'user',
            content: `ข้อความแชตลำดับ ${index + 1} · scroll preview`,
        })).concat(originalMessages);
        this._renderSnapshot();
        await qaPause(160);
        const scroll = this._logScroll.get_vadjustment();
        qaAssert(scroll.upper > scroll.page_size, 'Long conversation remains scrollable without a header row');
        const beforeScroll = scroll.value;
        const [scrollX, scrollY] = this._logScroll.get_transformed_position();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), scrollX + 100, scrollY + 100);
        await qaPause(40);
        this._pointer.notify_discrete_scroll(GLib.get_monotonic_time(), Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL);
        await qaPause(250);
        qaAssert(scroll.value < beforeScroll, 'Native wheel scrolls the transcript');
        const thumb = qaFindActor(this._logScroll,
            actor => actor.get_style_class_name?.()?.split(' ').includes('vhandle'));
        const barDetails = this._logScroll.get_children().filter(actor => actor instanceof St.ScrollBar)
            .map(bar => ({actor: bar.toString(), width: bar.width,
                children: bar.get_children().map(child => ({actor: child.toString(),
                    width: child.width, name: child.get_name(), style: child.get_style_class_name?.()}))}));
        qaAssert(thumb && thumb.width <= 6 && thumb.get_theme_node().get_border_width(St.Side.LEFT) === 0,
            `Scrollbar thumb should be slim: ${JSON.stringify({thumb: thumb?.toString(), width: thumb?.width,
                border: thumb?.get_theme_node().get_border_width(St.Side.LEFT), bars: barDetails})}`);
        qaAssert(qaColor(thumb.get_theme_node().get_background_color(), '#5c6370'),
            'Scrollbar thumb uses the muted One Half Dark neutral');
        outside.hide();
        await this._shot('chat-scroll');
        this._snapshot.messages = originalMessages;
        this._renderSnapshot();
        await qaPause(100);
        await this._shot('log-chat');
        outside.show();
        await this._click(this._panelClose);
        qaAssert(!this._panel.visible && !this._panelClose.visible, 'Inset close dismisses panel and itself');
        qaAssert(!this._answerLabel.visible, 'Closing Log does not bring back a reply already seen in Log');
        await this._click(this._character);
        qaAssert(this._inputOverlay.visible && this._overlayEntry.get_text() === 'compact draft retained', 'Closing Log re-enables compact input with its draft');
        this._showLog();
        qaAssert(this._logEntry.get_text() === 'style keeps this draft' && !this._inputOverlay.visible, 'Reopened Log restores its distinct draft');
        // Move the pointer off the send icon so hover color does not affect palette checks.
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        this._showInput();
        const surface = this._inputOverlay.get_theme_node().get_background_color();
        qaAssert(qaColor(surface, '#3e4451') && surface.alpha >= 242 && surface.alpha <= 243, 'Compact input uses the same gray composer surface as Log');
        qaAssert(!this._overlayCancel.visible && !this._overlayEntry.hint_text &&
            this._inputOverlay.get_theme_node().get_border_width(St.Side.LEFT) === 0,
        'Compact input has no placeholder, send control or focus border');
        qaAssert(qaColor(this._answerLabel.get_theme_node().get_background_color(), '#282c34'), 'Reply keeps its dark bubble');
        const panelSurface = this._panel.get_theme_node().get_background_color();
        qaAssert(qaColor(panelSurface, '#282c34') && panelSurface.alpha >= 229 && panelSurface.alpha <= 230, 'Conversation keeps its One Half Dark surface');
        this._snapshot.state = 'thinking';
        this._snapshot.request_id = 'qa-thinking-clock';
        this._renderSnapshot();
        qaAssert(!this._answerLabel.visible && this._logStatus.visible,
            'Thinking status appears only in Log while it is open');
        await qaPause(1150);
        qaAssert(/^\[Aiko\] Thinking\.\.\. \([12]s\)$/.test(this._logStatus.text), 'Thinking clock advances from real elapsed seconds');
        qaAssert(this._thinkingSource !== 0 && this._answerHideSource === 0, 'Active thinking keeps its ticker without message expiry');
        const thinkingSource = this._thinkingSource;
        this._thinkingStartedUs = GLib.get_monotonic_time() - 7290 * 1_000_000;
        this._renderSnapshot();
        qaAssert(this._logStatus.text === '[Aiko] Thinking... (2h 1m 30s)', 'Long elapsed time includes actual hour/minute/second units');
        qaAssert(this._thinkingSource === thinkingSource, 'Snapshot repaint does not restart thinking clock');
        this._hidePanel();
        qaAssert(this._answerLabel.text === '[Aiko] Thinking... (2h 1m 30s)' && this._answerLabel.visible, 'Floating thinking uses the same elapsed time');
        this._showLog();
        qaAssert(!this._answerLabel.visible, 'Reopening Log hides the floating thinking status');
        await this._shot('thinking-clock');
        this._snapshot.state = 'idle';
        this._snapshot.request_id = null;
        this._renderSnapshot();
        qaAssert(this._thinkingSource === 0 && this._thinkingStartedUs === 0, 'Thinking clock stops when request finishes');
        this._showLog();
        const [panelX, panelY] = this._panel.get_transformed_position();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), panelX + 20, panelY + 60);
        await qaPause(60);
        this._panelClose.grab_key_focus();
        await this._key(Clutter.KEY_Escape);
        qaAssert(!this._panel.visible && !this._panelClose.visible, 'Inset close also supports Escape');
        this._hidePanel();
        this._hideInput();
        await this._checkCommandMenus();
        await this._checkVimInputs();
        await this._checkLanguage();
        await this._checkCharacterSize();
        await this._checkMotion();
        const startX = this._character.x;
        const startY = this._character.y;
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX + 100, startY + 100);
        await qaPause(40);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await qaPause(40);
        for (let step = 1; step <= 5; step++) {
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), startX + 100 - step * 12, startY + 100 - step * 8);
            await qaPause(35);
        }
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await qaPause(150);
        qaAssert(this._character.x < startX && !this._inputOpen, 'Drag does not open hidden input');
        await this._checkFastCharacterDrag();
        await this._checkCharacterMenuPosition();
        // Earlier Log checks dismissed the floating reply; show a fresh one.
        this._hidePanel();
        this._snapshot.messages = [...this._snapshot.messages, {role: 'assistant', content: 'Top edge reply'}];
        this._renderSnapshot();
        qaAssert(this._answerLabel.visible, 'A fresh reply is visible for edge layout checks');
        this._positionCharacter(-999, -999);
        await qaPause(120);
        qaAssert(this._answerLabel.y + this._answerLabel.height <= this._character.y, 'Top edge preserves answer above head');
        const workArea = this._workArea;
        this._workArea = () => ({x: 0, y: 32, width: 680, height: 480});
        this._layout();
        this._positionCharacter(450, 300);
        await qaPause(160);
        for (const actor of [this._panel, this._panelClose, this._character, this._inputOverlay, this._answerLabel]) {
            // Hidden actors may retain their old allocation transform. Close now
            // uses panel-local coordinates; compare the requested positions.
            const x = actor.x + (actor === this._panelClose ? this._panel.x : 0);
            const y = actor.y + (actor === this._panelClose ? this._panel.y : 0);
            qaAssert(x >= 8 && x + actor.width <= 672, 'Narrow horizontal bounds');
            qaAssert(y >= 40 && y + actor.height <= 504, 'Narrow vertical bounds');
        }
        this._workArea = workArea;
        this._layout();
        this._answerLabel.clutter_text.grab_key_focus();
        this._overviewShowing = true;
        this._updateVisibility();
        qaAssert(!this._character.visible && !this._panel.visible && !this._inputOverlay.visible && !this._answerLabel.visible, 'Overview hides all surfaces');
        qaAssert(!this._ownsFocus(global.stage.get_key_focus()), 'Overview releases answer focus');
        this._overviewShowing = false;
        this._updateVisibility();
        this._openCharacterMenu();
        await qaPause(80);
        this._overviewShowing = true;
        this._updateVisibility();
        qaAssert(!this._characterMenu.isOpen, 'Overview closes menu/grab');
        this._overviewShowing = false;
        this._updateVisibility();
        this._openCharacterMenu();
        let rejectSubmission;
        this._callCore = () => new Promise((_resolve, reject) => { rejectSubmission = reject; });
        this._showLog();
        this._logEntry.set_text('คืนข้อความเมื่อ core หลุด');
        const disconnectedSubmit = this._submit(this._logEntry);
        this._snapshot.state = 'thinking';
        this._snapshot.request_id = 'qa-disconnect-thinking';
        this._renderSnapshot();
        this._openCharacterMenu();
        await qaPause(40);
        this._coreVanished();
        rejectSubmission(new Error('QA disconnected during Submit'));
        await disconnectedSubmit;
        qaAssert(this._logEntry.get_text() === 'คืนข้อความเมื่อ core หลุด', 'Core disconnect restores originating Log draft');
        qaAssert(this._overlayEntry.get_text() === 'compact draft retained', 'Core disconnect preserves other composer draft');
        qaAssert(this._thinkingSource === 0, 'Core loss cancels thinking ticker');
        qaAssert(!this._character.visible && !this._panel.visible && !this._inputOverlay.visible && !this._answerLabel.visible, 'Core loss hides all surfaces');
        qaAssert(!this._characterMenu.isOpen && !this._ownsFocus(global.stage.get_key_focus()), 'Core loss releases menu and focus');

        const stageSignals = this._signals.filter(([object]) => object === global.stage).map(([, id]) => id);
        qaAssert(stageSignals.length > 0, 'Outside-click handler registered');
        const actors = [this._panel, this._panelClose, this._character, this._inputOverlay, this._answerLabel,
            ...this._commandMenus.map(menu => menu.actor),
            this._characterMenu.actor, this._characterMenuAnchor,
            ...this._logMessageMenus().map(menu => menu.actor)];
        this._coreOwner = 'qa-only-no-provider';
        this._showLog();
        const carets = this._caretBlinks.slice();
        qaAssert(carets.some(caret => caret._source !== 0), 'Focused entry has an active blink timer before disable');
        const [logX, logY] = this._panel.get_transformed_position();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), logX + 20, logY + 60);
        await qaPause(60);
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        await qaPause(60);
        qaAssert(!this._panelClose.visible, 'Close is already hidden on leaving Log');
        let destroyedActors = 0;
        for (const actor of actors)
            actor.connect('destroy', () => { destroyedActors++; });
        this._toggleVim();
        const grabBeforeDisable = global.stage.get_grab_actor();
        this._toggleLanguage();
        const [characterX, characterY] = this._character.get_transformed_position();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), characterX + 100, characterY + 130);
        await qaPause(30);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await qaPause(30);
        this.disable();
        qaAssert(!this._characterGrab && !this._dragOrigin && global.stage.get_grab_actor() === grabBeforeDisable,
            'Disable releases an active character grab');
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        qaAssert(destroyedActors === actors.length, 'Disable destroys actors/menu');
        qaAssert(stageSignals.every(id => !GObject.signal_handler_is_connected(global.stage, id)), 'Disable disconnects outside-click handler');
        qaAssert(this._answerHideSource === 0, 'Disable cancels answer expiry timer');
        qaAssert(carets.every(caret => caret._source === 0 && caret._signals.length === 0), 'Disable cancels caret timers and disconnects their signals');
        await this._click(outside);
        qaAssert(outsideClicks === 2, 'Outside target works after disable');
        ZaikoExtension.prototype.enable.call(this);
        await qaPause(150);
        qaAssert(this._vimEnabled && this._vimMenuItem.label.text === 'Vim: เปิด' &&
            this._language === 'th' && this._langMenuItem.label.text === 'ภาษา: th',
            'Re-enabling restores both language and Vim preferences');
        this.disable();
        outside.destroy();
        this._pointer = null;
        this._keyboard = null;
        this._qaResult({ok: true, checked: 'flat left transcript/prefix-only colors/literal text, Log chat and exclusive input, full composer interior click focus/native caret placement, inset close overlay/no reserved row/hover/immediate hide, Enter/icon/cancel/failure/drafts, native caret blinking/focus/settings/timeout/cleanup, command picker/eight rows/arrows/mouse wheel/filtering/Tab/Enter/click/Escape/Vim, One Half Dark surfaces/no theme chooser, floating replies dismissed by Log, status hidden during Log, lifecycle'});
    }
}
