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

    async _runQA() {
        const {default: GObject} = await import('gi://GObject');
        if (this._coreWatch)
            Gio.bus_unwatch_name(this._coreWatch);
        this._coreWatch = 0;
        this._coreOwner = 'qa-only-no-provider';
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

        await this._click(this._character);
        qaAssert(this._inputOverlay.visible, 'Repeated character click keeps input open');
        await this._click(this._character);
        qaAssert(this._inputOverlay.visible, 'Character click is idempotent');
        this._overlayEntry.set_text('draft kept outside');
        await this._click(this._overlayEntry);
        qaAssert(this._inputOverlay.visible, 'Entry click does not dismiss input');
        await this._click(this._overlayEntry, Clutter.BUTTON_SECONDARY);
        qaAssert(this._overlayEntry.menu.isOpen && this._inputOverlay.visible, 'Entry context menu does not dismiss input');
        await this._key(Clutter.KEY_Escape);
        qaAssert(this._inputOverlay.visible, 'Closing entry menu keeps input visible');

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
        this._themeSettings.setTheme('forest');
        qaAssert(this._answerHideSource === answerTimer, 'Unchanged message is not prolonged by repaint/input/theme changes');
        this._answerLabel.clutter_text.grab_key_focus();
        await qaPause(6200);
        qaAssert(!this._answerLabel.visible && this._answerHideSource === 0, 'Message expires after twelve seconds');
        qaAssert(!this._ownsFocus(global.stage.get_key_focus(), [this._answerLabel]), 'Expiry releases selected text focus');
        this._renderSnapshot();
        qaAssert(!this._answerLabel.visible, 'Repaint does not resurrect expired text');
        this._showLog();
        qaAssert(qaContainsText(this._logHistory, this._snapshot.messages[1].content), 'Expired answer remains in Log');
        this._hidePanel();
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
        this._renderSnapshot();

        await this._click(this._character, Clutter.BUTTON_SECONDARY);
        qaAssert(this._characterMenu.isOpen, 'Native right click opens menu');
        const items = this._characterMenu._getMenuItems();
        const logItem = items.find(item => item.label?.text === 'Log');
        qaAssert(items.some(item => item.label?.text === 'Theme') && items.some(item => item.label?.text === 'Quit'), 'Theme and Quit remain reachable');
        await this._click(logItem.actor);
        qaAssert(this._panel.visible && this._panelMode === 'log' && !this._characterMenu.isOpen, 'Log opens only on request');
        qaAssert(!this._panel.get_children().some(child => child instanceof St.Entry), 'Log has no legacy composer');
        await this._shot('read-only-log');
        this._showAppearance();
        // Move the pointer off the send icon so hover color does not affect palette checks.
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 100, 80);
        this._showInput();
        for (const theme of THEMES) {
            this._themeSettings.setTheme(theme.id);
            await qaPause(70);
            const surface = this._inputOverlay.get_theme_node().get_background_color();
            qaAssert(qaColor(surface, theme.accent) && surface.alpha > 0 && surface.alpha < 128,
                `Translucent input follows palette ${theme.id}`);
            qaAssert(this._overlaySend.get_theme_node().get_background_color().alpha === 0, 'Send has no solid fill');
            qaAssert(this._answerLabel.get_theme_node().get_background_color().alpha === 0, 'All themes keep reply transparent');
        }
        this._hidePanel();
        const ext = `${GLib.get_user_config_dir()}/zhyprbola`;
        GLib.mkdir_with_parents(ext, 0o700);
        GLib.file_set_contents(`${ext}/theme`, 'forest');
        this._themeSettings.setSync(true);
        await qaPause(150);
        qaAssert(qaColor(this._inputOverlay.get_theme_node().get_background_color(), '#477F6D'), 'Live sync applies');
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
        for (const actor of [this._panel, this._character, this._inputOverlay, this._answerLabel]) {
            qaAssert(actor.x >= 8 && actor.x + actor.width <= 672, 'Narrow horizontal bounds');
            qaAssert(actor.y >= 40 && actor.y + actor.height <= 504, 'Narrow vertical bounds');
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
        this._overlayEntry.set_text('คืนข้อความเมื่อ core หลุด');
        const disconnectedSubmit = this._submit();
        await qaPause(40);
        this._coreVanished();
        rejectSubmission(new Error('QA disconnected during Submit'));
        await disconnectedSubmit;
        qaAssert(this._overlayEntry.get_text() === 'คืนข้อความเมื่อ core หลุด', 'Core disconnect restores originating draft');
        qaAssert(!this._character.visible && !this._panel.visible && !this._inputOverlay.visible && !this._answerLabel.visible, 'Core loss hides all surfaces');
        qaAssert(!this._characterMenu.isOpen && !this._ownsFocus(global.stage.get_key_focus()), 'Core loss releases menu and focus');

        const stageSignals = this._signals.filter(([object]) => object === global.stage).map(([, id]) => id);
        qaAssert(stageSignals.length > 0, 'Outside-click handler registered');
        const actors = [this._panel, this._character, this._inputOverlay, this._answerLabel, this._characterMenu.actor];
        let destroyedActors = 0;
        for (const actor of actors)
            actor.connect('destroy', () => { destroyedActors++; });
        const paletteDirectory = this._paletteDirectory;
        this.disable();
        qaAssert(destroyedActors === actors.length, 'Disable destroys actors/menu');
        qaAssert(stageSignals.every(id => !GObject.signal_handler_is_connected(global.stage, id)), 'Disable disconnects outside-click handler');
        qaAssert(this._answerHideSource === 0, 'Disable cancels answer expiry timer');
        qaAssert(!GLib.file_test(paletteDirectory, GLib.FileTest.EXISTS), 'Disable removes palettes');
        await this._click(outside);
        qaAssert(outsideClicks === 2, 'Outside target works after disable');
        ZaikoExtension.prototype.enable.call(this);
        await qaPause(150);
        this.disable();
        outside.destroy();
        this._pointer = null;
        this._keyboard = null;
        this._qaResult({ok: true, checked: 'no legacy UI, idempotent input/outside-click propagation, context menus, plain Aiko text/five rows/font scale, Enter/send/cancel/draft, Log/Theme, palettes/sync and lifecycle'});
    }
}
