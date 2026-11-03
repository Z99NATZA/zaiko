import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    APP_IDS, CORE_BUS, CORE_PATH, DESKTOP_BUS, DESKTOP_PATH, DESKTOP_XML,
    panelPosition, clampPosition, compactPosition, expressionFor, isBusy, latestAssistant, parseEvent, parseSnapshot,
    transcriptLine, formatElapsed,
} from './protocol.js';
import {EXPRESSIONS, imageGeometry} from './assets/manifest.js';
import {answerPreview} from './answerPreview.js';
import {CaretBlink} from './caret.js';
import {VimInput} from './vimInput.js';

const CHARACTER_WIDTH = 200;
const CHARACTER_HEIGHT = 260;
const EMPTY_SNAPSHOT = {messages: [], state: 'idle', request_id: null, error: null};

const VimMenuItem = GObject.registerClass(class VimMenuItem extends PopupMenu.PopupMenuItem {
    _init(label, toggle) {
        super._init(label);
        this._toggle = toggle;
    }

    activate() {
        // This preference toggles in place; Log and Quit keep normal activation.
        this._toggle();
    }
});

export default class ZaikoExtension extends Extension {
    enable() {
        this._enabled = true;
        this._epoch = 0;
        this._coreOwner = null;
        this._snapshot = {...EMPTY_SNAPSHOT};
        this._panelOpen = false;
        this._inputOpen = false;
        this._answerHasText = false;
        this._answerDisplayKey = null;
        this._answerExpired = false;
        this._answerHideSource = 0;
        this._thinkingStartedUs = 0;
        this._thinkingRequestId = null;
        this._thinkingSource = 0;
        this._focusDismissSource = 0;
        this._selectionDrag = null;
        this._dragOrigin = null;
        this._characterGrab = null;
        this._characterGrabSignal = 0;
        this._sending = false;
        this._cancelling = false;
        this._snapshotRunning = false;
        this._snapshotDirty = false;
        this._signals = [];
        this._caretBlinks = [];
        this._vimInputs = [];
        this._vimEnabled = this._loadVimEnabled();
        this._eventSubscription = 0;
        this._scrollSource = 0;
        this._uiError = null;
        this._snapshotError = null;
        this._historySignature = null;
        this._sessionCancellable = null;
        this._overviewShowing = Main.overview.visible;

        try {
            this._buildActors();
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            for (const entry of [this._overlayEntry, this._logEntry]) {
                const caret = new CaretBlink(entry.clutter_text, this._interfaceSettings);
                this._caretBlinks.push(caret);
                const vim = new VimInput(entry, caret, () => this._submit(entry));
                this._vimInputs.push(vim);
                vim.setEnabled(this._vimEnabled);
                vim.setAvailable(Boolean(this._coreOwner && !this._busy()));
            }
            this._connect(this._interfaceSettings, 'changed::font-name', () => this._applyFont());
            this._connect(this._interfaceSettings, 'changed::text-scaling-factor', () => this._layout());
            this._connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => this._layout());
            this._applyFont();
            this._connect(Main.layoutManager, 'monitors-changed', () => this._layout());
            this._connect(global.display, 'workareas-changed', () => this._layout());
            this._connect(global.display, 'in-fullscreen-changed', () => this._updateVisibility());
            this._connect(Main.overview, 'showing', () => {
                this._overviewShowing = true;
                this._updateVisibility();
            });
            this._connect(Main.overview, 'hidden', () => {
                this._overviewShowing = false;
                this._updateVisibility();
            });
            this._connect(Main.sessionMode, 'updated', () => this._updateVisibility());
            this._connect(global.stage, 'captured-event', (_stage, event) => this._dismissFocusOutside(event));
            this._connect(global.stage, 'notify::key-focus', () => this._queueFocusDismiss());
            this._layout();

            this._desktopObject = Gio.DBusExportedObject.wrapJSObject(DESKTOP_XML, {
                Present: () => this._present(),
                OpenApp: app => this._openApp(app),
            });
            this._desktopName = Gio.bus_own_name(Gio.BusType.SESSION, DESKTOP_BUS,
                Gio.BusNameOwnerFlags.NONE,
                connection => {
                    if (this._enabled)
                        this._desktopObject.export(connection, DESKTOP_PATH);
                }, null, () => {
                    if (this._enabled)
                        console.warn('Zaiko: desktop service name unavailable');
                });
            this._coreWatch = Gio.bus_watch_name(Gio.BusType.SESSION, CORE_BUS,
                Gio.BusNameWatcherFlags.NONE,
                (_connection, _name, owner) => this._coreAppeared(owner),
                () => this._coreVanished());
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
    }

    _loadVimEnabled() {
        this._vimPreferencePath = GLib.build_filenamev([GLib.get_user_config_dir(), 'zaiko', 'input-vim-enabled']);
        if (!GLib.file_test(this._vimPreferencePath, GLib.FileTest.EXISTS))
            return false;
        try {
            const [, contents] = GLib.file_get_contents(this._vimPreferencePath);
            return new TextDecoder().decode(contents).trim() === 'true';
        } catch (error) {
            console.warn(`Zaiko: could not read input Vim preference: ${error.message}`);
            return false;
        }
    }

    _toggleVim() {
        const enabled = !this._vimEnabled;
        try {
            if (GLib.mkdir_with_parents(GLib.path_get_dirname(this._vimPreferencePath), 0o700) !== 0)
                throw new Error('Could not create configuration directory');
            GLib.file_set_contents(this._vimPreferencePath, enabled ? 'true\n' : 'false\n');
        } catch (error) {
            console.warn(`Zaiko: could not save input Vim preference: ${error.message}`);
            return;
        }
        this._vimEnabled = enabled;
        this._vimMenuItem.label.text = `Vim: ${enabled ? 'on' : 'off'}`;
        for (const vim of this._vimInputs)
            vim.setEnabled(enabled);
    }

    _setEntryAvailable(entry, available) {
        const vim = this._vimInputs.find(controller => controller.entry === entry);
        if (vim)
            vim.setAvailable(available);
        else
            entry.clutter_text.editable = available;
    }

    _applyFont() {
        const font = Pango.FontDescription.from_string(this._interfaceSettings.get_string('font-name'));
        const family = (font.get_family() || 'sans-serif').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        for (const actor of [this._panel, this._inputOverlay, this._answerLabel, this._characterMenu.actor,
            this._overlayEntry.menu.actor, this._logEntry.menu.actor,
            ...this._logMessageMenus().map(menu => menu.actor)])
            actor.set_style(`font-family: "${family}";`);
        this._renderCompact();
    }

    _styleContextMenu(menu, anchor = null) {
        menu.actor.add_style_class_name('zaiko-context');
        menu.actor.set_style(this._panel.get_style());
        menu.connect('open-state-changed', (_menu, open) => {
            menu.actor.remove_style_class_name('zaiko-keyboard');
            if (!open)
                return;
            // Anchor entry menus to the entire composer so a flipped menu
            // clears its outer border instead of overlapping the entry padding.
            if (anchor)
                menu.actor.setPosition(anchor, 0);
            menu.actor.get_parent().set_child_above_sibling(menu.actor, null);
            if (Clutter.get_current_event()?.type() === Clutter.EventType.KEY_PRESS)
                menu.actor.add_style_class_name('zaiko-keyboard');
        });
        menu.actor.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS)
                menu.actor.add_style_class_name('zaiko-keyboard');
            else if ([Clutter.EventType.MOTION, Clutter.EventType.BUTTON_PRESS].includes(event.type()))
                menu.actor.remove_style_class_name('zaiko-keyboard');
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildActors() {
        this._character = new St.Widget({
            style_class: 'zaiko-character',
            width: CHARACTER_WIDTH,
            height: CHARACTER_HEIGHT,
            reactive: true,
            clip_to_allocation: true,
            accessible_name: 'Zaiko — left-click to type, right-click for Log, drag to move',
            visible: false,
        });
        this._image = new St.Widget({reactive: false});
        this._character.add_child(this._image);
        this._setExpression('neutral');
        // Grab from the initial press, before a fast motion can leave the actor.
        // Grabbed events use the bubble phase, as in GNOME Shell's own DND.
        this._character.connect('event', (_actor, event) => this._onCharacterEvent(event));
        const secondaryClick = new Clutter.ClickGesture();
        secondaryClick.set_required_button(Clutter.BUTTON_SECONDARY);
        secondaryClick.connect('recognize', () => {
            if (!this._dragOrigin)
                this._openCharacterMenu();
        });
        this._character.add_action(secondaryClick);

        this._buildPanel();
        this._buildCompactActors();
        // Visibility is owned here rather than trackFullscreen.
        for (const actor of [this._character, this._panel, this._answerLabel, this._inputOverlay])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: false});
        Main.uiGroup.set_child_below_sibling(this._answerLabel, this._panel);
        Main.uiGroup.set_child_above_sibling(this._characterMenu.actor, this._panel);
        this._renderSnapshot();
    }

    _onCharacterEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN ||
            (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY)) {
            if (this._dragOrigin)
                return Clutter.EVENT_STOP;
            const [pointerX, pointerY] = event.get_coords();
            this._dragOrigin = {x: this._character.x, y: this._character.y, pointerX, pointerY,
                device: event.get_source_device(), sequence: event.get_event_sequence(), dragging: false};
            this._characterGrab = global.stage.grab(this._character);
            this._characterGrabSignal = this._characterGrab.connect('notify::revoked', grab => {
                if (grab.is_revoked())
                    this._endCharacterDrag();
            });
            return Clutter.EVENT_STOP;
        }
        const drag = this._dragOrigin;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._endCharacterDrag();
            return Clutter.EVENT_STOP;
        }
        if (event.get_source_device() !== drag.device || event.get_event_sequence() !== drag.sequence)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.TOUCH_CANCEL) {
            this._endCharacterDrag();
            return Clutter.EVENT_STOP;
        }
        const motion = [Clutter.EventType.MOTION, Clutter.EventType.TOUCH_UPDATE].includes(type);
        const release = type === Clutter.EventType.TOUCH_END ||
            (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY);
        if (!motion && !release)
            return Clutter.EVENT_PROPAGATE;
        const [pointerX, pointerY] = event.get_coords();
        const dx = pointerX - drag.pointerX;
        const dy = pointerY - drag.pointerY;
        if (!drag.dragging && Math.hypot(dx, dy) >= 8) {
            drag.dragging = true;
            this._characterMenu.close();
        }
        if (drag.dragging)
            this._positionCharacter(drag.x + dx, drag.y + dy);
        if (release) {
            this._endCharacterDrag();
            if (!drag.dragging)
                this._showInput();
        }
        return Clutter.EVENT_STOP;
    }

    _endCharacterDrag() {
        this._dragOrigin = null;
        const grab = this._characterGrab;
        this._characterGrab = null;
        if (grab) {
            grab.disconnect(this._characterGrabSignal);
            grab.dismiss();
        }
        this._characterGrabSignal = 0;
    }

    _buildPanel() {
        this._panel = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'zaiko-panel zaiko-log', width: 360, height: 400,
            reactive: true, track_hover: true, can_focus: true, visible: false,
        });
        this._panelContent = new St.BoxLayout({
            vertical: true, style_class: 'zaiko-panel-content', x_expand: true, y_expand: true,
        });
        this._panel.add_child(this._panelContent);
        this._connect(this._panel, 'notify::hover', () => this._updatePanelClose());
        this._panelClose = new St.Button({
            style_class: 'zaiko-panel-close', width: 28, height: 28,
            can_focus: true, accessible_name: 'Close conversation', visible: false,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
        });
        this._panel.add_child(this._panelClose);
        this._panelClose.set_child(new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}));
        this._panelClose.connect('clicked', () => this._hidePanel());
        this._panelClose.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        this._logScroll = new St.ScrollView({
            style_class: 'zaiko-scroll', x_expand: true, y_expand: true, overlay_scrollbars: true,
        });
        this._logScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._registerScrollbarParts(this._logScroll);
        this._logHistory = new St.BoxLayout({vertical: true, style_class: 'zaiko-history', x_expand: true});
        this._logScroll.set_child(this._logHistory);
        this._panelContent.add_child(this._logScroll);
        this._logStatus = this._wrappedLabel('', 'zaiko-log-status');
        this._logStatus.visible = false;
        this._panelContent.add_child(this._logStatus);
        this._buildLogComposer();
        this._panel.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
    }

    _buildLogComposer() {
        this._logComposer = new St.BoxLayout({
            style_class: 'zaiko-log-composer', x_expand: true, height: 38,
        });
        this._logEntry = new St.Entry({
            style_class: 'zaiko-log-entry', hint_text: 'Message Aiko…',
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._logEntry);
        this._styleContextMenu(this._logEntry.menu, this._logComposer);
        this._logEntry.menu.actor.connect('captured-event', (_actor, event) => this._dismissFocusOutside(event));
        this._logEntry.clutter_text.connect('activate', () => this._submit(this._logEntry));
        this._logComposer.add_child(this._logEntry);
        this._logSend = new St.Button({
            style_class: 'zaiko-log-send', can_focus: true,
            accessible_name: 'Send message in Log', y_align: Clutter.ActorAlign.CENTER,
        });
        this._logSendIcon = new St.Icon({icon_name: 'mail-send-symbolic', icon_size: 16});
        this._logSend.set_child(this._logSendIcon);
        this._logSend.connect('clicked', () => this._busy() ? this._cancel() : this._submit(this._logEntry));
        this._logComposer.add_child(this._logSend);
        this._trackComposerFocus(this._logComposer, this._logEntry, this._logSend);
        this._panelContent.add_child(this._logComposer);
    }

    _buildCompactActors() {
        this._inputOverlay = new St.BoxLayout({
            style_class: 'zaiko-input-overlay',
            width: 280, height: 38, reactive: true, visible: false,
        });
        this._overlayEntry = new St.Entry({
            style_class: 'zaiko-overlay-entry', hint_text: 'Message…',
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        ShellEntry.addContextMenu(this._overlayEntry);
        this._styleContextMenu(this._overlayEntry.menu, this._inputOverlay);
        this._overlayEntry.menu.actor.connect('captured-event', (_actor, event) => this._dismissFocusOutside(event));
        this._overlayEntry.clutter_text.connect('activate', () => this._submit(this._overlayEntry));
        this._inputOverlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._hideInput(true);
            return Clutter.EVENT_STOP;
        });
        this._inputOverlay.add_child(this._overlayEntry);
        this._overlaySend = new St.Button({
            style_class: 'zaiko-overlay-send', can_focus: true,
            accessible_name: 'Send message', y_align: Clutter.ActorAlign.CENTER,
        });
        this._overlaySendIcon = new St.Icon({icon_name: 'mail-send-symbolic', icon_size: 16});
        this._overlaySend.set_child(this._overlaySendIcon);
        this._overlaySend.connect('clicked', () => this._busy() ? this._cancel() : this._submit(this._overlayEntry));
        this._inputOverlay.add_child(this._overlaySend);
        this._trackComposerFocus(this._inputOverlay, this._overlayEntry, this._overlaySend);

        // The answer is a top-level label, with no card or container behind it.
        this._answerLabel = this._wrappedLabel('', 'zaiko-answer');
        this._answerLabel.width = 320;
        this._answerLabel.reactive = true;
        this._answerLabel.visible = false;
        this._answerLabel.clip_to_allocation = true;
        this._answerLabel.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._releaseFocus(true, [this._answerLabel]);
            return Clutter.EVENT_STOP;
        });

        this._characterMenu = new PopupMenu.PopupMenu(this._character, 0.5, St.Side.TOP);
        this._styleContextMenu(this._characterMenu);
        this._characterMenu.addAction('Log', () => this._showLog());
        this._vimMenuItem = new VimMenuItem(`Vim: ${this._vimEnabled ? 'on' : 'off'}`, () => this._toggleVim());
        this._characterMenu.addMenuItem(this._vimMenuItem);
        this._characterMenu.addAction('Quit', () => this._quitCore());
        Main.uiGroup.add_child(this._characterMenu.actor);
        this._characterMenu.actor.hide();
        this._characterMenuManager = new PopupMenu.PopupMenuManager(this._character);
        this._characterMenuManager.addMenu(this._characterMenu);
        this._characterMenu.connect('open-state-changed', () => {
            if (this._enabled)
                this._updateVisibility();
        });
    }

    _trackComposerFocus(composer, entry, sendButton) {
        composer.reactive = true;
        this._connect(composer, 'button-press-event', (_actor, event) => {
            // Only handle the surrounding padding/gaps. Native entry clicks
            // retain caret placement/selection; send and cancel keep their action.
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || global.stage.get_event_actor(event) !== composer)
                return Clutter.EVENT_PROPAGATE;
            this._rememberFocus();
            entry.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        for (const control of [entry.clutter_text, sendButton]) {
            this._connect(control, 'key-focus-in', () => composer.add_style_pseudo_class('focus'));
            this._connect(control, 'key-focus-out', () => composer.remove_style_pseudo_class('focus'));
        }
    }

    _registerScrollbarParts(view) {
        // Style our native parts directly rather than relying on theme ancestry.
        for (const bar of view.get_children().filter(child => child instanceof St.ScrollBar)) {
            for (const part of bar.get_children()) {
                const classes = part.get_style_class_name()?.split(' ') ?? [];
                if (classes.includes('vhandle') || classes.includes('hhandle'))
                    part.add_style_class_name('zaiko-scroll-thumb');
                else if (part.get_name() === 'trough')
                    part.add_style_class_name('zaiko-scroll-track');
                else
                    continue;
            }
        }
    }

    _setExpression(name) {
        if (this._expression === name)
            return;
        this._expression = name;
        const expression = EXPRESSIONS[name] ?? EXPRESSIONS.neutral;
        const geometry = imageGeometry(expression, CHARACTER_WIDTH, CHARACTER_HEIGHT);
        const uri = this.dir.get_child('assets').get_child('aiko').get_child(expression.file).get_uri();
        this._image.set_style(`background-image: url("${uri}"); background-size: contain;`);
        this._image.set_size(geometry.width, geometry.height);
        this._image.set_position(geometry.x, geometry.y);
    }

    _workArea() {
        const monitor = Main.layoutManager.primaryMonitor;
        return monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null;
    }

    _positionCharacter(x, y) {
        const area = this._workArea();
        if (!area)
            return;
        // Keep answers above the head while dragging, including near the top.
        // Tiny work areas can exhaust this reserve; compactPosition still clamps.
        const reserve = this._answerHasText
            ? Math.min(this._answerLabel.height + 8, Math.max(0, area.height - CHARACTER_HEIGHT - 16)) : 0;
        const bounds = {x: area.x, y: area.y + reserve,
            width: area.width, height: area.height - reserve};
        const position = clampPosition(x, y, CHARACTER_WIDTH, CHARACTER_HEIGHT, bounds);
        this._character.set_position(position.x, position.y);
        this._positionSurfaces(area);
    }

    _positionSurfaces(area) {
        const position = panelPosition({
            x: this._character.x, y: this._character.y,
            width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT,
        }, {width: this._panel.width, height: this._panel.height}, area);
        this._panel.set_position(position.x, position.y);
        const compact = compactPosition({
            x: this._character.x, y: this._character.y,
            width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT,
        }, {width: this._answerLabel.width, height: this._answerLabel.height},
        {width: this._inputOverlay.width, height: this._inputOverlay.height}, area);
        this._inputOverlay.set_position(compact.input.x, compact.input.y);
        this._answerLabel.set_position(compact.answer.x, compact.answer.y);
    }

    _layout() {
        const area = this._workArea();
        if (!area)
            return;
        this._panel.set_size(Math.min(360, Math.max(1, area.width - 16)),
            Math.min(400, Math.max(1, area.height - 16)));
        this._inputOverlay.width = Math.min(280, Math.max(1, area.width - 16));
        this._answerLabel.width = Math.min(320, Math.max(1, area.width - 16));
        this._renderCompact();
        if (!this._positioned) {
            this._positionCharacter(area.x + area.width - CHARACTER_WIDTH - 24,
                area.y + area.height - CHARACTER_HEIGHT - 16);
            this._positioned = true;
        } else {
            this._positionCharacter(this._character.x, this._character.y);
        }
        this._updateVisibility();
    }

    _updateVisibility() {
        if (!this._character)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const show = Boolean(this._coreOwner && monitor && !monitor.inFullscreen &&
            !this._overviewShowing && !Main.sessionMode.isLocked);
        if (!show) {
            this._endCharacterDrag();
            this._releaseFocus(false);
            this._characterMenu?.close();
        }
        this._character.visible = show;
        this._panel.visible = show && this._panelOpen;
        if (this._panel.visible)
            this._panel.sync_hover();
        this._updatePanelClose();
        this._inputOverlay.visible = show && this._inputOpen && !this._logIsOpen();
        this._answerLabel.visible = show && this._answerHasText;
    }

    _showInput() {
        if (!this._enabled)
            return;
        this._rememberFocus();
        if (this._logIsOpen()) {
            this._hideInput(false);
            if (this._panel.visible)
                this._logEntry.grab_key_focus();
            return;
        }
        this._inputOpen = true;
        this._updateVisibility();
        if (this._inputOverlay.visible)
            this._overlayEntry.grab_key_focus();
    }

    _updatePanelClose() {
        if (!this._panelClose)
            return;
        const visible = Boolean(this._enabled && this._panel.visible && this._panel.hover);
        if (!visible && this._enabled && this._panel.visible && this._panelClose.has_key_focus())
            this._logEntry.grab_key_focus();
        this._panelClose.visible = visible;
    }

    _present() {
        this._showInput();
    }

    _showLog() {
        this._rememberFocus();
        this._characterMenu.close();
        this._logEntry.menu?.close();
        this._hideInput(false);
        this._panelOpen = true;
        this._renderLogState();
        this._updateVisibility();
        if (this._panel.visible)
            this._logEntry.grab_key_focus();
    }

    _logIsOpen() {
        return this._panelOpen;
    }

    _openCharacterMenu() {
        if (!this._character.visible)
            return;
        this._rememberFocus();
        this._characterMenu.toggle();
    }

    _ownsFocus(focus, actors = [this._panel, this._panelClose, this._inputOverlay, this._answerLabel]) {
        return Boolean(focus && actors.some(actor => actor?.contains(focus)));
    }

    _rememberFocus() {
        const focus = global.stage.get_key_focus();
        const roots = [this._panel, this._panelClose, this._inputOverlay, this._answerLabel, this._characterMenu?.actor,
            this._overlayEntry?.menu?.actor, this._logEntry?.menu?.actor,
            ...this._logMessageMenus().map(menu => menu.actor)];
        if (!this._ownsFocus(focus, roots))
            this._focusBeforeUI = global.display.focus_window;
    }

    _releaseFocus(restore, actors = [this._panel, this._inputOverlay, this._answerLabel, this._characterMenu?.actor]) {
        const focus = global.stage.get_key_focus();
        const roots = [...actors];
        if (actors.includes(this._inputOverlay)) {
            roots.push(this._overlayEntry?.menu?.actor);
            this._overlayEntry?.menu?.close();
        }
        if (actors.includes(this._panel)) {
            roots.push(this._panelClose);
            roots.push(this._logEntry?.menu?.actor);
            this._logEntry?.menu?.close();
            for (const menu of this._logMessageMenus()) {
                roots.push(menu.actor);
                menu.close();
            }
        }
        if (actors.includes(this._characterMenu?.actor))
            this._characterMenu?.close();
        const ownedFocus = this._ownsFocus(focus, roots);
        if (!ownedFocus)
            return;
        global.stage.set_key_focus(null);
        if (restore && this._focusBeforeUI?.get_compositor_private())
            Main.activateWindow(this._focusBeforeUI);
    }

    _hidePanel() {
        this._panelOpen = false;
        this._releaseFocus(true, [this._panel]);
        this._updateVisibility();
    }

    _hideInput(restore = false) {
        this._inputOpen = false;
        this._releaseFocus(restore, [this._inputOverlay]);
        this._inputOverlay.hide();
    }

    _dismissFocusOutside(event) {
        if (this._selectionDrag && [Clutter.EventType.MOTION, Clutter.EventType.BUTTON_RELEASE].includes(event.type())) {
            const {text, anchor} = this._selectionDrag;
            text.set_selection(anchor, this._textPositionAtEvent(text, event));
            if (event.type() === Clutter.EventType.BUTTON_RELEASE)
                this._selectionDrag = null;
        }
        if (![Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type()))
            return Clutter.EVENT_PROPAGATE;
        const source = global.stage.get_event_actor(event);
        const controls = [
            [this._inputOverlay, this._overlayEntry.clutter_text, this._overlayEntry.menu],
            [this._logComposer, this._logEntry.clutter_text, this._logEntry.menu],
            [this._answerLabel, this._answerLabel.clutter_text, null],
            ...this._logHistory.get_children().map(label => [label, label.clutter_text, label.menu]),
        ];
        for (const [actor, text, menu] of controls) {
            const roots = [actor, menu?.actor];
            if (this._ownsFocus(source, roots))
                continue;
            if (text.get_selection()) {
                const cursor = text.get_cursor_position();
                text.set_selection(cursor, cursor);
            }
            const ownedFocus = this._ownsFocus(global.stage.get_key_focus(), roots);
            menu?.close();
            if (ownedFocus)
                global.stage.set_key_focus(null);
        }
        if (this._inputOpen &&
            !this._ownsFocus(source, [this._inputOverlay, this._character, this._overlayEntry?.menu?.actor]))
            this._hideInput(false);
        // Observe only: the same press still reaches its original desktop target.
        return Clutter.EVENT_PROPAGATE;
    }

    _queueFocusDismiss() {
        if (this._focusDismissSource || !this._inputOpen)
            return;
        this._focusDismissSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._focusDismissSource = 0;
            const allowed = [this._inputOverlay, this._character, this._overlayEntry?.menu?.actor,
                this._characterMenu?.actor];
            if (this._enabled && this._inputOpen && !this._ownsFocus(global.stage.get_key_focus(), allowed))
                this._hideInput(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _coreAppeared(owner) {
        if (!this._enabled)
            return;
        this._clearCore();
        this._coreOwner = owner;
        this._sessionCancellable = new Gio.Cancellable();
        // Install the signal subscription before reading a recoverable snapshot.
        this._eventSubscription = Gio.DBus.session.signal_subscribe(owner, CORE_BUS,
            'Event', CORE_PATH, null, Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, parameters) => {
                if (!this._enabled || this._coreOwner !== owner)
                    return;
                try {
                    const event = parseEvent(parameters.deep_unpack()[0]);
                    if (event.type === 'present')
                        this._present();
                    this._refreshSnapshot();
                } catch (_error) {
                    this._snapshotError = 'Could not read the companion update.';
                    this._renderSnapshot();
                    this._refreshSnapshot();
                }
            });
        this._uiError = null;
        this._snapshotError = null;
        this._updateVisibility();
        this._refreshSnapshot();
    }

    _clearCore() {
        this._epoch++;
        this._clearAnswerTimeout();
        this._clearThinkingClock();
        this._sessionCancellable?.cancel();
        this._sessionCancellable = null;
        if (this._eventSubscription)
            Gio.DBus.session.signal_unsubscribe(this._eventSubscription);
        this._eventSubscription = 0;
        this._coreOwner = null;
        this._snapshotRunning = false;
        this._snapshotDirty = false;
        this._sending = false;
        this._cancelling = false;
        this._pendingRequestId = null;
        this._snapshot = {...EMPTY_SNAPSHOT};
        this._historySignature = null;
    }

    _coreVanished() {
        if (!this._enabled)
            return;
        this._clearCore();
        this._panelOpen = false;
        this._inputOpen = false;
        this._updateVisibility();
        this._renderSnapshot();
    }

    _callCore(method, parameters = null) {
        const owner = this._coreOwner;
        const epoch = this._epoch;
        const cancellable = this._sessionCancellable;
        if (!owner)
            return Promise.reject(new Error('Companion is unavailable'));
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(owner, CORE_PATH, CORE_BUS, method, parameters,
                null, Gio.DBusCallFlags.NONE, 5000, cancellable,
                (connection, result) => {
                    try {
                        const reply = connection.call_finish(result);
                        if (!this._enabled || epoch !== this._epoch)
                            throw new Error('Companion session changed');
                        resolve(reply.deep_unpack());
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    async _refreshSnapshot() {
        if (!this._enabled || !this._coreOwner)
            return;
        if (this._snapshotRunning) {
            this._snapshotDirty = true;
            return;
        }
        const epoch = this._epoch;
        this._snapshotRunning = true;
        this._snapshotDirty = false;
        try {
            const [payload] = await this._callCore('GetSnapshot');
            this._snapshot = parseSnapshot(payload);
            this._snapshotError = null;
            this._renderSnapshot();
        } catch (_error) {
            if (this._enabled && epoch === this._epoch) {
                this._snapshotError = 'Could not connect to Zaiko. Try again.';
                this._renderSnapshot();
            }
        } finally {
            if (this._enabled && epoch === this._epoch) {
                this._snapshotRunning = false;
                if (this._snapshotDirty)
                    this._refreshSnapshot();
            }
        }
    }

    _busy() {
        return this._sending || isBusy(this._snapshot);
    }

    _renderSnapshot() {
        if (!this._panel)
            return;
        this._setExpression(expressionFor(this._snapshot));
        this._syncThinkingClock();
        this._renderCompact();
        this._renderLogState();
        const signature = JSON.stringify(this._snapshot.messages);
        if (signature === this._historySignature)
            return;
        this._historySignature = signature;
        this._logHistory.destroy_all_children();
        if (!this._snapshot.messages.length) {
            const placeholder = this._wrappedLabel('No conversation yet.', 'zaiko-placeholder');
            this._logHistory.add_child(placeholder);
        }
        for (const message of this._snapshot.messages) {
            const {prefix, text, color} = transcriptLine(message);
            const label = this._wrappedLabel(text, 'zaiko-log-message');
            this._makeMessageCopyable(label);
            label.clutter_text.set_line_alignment(Pango.Alignment.LEFT);
            if (color) {
                const applyPrefix = () => {
                    const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) * 257);
                    const attribute = Pango.attr_foreground_new(...channels);
                    attribute.start_index = 0;
                    attribute.end_index = prefix.length;
                    const attributes = label.clutter_text.get_attributes()?.copy() ?? Pango.AttrList.new();
                    attributes.change(attribute);
                    label.clutter_text.set_attributes(attributes);
                };
                // St replaces foreground attributes when applying CSS. Run after
                // its style handler, overriding only the ASCII prefix byte range.
                // All message text remains literal; no markup is parsed.
                label.connect_after('style-changed', applyPrefix);
                applyPrefix();
            }
            this._logHistory.add_child(label);
        }
        if (this._scrollSource)
            GLib.Source.remove(this._scrollSource);
        this._scrollSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollSource = 0;
            if (this._enabled) {
                const adjustment = this._logScroll.get_vadjustment();
                adjustment.value = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderLogState() {
        const busy = this._busy();
        const error = this._uiError || this._snapshotError || this._snapshot.error ||
            (this._snapshot.state === 'error' ? 'Something went wrong.' : null);
        const status = error || this._requestStatus();
        this._logStatus.text = status ? `[Aiko] ${status}` : '';
        this._logStatus.visible = Boolean(this._logStatus.text);
        this._logStatus.set_style_class_name(`zaiko-log-status${error ? ' zaiko-log-error' : ''}`);
        this._logSendIcon.icon_name = busy ? 'process-stop-symbolic' : 'mail-send-symbolic';
        this._logSend.accessible_name = this._cancelling ? 'Stopping request' : busy ? 'Cancel request' : 'Send message in Log';
        this._logSend.reactive = Boolean(this._coreOwner && !this._cancelling);
        this._logSend.can_focus = this._logSend.reactive;
        this._setEntryAvailable(this._logEntry, Boolean(this._coreOwner && !busy));
    }

    _wrappedLabel(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.selectable = true;
        return label;
    }

    _logMessageMenus() {
        return this._logHistory?.get_children().map(label => label.menu).filter(Boolean) ?? [];
    }

    _textPositionAtEvent(text, event) {
        const [stageX, stageY] = event.get_coords();
        const [success, x, y] = text.transform_stage_point(stageX, stageY);
        if (!success)
            return text.get_cursor_position();
        return text.coords_to_position(Math.max(0, Math.min(x, text.width - 1)),
            Math.max(0, Math.min(y, text.height - 1)));
    }

    _makeMessageCopyable(label) {
        const text = label.clutter_text;
        label.reactive = true;
        label.can_focus = true;
        text.reactive = true;
        label.connect('button-press-event', (_actor, event) => {
            // Native text selection handles the content; let the surrounding
            // padding start a selection too, clamping to the nearest character.
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || global.stage.get_event_actor(event) !== label)
                return Clutter.EVENT_PROPAGATE;
            this._rememberFocus();
            text.grab_key_focus();
            const anchor = this._textPositionAtEvent(text, event);
            text.set_selection(anchor, anchor);
            this._selectionDrag = {text, anchor};
            return Clutter.EVENT_STOP;
        });
        // St.Label does not forward the entry selection CSS to Clutter.Text.
        label.connect('style-changed', () => {
            const node = label.get_theme_node();
            const [hasBackground, background] = node.lookup_color('selection-background-color', false);
            const [hasForeground, foreground] = node.lookup_color('selected-color', false);
            if (hasBackground)
                text.set_selection_color(background);
            if (hasForeground)
                text.set_selected_text_color(foreground);
        });
        const clipboard = St.Clipboard.get_default();
        const copy = () => clipboard.set_text(St.ClipboardType.CLIPBOARD,
            text.get_selection() || label.text);
        text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if ((event.get_state() & Clutter.ModifierType.CONTROL_MASK) &&
                [Clutter.KEY_c, Clutter.KEY_C].includes(symbol)) {
                if (text.get_selection())
                    copy();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        label.menu = new PopupMenu.PopupMenu(label, 0, St.Side.TOP);
        label.menu.focusActor = text;
        this._styleContextMenu(label.menu);
        label.menu.addAction('Copy', copy);
        Main.uiGroup.add_child(label.menu.actor);
        label.menu.actor.hide();
        label._menuManager = new PopupMenu.PopupMenuManager(label);
        label._menuManager.addMenu(label.menu);
        label.menu.actor.connect('captured-event', (_actor, event) => this._dismissFocusOutside(event));

        // Capture the secondary press before Clutter.Text changes the selection,
        // matching the native entry menu's gesture handling.
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.set_required_button(Clutter.BUTTON_SECONDARY);
        click.connect('recognize', gesture => {
            this._rememberFocus();
            const coords = gesture.get_coords_abs();
            const [success, x] = label.transform_stage_point(coords.x, coords.y);
            if (success && label.width)
                label.menu.setSourceAlignment(x / label.width);
            label.menu.toggle();
        });
        label.add_action_full('copy-menu', Clutter.EventPhase.CAPTURE, click);
        label.connect('destroy', () => {
            if (this._selectionDrag?.text === text)
                this._selectionDrag = null;
            label.menu.destroy();
            label.menu = null;
            label._menuManager = null;
        });
    }

    _clearAnswerTimeout() {
        if (this._answerHideSource)
            GLib.Source.remove(this._answerHideSource);
        this._answerHideSource = 0;
        this._answerDisplayKey = null;
        this._answerExpired = false;
        this._answerHasText = false;
    }

    _clearThinkingClock() {
        if (this._thinkingSource)
            GLib.Source.remove(this._thinkingSource);
        this._thinkingSource = 0;
        this._thinkingStartedUs = 0;
        this._thinkingRequestId = null;
    }

    _syncThinkingClock() {
        const {state, request_id: requestId} = this._snapshot;
        if (!['thinking', 'working'].includes(state)) {
            this._clearThinkingClock();
            return;
        }
        if (requestId && this._thinkingRequestId && requestId !== this._thinkingRequestId)
            this._clearThinkingClock();
        if (state === 'thinking' && !this._thinkingStartedUs)
            this._thinkingStartedUs = GLib.get_monotonic_time();
        if (requestId)
            this._thinkingRequestId = requestId;
        if (!this._thinkingStartedUs || this._thinkingSource)
            return;
        this._thinkingSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this._enabled || !['thinking', 'working'].includes(this._snapshot.state)) {
                this._thinkingSource = 0;
                this._thinkingStartedUs = 0;
                return GLib.SOURCE_REMOVE;
            }
            if (this._snapshot.state === 'thinking') {
                this._renderCompact();
                this._renderLogState();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _requestStatus() {
        if (this._sending)
            return 'Sending…';
        if (this._snapshot.state === 'thinking') {
            const elapsed = this._thinkingStartedUs
                ? (GLib.get_monotonic_time() - this._thinkingStartedUs) / 1_000_000 : 0;
            return `Thinking... (${formatElapsed(elapsed)})`;
        }
        return this._snapshot.state === 'working' ? 'Opening app…' : '';
    }

    _renderCompact() {
        if (!this._answerLabel)
            return;
        const busy = this._busy();
        const error = this._uiError || this._snapshotError || this._snapshot.error ||
            (this._snapshot.state === 'error' ? 'Something went wrong.' : null);
        const text = error || this._requestStatus() || latestAssistant(this._snapshot.messages);
        const contentWidth = Math.max(1, this._answerLabel.width);
        const layout = this._answerLabel.clutter_text.get_layout().copy();
        layout.set_font_description(this._answerLabel.get_theme_node().get_font());
        layout.set_single_paragraph_mode(false);
        const display = text ? `[Aiko] ${text}` : '';
        // Repaints, font changes and reopening input must not prolong a message.
        // The count also distinguishes a new reply with exactly the same text.
        const key = JSON.stringify([busy ? (error || (this._sending ? 'sending' : this._snapshot.state)) : display,
            this._snapshot.messages.filter(message => message.role === 'assistant').length]);
        if (key !== this._answerDisplayKey) {
            this._clearAnswerTimeout();
            this._answerDisplayKey = key;
            if (display && this._coreOwner && !busy) {
                this._answerHideSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8000, () => {
                    this._answerHideSource = 0;
                    this._answerExpired = true;
                    this._answerHasText = false;
                    this._releaseFocus(false, [this._answerLabel]);
                    this._updateVisibility();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        this._answerPreview = answerPreview(layout, display, contentWidth);
        this._answerLabel.text = this._answerPreview.text;
        this._answerLabel.accessible_name = display;
        this._answerLabel.set_size(contentWidth, this._answerPreview.height);
        this._answerHasText = Boolean(text) && !this._answerExpired;
        if (error)
            this._answerLabel.add_style_class_name('zaiko-answer-error');
        else
            this._answerLabel.remove_style_class_name('zaiko-answer-error');
        this._overlaySendIcon.icon_name = busy ? 'process-stop-symbolic' : 'mail-send-symbolic';
        this._overlaySend.accessible_name = this._cancelling ? 'Stopping request' : busy ? 'Cancel request' : 'Send message';
        this._overlaySend.reactive = Boolean(this._coreOwner && !this._cancelling);
        this._overlaySend.can_focus = this._overlaySend.reactive;
        this._setEntryAvailable(this._overlayEntry, Boolean(this._coreOwner && !busy));
        if (this._positioned)
            this._positionCharacter(this._character.x, this._character.y);
        this._updateVisibility();
    }

    async _submit(entry = this._overlayEntry) {
        if (![this._overlayEntry, this._logEntry].includes(entry) ||
            (entry === this._overlayEntry && this._logIsOpen()))
            return;
        const text = entry.get_text().trim();
        if (!text || this._busy() || !this._coreOwner)
            return;
        const epoch = this._epoch;
        const requestId = GLib.uuid_string_random();
        this._pendingRequestId = requestId;
        this._sending = true;
        this._uiError = null;
        entry.set_text('');
        this._renderSnapshot();
        try {
            await this._callCore('Submit', new GLib.Variant('(ss)', [requestId, text]));
            if (this._enabled && epoch === this._epoch) {
                if (entry === this._overlayEntry)
                    this._hideInput(true);
                else if (this._logIsOpen() && this._panel.visible &&
                    this._ownsFocus(global.stage.get_key_focus(), [this._panel]))
                    this._logEntry.grab_key_focus();
            }
        } catch (_error) {
            // A lost core may cancel the RPC after incrementing the epoch.
            // Preserve its draft only in the surviving, still-empty source;
            // never write into an actor replaced by disable/re-enable.
            if (this._enabled && [this._overlayEntry, this._logEntry].includes(entry) && !entry.get_text())
                entry.set_text(text);
            if (this._enabled && epoch === this._epoch)
                this._uiError = 'Message could not be sent. Please try again.';
        } finally {
            if (this._enabled && epoch === this._epoch) {
                this._sending = false;
                this._pendingRequestId = null;
                this._renderSnapshot();
                this._refreshSnapshot();
            }
        }
    }

    async _cancel() {
        const requestId = this._pendingRequestId || this._snapshot.request_id;
        if (!requestId || this._cancelling || !this._coreOwner)
            return;
        const epoch = this._epoch;
        this._cancelling = true;
        this._renderSnapshot();
        try {
            await this._callCore('Cancel', new GLib.Variant('(s)', [requestId]));
        } catch (_error) {
            if (this._enabled && epoch === this._epoch)
                this._uiError = 'Could not stop the current request.';
        } finally {
            if (this._enabled && epoch === this._epoch) {
                this._cancelling = false;
                this._renderSnapshot();
                this._refreshSnapshot();
            }
        }
    }

    async _quitCore() {
        const epoch = this._epoch;
        try {
            await this._callCore('Quit');
        } catch (_error) {
            if (this._enabled && epoch === this._epoch) {
                this._uiError = 'Could not close Zaiko.';
                this._renderSnapshot();
            }
        }
    }

    _openApp(alias) {
        const candidates = Object.hasOwn(APP_IDS, alias) ? APP_IDS[alias] : null;
        if (!candidates)
            return [false, 'Unsupported app. Choose terminal or vscode.'];
        const system = Shell.AppSystem.get_default();
        const app = candidates.map(id => system.lookup_app(id)).find(Boolean);
        if (!app)
            return [false, `${alias === 'terminal' ? 'zter' : 'VS Code'} is not installed or has no desktop launcher.`];
        try {
            this._releaseFocus(false);
            const windows = app.get_windows();
            const currentWorkspace = global.workspace_manager.get_active_workspace();
            const window = windows.find(candidate => candidate.has_focus()) ||
                windows.find(candidate => candidate.get_workspace() === currentWorkspace) || windows[0];
            if (window) {
                if (!window.has_focus()) {
                    if (window.minimized)
                        window.unminimize();
                    Main.activateWindow(window);
                }
            } else {
                app.activate();
            }
            return [true, `Launch or activation requested for ${alias === 'terminal' ? 'zter' : 'VS Code'}.`];
        } catch (_error) {
            return [false, `Could not request ${alias === 'terminal' ? 'zter' : 'VS Code'}.`];
        }
    }

    disable() {
        this._enabled = false;
        this._endCharacterDrag();
        this._selectionDrag = null;
        this._releaseFocus(false);
        this._characterMenu?.destroy();
        this._characterMenu = null;
        this._characterMenuManager = null;
        this._vimMenuItem = null;
        this._clearCore();
        if (this._coreWatch)
            Gio.bus_unwatch_name(this._coreWatch);
        this._coreWatch = 0;
        this._desktopObject?.unexport();
        this._desktopObject = null;
        if (this._desktopName)
            Gio.bus_unown_name(this._desktopName);
        this._desktopName = 0;
        for (const vim of this._vimInputs ?? [])
            vim.destroy();
        this._vimInputs = [];
        for (const caret of this._caretBlinks ?? [])
            caret.destroy();
        this._caretBlinks = [];
        for (const [object, id] of this._signals ?? [])
            object.disconnect(id);
        this._signals = [];
        this._interfaceSettings = null;
        if (this._scrollSource)
            GLib.Source.remove(this._scrollSource);
        this._scrollSource = 0;
        if (this._focusDismissSource)
            GLib.Source.remove(this._focusDismissSource);
        this._focusDismissSource = 0;
        for (const actor of [this._panel, this._character, this._inputOverlay, this._answerLabel]) {
            if (!actor)
                continue;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._panel = null;
        this._panelContent = null;
        this._panelClose = null;
        this._logScroll = null;
        this._logHistory = null;
        this._logComposer = null;
        this._logEntry = null;
        this._logSend = null;
        this._logSendIcon = null;
        this._logStatus = null;
        this._character = null;
        this._image = null;
        this._expression = null;
        this._positioned = false;
        this._dragOrigin = null;
        this._focusBeforeUI = null;
        this._inputOverlay = null;
        this._overlayEntry = null;
        this._overlaySend = null;
        this._overlaySendIcon = null;
        this._answerLabel = null;
        this._answerPreview = null;
    }
}
