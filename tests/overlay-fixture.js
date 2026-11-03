// Appended only to a temporary copy by overlay-shell.py; no real core/provider.
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

    async _checkCaret(entry, button) {
        const settings = this._interfaceSettings;
        const text = entry.clutter_text;
        // These settings belong only to the private QA session.
        settings.set_int('cursor-blink-time', 200);
        settings.set_int('cursor-blink-timeout', 1);
        settings.set_boolean('cursor-blink', true);
        entry.grab_key_focus();
        entry.set_text('');
        qaAssert(text.has_key_focus(), 'Entry owns text focus');
        qaAssert(entry.get_parent().has_style_pseudo_class('focus'), 'Input focus highlights the outer composer');
        qaAssert(entry.get_theme_node().get_background_color().alpha === 0 &&
            entry.get_theme_node().get_border_width(St.Side.LEFT) === 0 &&
            button.get_theme_node().get_border_width(St.Side.LEFT) === 0,
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
        button.grab_key_focus();
        qaAssert(entry.get_parent().has_style_pseudo_class('focus'), 'Send button focus keeps the shared composer highlight');
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
        qaAssert(!this._inputOverlay.visible && !this._panel.visible, 'No input or support panel auto-opens on core connection');
        qaAssert(!this._chat && !this._entry && !this._composer && !this._answerBubble, 'Legacy UI/composer/card actors removed');
        qaAssert(!this._answerLabel.visible, 'No empty answer placeholder');
        this._present();
        await qaPause(150);
        qaAssert(this._inputOverlay.visible && !this._panel.visible, 'Present opens only input');
        qaAssert(this._inputOverlay.y + this._inputOverlay.height <= this._character.y + this._character.height + 1,
            'Input overlays the bottom of character');
        await this._checkCaret(this._overlayEntry, this._overlaySend);

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
        qaAssert(!entryMenu.actor.has_style_class_name('zaiko-context') &&
            !qaContainsText(entryMenu.box, 'Ctrl+C') && !qaContainsText(entryMenu.box, 'Ctrl+V'), 'Native edit menu has no custom styling or added shortcut labels');
        const editItems = entryMenu._getMenuItems();
        qaAssert(!editItems[0].reactive && editItems[1].reactive, 'Native Copy/Paste sensitivity is preserved');
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
        await this._click(outside);
        qaAssert(!this._inputOverlay.visible && outsideClicks === 1, 'Outside click hides input and activates its target once');
        qaAssert(global.stage.get_key_focus() === outside, 'Outside click retains target focus');
        qaAssert(!this._overlayEntry.clutter_text.get_cursor_visible(), 'Hidden compact input has no active caret');
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
        qaAssert(this._answerLabel.get_theme_node().get_background_color().alpha === 0, 'Answer has no background');
        for (const side of [St.Side.TOP, St.Side.RIGHT, St.Side.BOTTOM, St.Side.LEFT])
            qaAssert(this._answerLabel.get_theme_node().get_padding(side) === 0, 'Answer reserves no bubble padding');
        qaAssert(this._answerLabel.y + this._answerLabel.height <= this._character.y, 'Answer above character');
        outside.hide();
        await this._shot('plain-answer-input');
        outside.show();

        const answerTimer = this._answerHideSource;
        await qaPause(6000);
        this._renderSnapshot();
        this._showInput();
        GLib.file_set_contents(`${GLib.get_user_config_dir()}/zaiko/ui.json`, '{"theme":"forest","syncZhyprbola":true}');
        GLib.file_set_contents(`${GLib.get_user_config_dir()}/zhyprbola/theme`, 'forest');
        qaAssert(this._answerHideSource === answerTimer, 'Unchanged message is not prolonged by repaint/input/ignored legacy preference changes');
        this._answerLabel.clutter_text.grab_key_focus();
        await qaPause(6200);
        qaAssert(!this._answerLabel.visible && this._answerHideSource === 0, 'Message expires after twelve seconds');
        qaAssert(!this._ownsFocus(global.stage.get_key_focus(), [this._answerLabel]), 'Expiry releases selected text focus');
        this._renderSnapshot();
        qaAssert(!this._answerLabel.visible, 'Repaint does not resurrect expired text');
        this._showLog();
        qaAssert(qaContainsText(this._logHistory, this._snapshot.messages[1].content), 'Expired answer remains in Log');
        this._hidePanel();
        qaAssert(!this._answerLabel.visible, 'Closing Log does not resurrect an expired answer');
        this._snapshot.messages.push({...this._snapshot.messages[1]});
        this._renderSnapshot();
        qaAssert(this._answerLabel.visible && this._answerHideSource !== 0, 'A new identical reply gets its own display time');
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
        }
        qaAssert(this._answerLabel.height > shortHeight, 'Answer grows to actual content height');
        await this._shot('five-row-plain-answer');
        this._interfaceSettings.set_string('font-name', 'Serif 11');
        this._interfaceSettings.set_double('text-scaling-factor', 1.4);
        await qaPause(250);
        qaAssert(this._answerLabel.get_theme_node().get_font().get_family() === 'Serif', 'Desktop font family applies to plain answers');
        qaAssert(this._answerLabel.clutter_text.get_layout().get_line_count() <= 5, 'Text scaling keeps five rendered lines');
        qaAssert(Math.abs(this._answerLabel.height - this._answerLabel.clutter_text.get_layout().get_pixel_size()[1]) <= 1, 'Text height matches actual shaped text');
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
        await this._click(this._character);
        this._overlayEntry.set_text('ส่งด้วย icon');
        await this._click(this._overlaySend);
        qaAssert(calls.filter(call => call.method === 'Submit').length === 2 && !this._inputOverlay.visible, 'Embedded icon sends once and hides input');
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
        await this._click(this._overlaySend);
        qaAssert(calls.at(-1).method === 'Cancel', 'Busy icon cancels');
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
        qaAssert(!this._answerLabel.visible, 'Floating text does not show through the translucent menu');
        await qaPause(100);
        await this._shot('character-context-menu');
        const items = this._characterMenu._getMenuItems();
        qaAssert(items.length === 2 && items.map(item => item.label?.text).join(',') === 'Log,Quit', 'Character menu has Log and Quit only, without a chooser or separator');
        qaAssert(this._characterMenu.box.get_theme_node().get_border_radius(St.Corner.TOPLEFT) === 8 &&
            qaColor(this._characterMenu.box.get_theme_node().get_background_color(), '#282c34'), 'Character menu uses the One Half Dark surface');
        const logItem = items.find(item => item.label?.text === 'Log');
        qaAssert(!items.some(item => item.label?.text === 'Theme') && items.some(item => item.label?.text === 'Quit'), 'Quit is reachable and theme selection is gone');
        await this._key(Clutter.KEY_Escape);
        qaAssert(this._answerLabel.visible, 'Closing menu restores unexpired floating text');
        await this._click(this._character, Clutter.BUTTON_SECONDARY);
        await this._click(logItem.actor);
        qaAssert(this._panel.visible && !this._characterMenu.isOpen, 'Log opens only on request');
        qaAssert(this._logComposer.visible && !this._inputOverlay.visible, 'Log owns the active composer');
        await this._checkCaret(this._logEntry, this._logSend);
        await this._checkPanelClose();
        qaAssert(!this._answerLabel.visible, 'Floating message does not overlap Log');
        qaAssert(!this._panelHeader && !this._panelTitle, 'Conversation has no title/header row');
        qaAssert(this._panelClose.visible && this._panel.contains(this._panelClose), 'Close is an overlay inside Log');
        qaAssert(this._panelClose.width === this._panelClose.height &&
            this._panelClose.get_theme_node().get_border_radius(St.Corner.TOPLEFT) >= this._panelClose.width / 2,
        'Close is circular rather than a rounded rectangle');
        const rows = this._logHistory.get_children();
        qaAssert(rows.length === 3 && rows.every(row => row instanceof St.Label), 'Transcript is flat text without message containers');
        qaAssert(rows[0].text === `[Me] ${literal}` && rows[1].text === '[Aiko] คุยใน Log ได้เลยค่ะ <>& 😊', 'Role prefixes and literal contents render inline');
        for (const row of rows) {
            qaAssert(row.get_theme_node().get_background_color().alpha === 0 && row.get_theme_node().get_padding(St.Side.LEFT) === 0, 'Transcript has no bubble background or padding');
            qaAssert(row.clutter_text.get_line_alignment() === Pango.Alignment.LEFT, 'All text is left aligned');
            qaAssert(qaColor(row.get_theme_node().get_foreground_color(), '#dcdfe4'), 'Message bodies share the One Half Dark foreground');
        }
        const meColor = qaTextColorAt(rows[0], 1);
        const aikoColor = qaTextColorAt(rows[1], 1);
        const bodyColor = qaTextColorAt(rows[0], 5);
        qaAssert(meColor && aikoColor && meColor !== aikoColor, 'Participants have distinct rendered prefix colors');
        qaAssert(bodyColor === qaTextColorAt(rows[1], 7), 'Rendered message bodies share one color');
        qaAssert(meColor !== bodyColor && aikoColor !== bodyColor, 'Only prefixes carry participant-specific colors');
        this._overlayEntry.set_text('compact draft retained');
        await this._click(this._character);
        qaAssert(!this._inputOverlay.visible && this._logEntry.contains(global.stage.get_key_focus()), 'Character click routes to Log while open');
        this._present();
        qaAssert(!this._inputOverlay.visible && this._logEntry.contains(global.stage.get_key_focus()), 'Present cannot open compact input while Log is open');
        await this._click(this._logEntry, Clutter.BUTTON_SECONDARY);
        qaAssert(this._logEntry.menu.isOpen && this._panel.visible, 'Log text-edit menu remains usable');
        qaAssert(!this._logEntry.menu.actor.has_style_class_name('zaiko-context') &&
            !qaContainsText(this._logEntry.menu.box, 'Ctrl+C') && !qaContainsText(this._logEntry.menu.box, 'Ctrl+V'), 'Log edit menu remains native without added shortcut labels');
        await this._key(Clutter.KEY_Escape);

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
        this._logEntry.set_text('ส่งจาก Log ด้วย icon');
        await this._click(this._logSend);
        qaAssert(calls.filter(call => call.method === 'Submit').length === submitCount + 2 && this._panel.visible, 'Log icon sends and preserves the conversation box');
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
        await this._click(this._logSend);
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
        qaAssert(this._answerLabel.visible, 'Closing Log restores an answer still within its display time');
        await this._click(this._character);
        qaAssert(this._inputOverlay.visible && this._overlayEntry.get_text() === 'compact draft retained', 'Closing Log re-enables compact input with its draft');
        this._showLog();
        qaAssert(this._logEntry.get_text() === 'style keeps this draft' && !this._inputOverlay.visible, 'Reopened Log restores its distinct draft');
        // Move the pointer off the send icon so hover color does not affect palette checks.
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        this._showInput();
        const surface = this._inputOverlay.get_theme_node().get_background_color();
        qaAssert(qaColor(surface, '#282c34') && surface.alpha >= 229 && surface.alpha <= 230, 'Compact input uses the 90% One Half Dark surface');
        qaAssert(this._overlaySend.get_theme_node().get_background_color().alpha === 0, 'Send icon shares the input surface');
        qaAssert(this._answerLabel.get_theme_node().get_background_color().alpha === 0, 'Reply remains transparent');
        const panelSurface = this._panel.get_theme_node().get_background_color();
        qaAssert(qaColor(panelSurface, '#282c34') && panelSurface.alpha === surface.alpha, 'Conversation uses the same One Half Dark surface as input');
        this._snapshot.state = 'thinking';
        this._snapshot.request_id = 'qa-thinking-clock';
        this._renderSnapshot();
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
        const actors = [this._panel, this._panelClose, this._character, this._inputOverlay, this._answerLabel, this._characterMenu.actor];
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
        this.disable();
        qaAssert(destroyedActors === actors.length, 'Disable destroys actors/menu');
        qaAssert(stageSignals.every(id => !GObject.signal_handler_is_connected(global.stage, id)), 'Disable disconnects outside-click handler');
        qaAssert(this._answerHideSource === 0, 'Disable cancels answer expiry timer');
        qaAssert(carets.every(caret => caret._source === 0 && caret._signals.length === 0), 'Disable cancels caret timers and disconnects their signals');
        await this._click(outside);
        qaAssert(outsideClicks === 2, 'Outside target works after disable');
        ZaikoExtension.prototype.enable.call(this);
        await qaPause(150);
        this.disable();
        outside.destroy();
        this._pointer = null;
        this._keyboard = null;
        this._qaResult({ok: true, checked: 'flat left transcript/prefix-only colors/literal text, Log chat and exclusive input, inset close overlay/no reserved row/hover/immediate hide, Enter/icon/cancel/failure/drafts, native caret blinking/focus/settings/timeout/cleanup, One Half Dark surfaces/no theme chooser, 12-second messages and lifecycle'});
    }
}
