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
    APP_IDS, APP_ACTIONS, TERMINAL_ACTIONS, CORE_BUS, CORE_PATH, DESKTOP_BUS, DESKTOP_PATH, DESKTOP_XML,
    panelPosition, clampPosition, compactPosition, expressionFor, isBusy, latestAssistant, parseEvent, parseSnapshot,
    transcriptLine, formatElapsed, choiceLabel,
} from './protocol.js';
import {
    CHARACTER_SIZES, characterBox, frameCycleDelay, imageGeometry, nextCharacterSize, normalizeCharacterSize, pickFrame,
} from './assets/manifest.js';
import {CharacterMotion} from './characterMotion.js';
import {TICK_MS, Typewriter, firstGraphemes, graphemes} from './typewriter.js';
import {answerPreview} from './answerPreview.js';
import {CaretBlink} from './caret.js';
import {VimInput} from './vimInput.js';
import {CommandMenu} from './commandMenu.js';
import {LANGUAGES, normalizeLanguage, createTranslator} from './i18n.js';

const ANSWER_TAIL_WIDTH = 16;
const ANSWER_TAIL_HEIGHT = 8;
const EMPTY_SNAPSHOT = {messages: [], state: 'idle', request_id: null, error: null, model: '', models: [], permissions: ''};

const ToggleMenuItem = GObject.registerClass(class ToggleMenuItem extends PopupMenu.PopupMenuItem {
    _init(label, toggle) {
        super._init(label);
        this._toggle = toggle;
    }

    activate() {
        // This preference toggles in place; Log and Quit keep normal activation.
        this._toggle();
    }
});

// Lists every choice with the active one in the normal color and the others dim.
const ChoiceMenuItem = GObject.registerClass(class ChoiceMenuItem extends ToggleMenuItem {
    _init(toggle) {
        super._init('', toggle);
        this._dim = [];
        // St replaces foreground attributes when applying CSS; recolor after it.
        this.label.connect_after('style-changed', () => this._dimChoices());
    }

    setChoices(title, choices, active) {
        const {text, dim} = choiceLabel(title, choices, active);
        this.choice = active;
        this._dim = dim;
        this.label.text = text;
        this.accessible_name = `${title}: ${active}`;
        this._dimChoices();
    }

    _dimChoices() {
        // The theme color is only known once the label is styled on the stage.
        if (!this.label.get_stage())
            return;
        const text = this.label.clutter_text;
        // Keep St's attributes, and color the whole row explicitly: a list
        // without a foreground color draws unmarked text black.
        const attributes = text.get_attributes()?.copy() ?? Pango.AttrList.new();
        const color = (red, green, blue, start, end) => {
            const attribute = Pango.attr_foreground_new(red * 257, green * 257, blue * 257);
            attribute.start_index = start;
            attribute.end_index = end;
            attributes.change(attribute);
        };
        const normal = this.label.get_theme_node().get_foreground_color();
        color(normal.red, normal.green, normal.blue, 0, new TextEncoder().encode(text.text).length);
        for (const [start, end] of this._dim)
            color(0x7f, 0x84, 0x8e, start, end);
        text.set_attributes(attributes);
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
        this._frameCycleSource = 0;
        this._reveal = null;
        this._revealSource = 0;
        this._knownReplies = null;
        this._focusDismissSource = 0;
        this._selectionDrag = null;
        this._logClick = null;
        this._dragOrigin = null;
        this._characterGrab = null;
        this._characterGrabSignal = 0;
        this._sending = false;
        this._cancelling = false;
        this._snapshotRunning = false;
        this._snapshotDirty = false;
        this._signals = [];
        this._composers = [];
        this._caretBlinks = [];
        this._vimInputs = [];
        this._commandMenus = [];
        this._vimEnabled = this._loadVimEnabled();
        this._characterSize = this._loadCharacterSize();
        this._characterBox = characterBox(this._characterSize);
        this._vimModeState = {mode: 'normal'};
        this._catalogs = this._loadCatalogs();
        this._language = this._loadLanguage();
        this._translate = createTranslator(this._catalogs, this._language);
        this._eventSubscription = 0;
        this._scrollSource = 0;
        this._composerLayoutSource = 0;
        this._uiError = null;
        this._snapshotError = null;
        this._historySignature = null;
        this._sessionCancellable = null;
        this._overviewShowing = Main.overview.visible;

        try {
            this._buildActors();
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            for (const entry of [this._overlayEntry, this._logEntry]) {
                const composer = entry === this._overlayEntry ? this._inputOverlay : this._logComposer;
                this._commandMenus.push(new CommandMenu(entry, composer, () => this._workArea(),
                    () => this._submit(entry), view => this._registerScrollbarParts(view), key => this._t(key)));
                const caret = new CaretBlink(entry.clutter_text, this._interfaceSettings);
                this._caretBlinks.push(caret);
                const keepsFocus = entry === this._logEntry
                    ? focus => this._ownsFocus(focus, [this._panel, ...this._logMessageMenus().map(menu => menu.actor)])
                    : null;
                const onMode = entry === this._logEntry ? mode => this._renderLogVimMode(mode) : null;
                const vim = new VimInput(entry, caret, () => this._submit(entry), keepsFocus, onMode, this._vimModeState);
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
                OpenTerminal: mode => this._openApp('terminal', mode),
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

    _loadCatalogs() {
        const catalogs = {};
        for (const language of LANGUAGES) {
            try {
                const file = this.dir.get_child('locales').get_child(`${language}.json`);
                const [, bytes] = file.load_contents(null);
                const catalog = JSON.parse(new TextDecoder().decode(bytes));
                if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) ||
                    !Object.values(catalog).every(value => typeof value === 'string'))
                    throw new Error('Expected a JSON object containing string translations');
                catalogs[language] = catalog;
            } catch (error) {
                console.warn(`Zaiko: could not load ${language} translations: ${error.message}`);
                catalogs[language] = {};
            }
        }
        return catalogs;
    }

    _loadLanguage() {
        this._languagePreferencePath = GLib.build_filenamev([GLib.get_user_config_dir(), 'zaiko', 'language.json']);
        if (!GLib.file_test(this._languagePreferencePath, GLib.FileTest.EXISTS))
            return 'en';
        try {
            const [, bytes] = GLib.file_get_contents(this._languagePreferencePath);
            return normalizeLanguage(JSON.parse(new TextDecoder().decode(bytes)).language);
        } catch (error) {
            console.warn(`Zaiko: could not read language preference: ${error.message}`);
            return 'en';
        }
    }

    _t(key, values = {}) {
        return this._translate(key, values);
    }

    _syncChoiceMenus() {
        const [on, off] = [this._t('state.on'), this._t('state.off')];
        this._sizeMenuItem.setChoices(this._t('menu.size'), CHARACTER_SIZES.map(String), String(this._characterSize));
        this._langMenuItem.setChoices(this._t('menu.language'), LANGUAGES, this._language);
        this._vimMenuItem.setChoices(this._t('menu.vim'), [on, off], this._vimEnabled ? on : off);
    }

    _toggleLanguage() {
        const language = this._language === 'en' ? 'th' : 'en';
        try {
            if (GLib.mkdir_with_parents(GLib.path_get_dirname(this._languagePreferencePath), 0o700) !== 0)
                throw new Error('Could not create configuration directory');
            GLib.file_set_contents(this._languagePreferencePath, `${JSON.stringify({language}, null, 2)}\n`);
        } catch (error) {
            console.warn(`Zaiko: could not save language preference: ${error.message}`);
            return;
        }
        this._language = language;
        this._translate = createTranslator(this._catalogs, language);
        this._logMenuItem.label.text = this._t('menu.log');
        this._syncChoiceMenus();
        this._quitMenuItem.label.text = this._t('menu.quit');
        this._character.accessible_name = this._t('accessibility.character');
        this._panelClose.accessible_name = this._t('accessibility.close');
        this._logBottom.accessible_name = this._t('accessibility.bottom');
        for (const {entry, cancel} of this._composers) {
            entry.accessible_name = this._t('accessibility.message');
            cancel.accessible_name = this._t('accessibility.cancel');
            this._translateEntryMenu(entry);
        }
        for (const menu of this._commandMenus)
            menu.setTranslator(key => this._t(key));
        this._historySignature = null;
        this._renderSnapshot();
        this._queueComposerLayout();
    }

    _translateEntryMenu(entry) {
        entry.menu._copyItem.label.text = this._t('action.copy');
        entry.menu._pasteItem.label.text = this._t('action.paste');
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
        this._syncChoiceMenus();
        for (const vim of this._vimInputs)
            vim.setEnabled(enabled);
    }

    _loadCharacterSize() {
        this._sizePreferencePath = GLib.build_filenamev([GLib.get_user_config_dir(), 'zaiko', 'character-size']);
        if (!GLib.file_test(this._sizePreferencePath, GLib.FileTest.EXISTS))
            return normalizeCharacterSize(null);
        try {
            const [, contents] = GLib.file_get_contents(this._sizePreferencePath);
            return normalizeCharacterSize(new TextDecoder().decode(contents));
        } catch (error) {
            console.warn(`Zaiko: could not read character size preference: ${error.message}`);
            return normalizeCharacterSize(null);
        }
    }

    _cycleCharacterSize() {
        const size = nextCharacterSize(this._characterSize);
        try {
            if (GLib.mkdir_with_parents(GLib.path_get_dirname(this._sizePreferencePath), 0o700) !== 0)
                throw new Error('Could not create configuration directory');
            GLib.file_set_contents(this._sizePreferencePath, `${size}\n`);
        } catch (error) {
            console.warn(`Zaiko: could not save character size preference: ${error.message}`);
            return;
        }
        const previous = this._characterBox;
        this._characterSize = size;
        this._characterBox = characterBox(size);
        this._syncChoiceMenus();
        this._character.set_size(this._characterBox.width, this._characterBox.height);
        this._drawFrame();
        // Grow or shrink around her bottom centre; positioning still clamps.
        this._positionCharacter(this._character.x + (previous.width - this._characterBox.width) / 2,
            this._character.y + previous.height - this._characterBox.height);
    }

    _setEntryAvailable(entry, available) {
        this._commandMenus.find(menu => menu.entry === entry)?.setAvailable(available);
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
            ...this._commandMenus.map(menu => menu.actor),
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
            // Keep the interaction source while positioning against the whole
            // composer or a private point anchor at the right-click location.
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
            width: this._characterBox.width,
            height: this._characterBox.height,
            reactive: true,
            clip_to_allocation: true,
            accessible_name: this._t('accessibility.character'),
            visible: false,
        });
        // The body breathes; the image inside it pops when the frame changes.
        this._body = new St.Widget({reactive: false});
        this._image = new St.Widget({reactive: false});
        this._body.add_child(this._image);
        this._character.add_child(this._body);
        this._motion = new CharacterMotion(this._body, this._image);
        this._setExpression('neutral');
        // Grab from the initial press, before a fast motion can leave the actor.
        // Grabbed events use the bubble phase, as in GNOME Shell's own DND.
        this._character.connect('event', (_actor, event) => this._onCharacterEvent(event));
        const secondaryClick = new Clutter.ClickGesture();
        secondaryClick.set_required_button(Clutter.BUTTON_SECONDARY);
        secondaryClick.connect('recognize', gesture => {
            if (!this._dragOrigin)
                this._openCharacterMenu(gesture.get_coords_abs());
        });
        this._character.add_action(secondaryClick);

        this._buildPanel();
        this._buildCompactActors();
        // Visibility is owned here rather than trackFullscreen.
        for (const actor of [this._character, this._panel, this._answerLabel, this._answerTail, this._inputOverlay])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: false});
        Main.uiGroup.set_child_below_sibling(this._answerLabel, this._panel);
        Main.uiGroup.set_child_below_sibling(this._answerTail, this._panel);
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
            can_focus: true, accessible_name: this._t('accessibility.close'), visible: false,
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
        // New messages keep the Log at the bottom only while the reader is
        // there; after scrolling up, a button jumps back down.
        this._logFollow = true;
        const adjustment = this._logScroll.get_vadjustment();
        this._connect(adjustment, 'notify::value', () => {
            this._logFollow = adjustment.value >= adjustment.upper - adjustment.page_size - 8;
            this._logBottom.visible = !this._logFollow;
        });
        this._logBottom = new St.Button({
            style_class: 'zaiko-log-to-bottom', width: 28, height: 28,
            can_focus: true, accessible_name: this._t('accessibility.bottom'), visible: false,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.END,
        });
        this._logBottom.set_child(new St.Icon({icon_name: 'go-down-symbolic', icon_size: 16}));
        this._logBottom.connect('clicked', () => this._queueLogScroll(true));
        const logArea = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        logArea.add_child(this._logScroll);
        logArea.add_child(this._logBottom);
        this._panelContent.add_child(logArea);
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
        const {actor, entry, scroll, cancel} = this._createComposer('zaiko-log-composer', 'zaiko-log-entry');
        this._logComposer = actor;
        this._logEntry = entry;
        this._logInputScroll = scroll;
        this._logCancel = cancel;
        // The footer sits close under the input, outside the panel's wider spacing.
        const bottom = new St.BoxLayout({vertical: true, style_class: 'zaiko-log-bottom', x_expand: true});
        bottom.add_child(actor);
        this._logFooter = new St.BoxLayout({style_class: 'zaiko-log-footer', x_expand: true, visible: false});
        this._logModel = new St.Label({text: '', style_class: 'zaiko-log-model', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._logModel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._logVimMode = new St.Label({text: '', style_class: 'zaiko-vim-mode', y_align: Clutter.ActorAlign.CENTER});
        this._logFooter.add_child(this._logModel);
        this._logFooter.add_child(this._logVimMode);
        bottom.add_child(this._logFooter);
        this._panel.connect('notify::allocation', () => this._queueComposerLayout());
        this._logStatus.connect('notify::allocation', () => this._queueComposerLayout());
        this._panelContent.add_child(bottom);
    }

    _createComposer(styleClass, entryClass) {
        const actor = new St.BoxLayout({style_class: styleClass, x_expand: true, can_focus: true});
        actor.add_child(new St.Label({
            text: '›', style_class: 'zaiko-input-prompt', y_align: Clutter.ActorAlign.START,
        }));
        const scroll = new St.ScrollView({
            style_class: 'zaiko-scroll', x_expand: true, height: 18, overlay_scrollbars: true,
        });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._registerScrollbarParts(scroll);
        const content = new St.BoxLayout({vertical: true, x_expand: true});
        scroll.set_child(content);
        const entry = new St.Entry({
            style_class: entryClass, accessible_name: this._t('accessibility.message'),
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.START,
        });
        const text = entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        for (const signal of ['text-changed', 'cursor-changed'])
            text.connect(signal, () => this._queueComposerLayout());
        for (const widget of [actor, scroll, entry])
            widget.connect('notify::allocation', () => this._queueComposerLayout());
        entry.connect('style-changed', () => this._queueComposerLayout());
        text.connect('key-press-event', (_actor, event) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter].includes(event.get_key_symbol()) ||
                event.get_state() & Clutter.ModifierType.SHIFT_MASK)
                return Clutter.EVENT_PROPAGATE;
            this._submit(entry);
            return Clutter.EVENT_STOP;
        });
        text.connect('activate', () => this._submit(entry));
        ShellEntry.addContextMenu(entry);
        this._translateEntryMenu(entry);
        this._styleContextMenu(entry.menu, actor);
        entry.menu.actor.connect('captured-event', (_actor, event) => this._dismissFocusOutside(event));
        content.add_child(entry);
        actor.add_child(scroll);
        const cancel = new St.Button({
            style_class: 'zaiko-input-cancel', label: this._t('action.stop'), can_focus: true,
            accessible_name: this._t('accessibility.cancel'), y_align: Clutter.ActorAlign.END, visible: false,
        });
        cancel.connect('clicked', () => this._cancel());
        actor.add_child(cancel);
        this._trackComposerFocus(actor, entry, cancel);
        const composer = {actor, entry, scroll, cancel};
        this._composers.push(composer);
        return composer;
    }

    _resizeComposer({actor, entry, scroll}) {
        if (!entry.mapped || entry.width <= 0)
            return;
        const node = entry.get_theme_node();
        const padding = side => node.get_padding(side);
        const width = Math.max(1, entry.width - padding(St.Side.LEFT) - padding(St.Side.RIGHT));
        const layout = entry.clutter_text.get_layout().copy();
        layout.set_single_paragraph_mode(false);
        layout.set_width(Math.round(width * Pango.SCALE));
        layout.set_text(entry.get_text() || ' ', -1);
        const [, contentHeight] = layout.get_pixel_size();
        // Reserve Thai upper/lower marks even in an empty or Latin-only row.
        // Shape with the current font so fallback fonts and scaling are included.
        const row = layout.copy();
        row.set_width(-1);
        row.set_text('Agที่ปู่', -1);
        const [, rowHeight] = row.get_pixel_size();
        const height = Math.max(contentHeight, rowHeight * layout.get_line_count());
        const composerNode = actor.get_theme_node();
        const chromeHeight = composerNode.get_padding(St.Side.TOP) + composerNode.get_padding(St.Side.BOTTOM);
        let available = Math.max(1, (this._workArea()?.height ?? 400) - 16 - chromeHeight);
        if (actor === this._logComposer) {
            const contentNode = this._panelContent.get_theme_node();
            const statusHeight = (this._logStatus.visible ? this._logStatus.height + 12 : 0) +
                (this._logFooter.visible ? this._logFooter.height + 4 : 0);
            // Reserve space for the transcript, with no fixed input row limit.
            available = this._panel.height - contentNode.get_padding(St.Side.TOP) -
                contentNode.get_padding(St.Side.BOTTOM) - chromeHeight - statusHeight - 12 - 40 - 2;
        }
        const scrollHeight = Math.max(1, Math.min(height + padding(St.Side.TOP) + padding(St.Side.BOTTOM), available));
        if (scroll.height !== scrollHeight)
            scroll.height = scrollHeight;
    }

    _queueComposerLayout() {
        if (this._composerLayoutSource)
            return;
        this._composerLayoutSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._composerLayoutSource = 0;
            if (this._enabled) {
                for (const composer of this._composers) {
                    this._resizeComposer(composer);
                    this._revealComposerCursor(composer);
                }
                const area = this._workArea();
                if (this._positioned && area)
                    this._positionSurfaces(area);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _revealComposerCursor({entry, scroll}) {
        if (!entry.mapped)
            return;
        const text = entry.clutter_text;
        const length = Array.from(text.text).length;
        const cursor = text.get_cursor_position();
        const [ok, , y, height] = text.position_to_coords(cursor < 0 ? length : Math.min(cursor, length));
        if (!ok)
            return;
        const adjustment = scroll.get_vadjustment();
        const top = y + entry.get_theme_node().get_padding(St.Side.TOP);
        if (top < adjustment.value)
            adjustment.value = Math.max(0, y);
        else if (top + height > adjustment.value + adjustment.page_size)
            adjustment.value = Math.max(0, Math.min(adjustment.upper - adjustment.page_size,
                top + height - adjustment.page_size));
    }

    _buildCompactActors() {
        const {actor, entry, scroll, cancel} = this._createComposer('zaiko-input-overlay', 'zaiko-overlay-entry');
        this._inputOverlay = actor;
        this._overlayEntry = entry;
        this._overlayInputScroll = scroll;
        this._overlayCancel = cancel;
        actor.width = 280;
        actor.hide();
        actor.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._hideInput(true);
            return Clutter.EVENT_STOP;
        });

        // The answer is a speech bubble sized to its text, with a small tail
        // drawn separately so it can point at the character's head.
        this._answerLabel = this._wrappedLabel('', 'zaiko-answer');
        this._answerMaxWidth = 320;
        // The tail overlaps the bubble's bottom border by 1 px so the border
        // opens into it, then draws its own two border edges.
        this._answerTail = new St.DrawingArea({
            width: ANSWER_TAIL_WIDTH, height: ANSWER_TAIL_HEIGHT + 1, visible: false,
        });
        this._answerTail.connect('repaint', area => {
            const cr = area.get_context();
            const [width, height] = area.get_surface_size();
            cr.moveTo(0, 0);
            cr.lineTo(width / 2, height - 1);
            cr.lineTo(width, 0);
            cr.closePath();
            cr.setSourceRGBA(40 / 255, 44 / 255, 52 / 255, 0.9);
            cr.fill();
            cr.setLineWidth(1);
            cr.moveTo(0.5, 0.5);
            cr.lineTo(width / 2, height - 1);
            cr.lineTo(width - 0.5, 0.5);
            cr.setSourceRGBA(0x3e / 255, 0x44 / 255, 0x51 / 255, 1);
            cr.stroke();
            cr.$dispose();
        });
        // St replaces foreground attributes when applying CSS; recolor after it.
        this._answerLabel.connect_after('style-changed', () => this._styleAnswerPrefix());
        this._answerLabel.reactive = true;
        this._answerLabel.visible = false;
        this._answerLabel.clip_to_allocation = true;
        this._answerLabel.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._releaseFocus(true, [this._answerLabel]);
            return Clutter.EVENT_STOP;
        });

        // A private point anchor keeps the character as the menu's focus owner
        // while BoxPointer positions/flips the popup in the pointer's work area.
        this._characterMenuAnchor = new St.Widget({width: 1, height: 1, opacity: 0, reactive: false});
        Main.uiGroup.add_child(this._characterMenuAnchor);
        this._characterMenu = new PopupMenu.PopupMenu(this._character, 0, St.Side.TOP);
        this._styleContextMenu(this._characterMenu, this._characterMenuAnchor);
        this._logMenuItem = this._characterMenu.addAction(this._t('menu.log'), () => this._showLog());
        // Log stays first and Quit last; the rows between are sorted A-Z by
        // their English names, in every language.
        this._sizeMenuItem = new ChoiceMenuItem(() => this._cycleCharacterSize());
        this._characterMenu.addMenuItem(this._sizeMenuItem);
        this._langMenuItem = new ChoiceMenuItem(() => this._toggleLanguage());
        this._characterMenu.addMenuItem(this._langMenuItem);
        this._vimMenuItem = new ChoiceMenuItem(() => this._toggleVim());
        this._characterMenu.addMenuItem(this._vimMenuItem);
        this._syncChoiceMenus();
        this._quitMenuItem = this._characterMenu.addAction(this._t('menu.quit'), () => this._quitCore());
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
            const source = global.stage.get_event_actor(event);
            if (event.get_button() !== Clutter.BUTTON_PRIMARY ||
                this._ownsFocus(source, [entry, sendButton]) || source instanceof St.ScrollBar)
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

    _setExpression(mood) {
        if (this._expression === mood)
            return;
        this._expression = mood;
        this._motion?.setBusy(mood === 'thinking' || mood === 'working');
        this._showNextFrame();
    }

    // Show another frame of the current mood, then schedule the next change.
    _showNextFrame() {
        if (this._frameCycleSource)
            GLib.Source.remove(this._frameCycleSource);
        this._frameCycleSource = 0;
        this._frame = pickFrame(this._expression, this._frame);
        this._drawFrame();
        this._motion?.pop();
        const delay = frameCycleDelay(this._expression);
        if (delay && this._motion) {
            this._frameCycleSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
                this._frameCycleSource = 0;
                this._showNextFrame();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _drawFrame() {
        const geometry = imageGeometry(this._characterBox.width, this._characterBox.height);
        this._body.set_size(this._characterBox.width, this._characterBox.height);
        const uri = this.dir.get_child('assets').get_child('aiko').get_child(this._frame).get_uri();
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
            ? Math.min(this._answerLabel.height + 8, Math.max(0, area.height - this._characterBox.height - 16)) : 0;
        const bounds = {x: area.x, y: area.y + reserve,
            width: area.width, height: area.height - reserve};
        const position = clampPosition(x, y, this._characterBox.width, this._characterBox.height, bounds);
        this._character.set_position(position.x, position.y);
        this._positionSurfaces(area);
    }

    _positionSurfaces(area) {
        const position = panelPosition({
            x: this._character.x, y: this._character.y,
            width: this._characterBox.width, height: this._characterBox.height,
        }, {width: this._panel.width, height: this._panel.height}, area);
        this._panel.set_position(position.x, position.y);
        const compact = compactPosition({
            x: this._character.x, y: this._character.y,
            width: this._characterBox.width, height: this._characterBox.height,
        }, {width: this._answerLabel.width, height: this._answerLabel.height + ANSWER_TAIL_HEIGHT - 8},
        {width: this._inputOverlay.width, height: this._inputOverlay.height}, area);
        this._inputOverlay.set_position(compact.input.x, compact.input.y);
        this._answerLabel.set_position(compact.answer.x, compact.answer.y);
        // Point the tail at the head, kept inside the bubble's rounded corners.
        const tailX = Math.round(Math.max(compact.answer.x + 14,
            Math.min(compact.answer.x + this._answerLabel.width - 14 - ANSWER_TAIL_WIDTH,
                this._character.x + (this._characterBox.width - ANSWER_TAIL_WIDTH) / 2)));
        this._answerTail.set_position(tailX, compact.answer.y + this._answerLabel.height - 1);
        for (const menu of this._commandMenus)
            menu.layout();
    }

    _layout() {
        const area = this._workArea();
        if (!area)
            return;
        this._panel.set_size(Math.min(360, Math.max(1, area.width - 16)),
            Math.min(400, Math.max(1, area.height - 16)));
        this._inputOverlay.width = Math.min(280, Math.max(1, area.width - 16));
        this._answerMaxWidth = Math.min(320, Math.max(1, area.width - 16));
        this._renderCompact();
        if (!this._positioned) {
            this._positionCharacter(area.x + area.width - this._characterBox.width - 24,
                area.y + area.height - this._characterBox.height - 16);
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
        this._motion?.setActive(show);
        this._panel.visible = show && this._panelOpen;
        if (this._panel.visible)
            this._panel.sync_hover();
        this._updatePanelClose();
        this._inputOverlay.visible = show && this._inputOpen && !this._logIsOpen();
        this._answerLabel.visible = show && this._answerHasText && !this._logIsOpen();
        this._answerTail.visible = this._answerLabel.visible;
        for (const menu of this._commandMenus)
            menu.sync();
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
        this._renderCompact();
        this._queueLogScroll(true);
        if (this._panel.visible)
            this._logEntry.grab_key_focus();
    }

    _logIsOpen() {
        return this._panelOpen;
    }

    _openCharacterMenu(point = null) {
        if (!this._character.visible)
            return;
        this._rememberFocus();
        const [x, y] = point ? [point.x, point.y] : global.get_pointer();
        this._characterMenuAnchor.set_position(Math.round(x), Math.round(y));
        // Reused popups must see the new point before their own allocation.
        this._characterMenuAnchor.allocate_preferred_size(Math.round(x), Math.round(y));
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
        this._logClick = null;
        this._panelOpen = false;
        this._vimInputs.find(vim => vim.entry === this._logEntry)?.leave();
        this._releaseFocus(true, [this._panel]);
        this._updateVisibility();
    }

    _hideInput(restore = false) {
        this._inputOpen = false;
        this._commandMenus.find(menu => menu.entry === this._overlayEntry)?.hide();
        this._releaseFocus(restore, [this._inputOverlay]);
        this._inputOverlay.hide();
    }

    _focusLogOnClick(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this._logClick = null;
            const source = global.stage.get_event_actor(event);
            if (!this._panel.contains(source) ||
                this._ownsFocus(source, [this._logComposer, this._panelClose, this._logBottom]))
                return;
            for (let actor = source; actor && actor !== this._panel; actor = actor.get_parent()) {
                if (actor instanceof St.ScrollBar)
                    return;
            }
            const [x, y] = event.get_coords();
            this._logClick = {x, y};
        } else if (this._logClick && type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            if (Math.hypot(x - this._logClick.x, y - this._logClick.y) > 6)
                this._logClick = null;
        } else if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY) {
            const click = this._logClick;
            this._logClick = null;
            const [x, y] = event.get_coords();
            // Wait for release so dragging a selection retains text focus.
            if (click && Math.hypot(x - click.x, y - click.y) <= 6 && this._panel.visible &&
                this._panel.contains(global.stage.get_event_actor(event)) &&
                !this._logHistory.get_children().some(label => label.clutter_text.get_selection())) {
                this._rememberFocus();
                this._logEntry.grab_key_focus();
            }
        }
    }

    _dismissFocusOutside(event) {
        if (this._selectionDrag && [Clutter.EventType.MOTION, Clutter.EventType.BUTTON_RELEASE].includes(event.type())) {
            const {text, anchor} = this._selectionDrag;
            text.set_selection(anchor, this._textPositionAtEvent(text, event));
            if (event.type() === Clutter.EventType.BUTTON_RELEASE)
                this._selectionDrag = null;
        }
        this._focusLogOnClick(event);
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
            const commands = this._commandMenus.find(candidate => candidate.entry.clutter_text === text);
            if (commands)
                roots.push(commands.actor);
            if (this._ownsFocus(source, roots))
                continue;
            if (text.get_selection()) {
                const cursor = text.get_cursor_position();
                text.set_selection(cursor, cursor);
            }
            const ownedFocus = this._ownsFocus(global.stage.get_key_focus(), roots);
            menu?.close();
            // A plain Log click returns to the composer on release. Keep its
            // focus during the press instead of briefly leaving the Log UI.
            if (ownedFocus && !(actor === this._logComposer && this._logClick))
                global.stage.set_key_focus(null);
        }
        if (this._inputOpen &&
            !this._ownsFocus(source, [this._inputOverlay, this._character, this._overlayEntry?.menu?.actor,
                ...this._commandMenus.filter(menu => menu.entry === this._overlayEntry).map(menu => menu.actor)]))
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
                    this._snapshotError = 'error.update';
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
        this._finishReveal(false);
        this._knownReplies = null;
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
            this._noticeNewReply();
            this._renderSnapshot();
        } catch (_error) {
            if (this._enabled && epoch === this._epoch) {
                this._snapshotError = 'error.connect';
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
            const placeholder = this._wrappedLabel(this._t('log.empty'), 'zaiko-placeholder');
            this._logHistory.add_child(placeholder);
        }
        for (const [index, message] of this._snapshot.messages.entries()) {
            const {prefix, text, color} = transcriptLine(message, {
                me: this._t('speaker.me'), action: this._t('speaker.action'),
            });
            const label = this._wrappedLabel(text, 'zaiko-log-message');
            this._makeMessageCopyable(label);
            label.clutter_text.set_line_alignment(Pango.Alignment.LEFT);
            let applyPrefix = null;
            if (color) {
                applyPrefix = () => {
                    const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) * 257);
                    const attribute = Pango.attr_foreground_new(...channels);
                    attribute.start_index = 0;
                    attribute.end_index = new TextEncoder().encode(prefix).length;
                    const attributes = label.clutter_text.get_attributes()?.copy() ?? Pango.AttrList.new();
                    attributes.change(attribute);
                    label.clutter_text.set_attributes(attributes);
                };
                // St replaces foreground attributes when applying CSS. Run after
                // its style handler, overriding only the prefix's UTF-8 byte range.
                // All message text remains literal; no markup is parsed.
                label.connect_after('style-changed', applyPrefix);
                applyPrefix();
            }
            if (this._reveal?.index === index) {
                Object.assign(this._reveal, {label, prefix, applyPrefix});
                label.text = `${prefix} ${this._reveal.typewriter.text}`;
                applyPrefix?.();
            }
            this._logHistory.add_child(label);
        }
        this._queueLogScroll();
    }

    // force jumps to the bottom even when the reader has scrolled up.
    _queueLogScroll(force = false) {
        if (force) {
            this._logFollow = true;
            this._logBottom.visible = false;
        }
        if (!this._logFollow)
            return;
        if (this._scrollSource)
            GLib.Source.remove(this._scrollSource);
        this._scrollSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollSource = 0;
            if (this._enabled && this._logFollow) {
                const adjustment = this._logScroll.get_vadjustment();
                adjustment.value = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderLogState() {
        const busy = this._busy();
        const error = this._uiError || this._snapshotError || this._snapshot.error ||
            (this._snapshot.state === 'error' ? 'error.generic' : null);
        const status = error ? this._t(error) : this._requestStatus();
        this._logStatus.text = status ? `[Aiko] ${status}` : '';
        this._logStatus.visible = Boolean(this._logStatus.text);
        this._logStatus.set_style_class_name(`zaiko-log-status${error ? ' zaiko-log-error' : ''}`);
        this._logModel.text = this._snapshot.model ?? '';
        for (const menu of this._commandMenus) {
            menu.setModels(this._snapshot.models ?? [], this._snapshot.model ?? '');
            menu.setPermissions(this._snapshot.permissions ?? '');
        }
        this._syncLogFooter();
        this._logCancel.visible = busy;
        this._logCancel.label = this._t(this._cancelling ? 'action.stopping' : 'action.stop');
        this._logCancel.reactive = Boolean(this._coreOwner && !this._cancelling);
        this._logCancel.can_focus = this._logCancel.reactive;
        this._setEntryAvailable(this._logEntry, Boolean(this._coreOwner && !busy));
    }

    _answerPrefixAttributes(attributes, text) {
        if (!text.startsWith('[Aiko]'))
            return attributes;
        const end = new TextEncoder().encode('[Aiko]').length;
        for (const attribute of [Pango.attr_foreground_new(0xc6 * 257, 0x78 * 257, 0xdd * 257),
            Pango.attr_weight_new(Pango.Weight.BOLD)]) {
            attribute.start_index = 0;
            attribute.end_index = end;
            attributes.change(attribute);
        }
        return attributes;
    }

    _styleAnswerPrefix() {
        const text = this._answerLabel?.clutter_text;
        if (!text)
            return;
        // Keep St's own attributes (the body color) and override only the prefix.
        const attributes = text.get_attributes()?.copy() ?? Pango.AttrList.new();
        text.set_attributes(this._answerPrefixAttributes(attributes, text.text));
    }

    _renderLogVimMode(mode) {
        if (!this._logVimMode)
            return;
        this._logVimMode.text = mode ? `--${mode === 'visual' ? 'VISUAL LINE' : mode.toUpperCase()}--` : '';
        this._logVimMode.set_style_class_name(`zaiko-vim-mode${mode ? ` zaiko-vim-${mode}` : ''}`);
        this._syncLogFooter();
    }

    _syncLogFooter() {
        const visible = Boolean(this._logModel.text || this._logVimMode.text);
        if (this._logFooter.visible === visible)
            return;
        this._logFooter.visible = visible;
        this._queueComposerLayout();
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

    // A printable character, or Ctrl+V / Ctrl+Shift+V / Shift+Insert.
    _typesText(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const control = state & Clutter.ModifierType.CONTROL_MASK;
        if (control && !(state & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)))
            return [Clutter.KEY_v, Clutter.KEY_V].includes(symbol);
        if (symbol === Clutter.KEY_Insert)
            return Boolean(state & Clutter.ModifierType.SHIFT_MASK);
        if (state & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK |
            Clutter.ModifierType.MOD4_MASK))
            return false;
        const character = event.get_key_unicode();
        return Boolean(character) && !/[\u0000-\u001f\u007f]/.test(character);
    }

    // Focus the Log input and replay the key through its capture, target and
    // bubble handlers, so Vim, the command picker and St paste all apply.
    _typeIntoLogInput(event) {
        const entry = this._logEntry;
        entry.grab_key_focus();
        if (!entry.event(event, true) && !entry.clutter_text.event(event, false))
            entry.event(event, false);
    }

    _makeMessageCopyable(label) {
        const text = label.clutter_text;
        label.reactive = true;
        label.can_focus = true;
        text.reactive = true;
        label.connect('captured-event', (_actor, event) => {
            // Track content and padding together, keeping release observable so
            // a plain click can focus the composer while a drag selects text.
            if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_PRIMARY)
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
            // Typing or pasting while a message is selected goes to the input.
            if (!this._typesText(event))
                return Clutter.EVENT_PROPAGATE;
            const cursor = text.get_cursor_position();
            text.set_selection(cursor, cursor);
            this._typeIntoLogInput(event);
            return Clutter.EVENT_STOP;
        });

        label.menu = new PopupMenu.PopupMenu(label, 0, St.Side.TOP);
        label.menu.focusActor = text;
        this._styleContextMenu(label.menu);
        label.menu.addAction(this._t('action.copy'), copy);
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
            return this._t('status.sending');
        if (this._snapshot.state === 'thinking') {
            const elapsed = this._thinkingStartedUs
                ? (GLib.get_monotonic_time() - this._thinkingStartedUs) / 1_000_000 : 0;
            return this._t('status.thinking', {elapsed: formatElapsed(elapsed, {
                hour: this._t('time.hour'), minute: this._t('time.minute'), second: this._t('time.second'),
            })});
        }
        return this._snapshot.state === 'working' ? this._t('status.opening') : '';
    }

    _renderCompact() {
        if (!this._answerLabel)
            return;
        const busy = this._busy();
        const error = this._uiError || this._snapshotError || this._snapshot.error ||
            (this._snapshot.state === 'error' ? 'error.generic' : null);
        const status = error ? null : this._requestStatus();
        const text = error ? this._t(error) : status || latestAssistant(this._snapshot.messages);
        // While a new reply types out, the hide timer waits for it to finish.
        const revealing = Boolean(this._reveal && !error && !status);
        const node = this._answerLabel.get_theme_node();
        const inset = side => node.get_padding(side) + node.get_border_width(side);
        const padX = inset(St.Side.LEFT) + inset(St.Side.RIGHT);
        const padY = inset(St.Side.TOP) + inset(St.Side.BOTTOM);
        const contentWidth = Math.max(1, this._answerMaxWidth - padX);
        const layout = this._answerLabel.clutter_text.get_layout().copy();
        layout.set_font_description(node.get_font());
        layout.set_single_paragraph_mode(false);
        const display = text ? `[Aiko] ${text}` : '';
        // Repaints, font changes and reopening input must not prolong a message.
        // The count also distinguishes a new reply with exactly the same text.
        const key = JSON.stringify([busy ? (error || (this._sending ? 'sending' : this._snapshot.state)) : error || display,
            this._snapshot.messages.filter(message => message.role === 'assistant').length, revealing]);
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
        // Log shows the full conversation, so a reply or error seen there
        // should not return outside after Log closes. Active status stays.
        if (this._logIsOpen() && display && (!busy || error)) {
            if (this._answerHideSource)
                GLib.Source.remove(this._answerHideSource);
            this._answerHideSource = 0;
            this._answerExpired = true;
        }
        // Shape the preview with the bold prefix it will be shown with.
        layout.set_attributes(this._answerPrefixAttributes(Pango.AttrList.new(), display));
        this._answerPreview = answerPreview(layout, display, contentWidth);
        this._answerLabel.text = this._answerPreview.text;
        this._answerLabel.accessible_name = display;
        this._styleAnswerPrefix();
        // Shrink short replies to the text's natural width. Measure the inner
        // text: the label itself reports the fixed size set last time.
        const answerText = this._answerLabel.clutter_text;
        const textWidth = Math.ceil(Math.min(contentWidth, answerText.get_preferred_width(-1)[1]));
        const textHeight = Math.ceil(answerText.get_preferred_height(textWidth)[1]);
        this._answerLabel.set_size(textWidth + padX, textHeight + padY);
        this._answerRevealing = revealing;
        this._showRevealInAnswer();
        this._answerHasText = Boolean(text) && !this._answerExpired;
        if (error)
            this._answerLabel.add_style_class_name('zaiko-answer-error');
        else
            this._answerLabel.remove_style_class_name('zaiko-answer-error');
        this._overlayCancel.visible = busy;
        this._overlayCancel.label = this._t(this._cancelling ? 'action.stopping' : 'action.stop');
        this._overlayCancel.reactive = Boolean(this._coreOwner && !this._cancelling);
        this._overlayCancel.can_focus = this._overlayCancel.reactive;
        this._setEntryAvailable(this._overlayEntry, Boolean(this._coreOwner && !busy));
        if (this._positioned)
            this._positionCharacter(this._character.x, this._character.y);
        this._updateVisibility();
    }

    // A reply that arrives while Zaiko runs types out; history loads at once.
    _noticeNewReply() {
        const messages = this._snapshot.messages;
        const replies = messages.filter(message => message.role === 'assistant').length;
        const known = this._knownReplies;
        this._knownReplies = replies;
        if (known === null || replies <= known)
            return;
        const index = messages.findLastIndex(message => message.role === 'assistant');
        this._finishReveal();
        if (!St.Settings.get().enable_animations || !messages[index].content)
            return;
        this._reveal = {index, content: messages[index].content, typewriter: new Typewriter(messages[index].content),
            label: null, prefix: '', applyPrefix: null};
        this._motion?.setTalking(true);
        this._revealSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            if (this._reveal.typewriter.advance()) {
                this._revealSource = 0;
                this._finishReveal();
                return GLib.SOURCE_REMOVE;
            }
            const {label, prefix, applyPrefix, typewriter} = this._reveal;
            if (label) {
                label.text = `${prefix} ${typewriter.text}`;
                applyPrefix?.();
                this._queueLogScroll();
            }
            this._showRevealInAnswer();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _showRevealInAnswer() {
        if (!this._reveal || !this._answerRevealing)
            return;
        const count = graphemes('[Aiko] ').length + this._reveal.typewriter.count;
        this._answerLabel.text = firstGraphemes(this._answerPreview.text, count);
        this._styleAnswerPrefix();
    }

    // Show the whole reply now. Pass false when its actors are going away.
    _finishReveal(render = true) {
        if (this._revealSource)
            GLib.Source.remove(this._revealSource);
        this._revealSource = 0;
        const reveal = this._reveal;
        this._reveal = null;
        this._motion?.setTalking(false);
        if (!reveal || !render)
            return;
        if (reveal.label) {
            reveal.label.text = `${reveal.prefix} ${reveal.content}`;
            reveal.applyPrefix?.();
        }
        this._renderCompact();
    }

    async _submit(entry = this._overlayEntry) {
        if (![this._overlayEntry, this._logEntry].includes(entry) ||
            (entry === this._overlayEntry && this._logIsOpen()))
            return;
        const text = entry.get_text().trim();
        if (!text || this._busy() || !this._coreOwner)
            return;
        // /exit is handled here, like the Quit menu, rather than by the core.
        if (text === '/exit') {
            entry.set_text('');
            if (!await this._quitCore() && this._enabled &&
                [this._overlayEntry, this._logEntry].includes(entry) && !entry.get_text())
                entry.set_text(text);
            return;
        }
        this._finishReveal();
        const epoch = this._epoch;
        const requestId = GLib.uuid_string_random();
        this._pendingRequestId = requestId;
        this._sending = true;
        this._uiError = null;
        entry.set_text('');
        this._queueLogScroll(true);
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
                this._uiError = 'error.send';
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
                this._uiError = 'error.cancel';
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
            return true;
        } catch (_error) {
            if (this._enabled && epoch === this._epoch) {
                this._uiError = 'error.quit';
                this._renderSnapshot();
            }
            return false;
        }
    }

    _openApp(alias, mode = 'default') {
        const candidates = Object.hasOwn(APP_IDS, alias) ? APP_IDS[alias] : null;
        if (!candidates)
            return [false, 'Unsupported app. Choose terminal or vscode.'];
        if (!Object.hasOwn(TERMINAL_ACTIONS, mode) || (alias !== 'terminal' && mode !== 'default'))
            return [false, 'Unsupported launch mode. Terminal modes: default, tab, standalone.'];
        const system = Shell.AppSystem.get_default();
        const app = candidates.map(id => system.lookup_app(id)).find(Boolean);
        if (!app)
            return [false, `${alias === 'terminal' ? 'zter' : 'VS Code'} is not installed or has no desktop launcher.`];
        try {
            const action = alias === 'terminal' ? TERMINAL_ACTIONS[mode] : APP_ACTIONS[alias];
            const info = app.get_app_info();
            if (action && !info.list_actions().includes(action))
                return [false, `${alias === 'terminal' ? 'zter' : 'VS Code'} has no ${action} desktop action. Update its desktop launcher.`];
            this._releaseFocus(false);
            if (action)
                app.launch_action(action, global.get_current_time(), -1);
            else if (!info.launch([], global.create_app_launch_context(global.get_current_time(), -1)))
                return [false, 'Could not request the primary zter terminal.'];
            if (alias === 'terminal' && mode !== 'standalone')
                this._focusPrimaryTerminal(app);
            const target = alias === 'vscode' ? 'New VS Code window' : {
                default: 'Primary zter terminal',
                tab: 'New tab in the primary zter terminal',
                standalone: 'New standalone zter window',
            }[mode];
            return [true, `${target} requested.`];
        } catch (_error) {
            return [false, `Could not request ${alias === 'terminal' ? 'zter' : 'VS Code'}.`];
        }
    }

    _focusPrimaryTerminal(app) {
        // Standalone windows share the app ID; match the primary GTK service owner.
        const busName = app.get_id().replace(/\.desktop$/, '');
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [busName]),
            new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 1000, null,
            (connection, result) => {
                try {
                    const [owner] = connection.call_finish(result).deep_unpack();
                    if (!this._enabled)
                        return;
                    const windows = app.get_windows().filter(window => window.get_gtk_unique_bus_name() === owner);
                    const workspace = global.workspace_manager.get_active_workspace();
                    const window = windows.find(candidate => candidate.has_focus()) ||
                        windows.find(candidate => candidate.get_workspace() === workspace) || windows[0];
                    if (window) {
                        if (window.minimized)
                            window.unminimize();
                        Main.activateWindow(window);
                    }
                } catch (_error) {
                    // Cold startup has no bus owner/window yet; zter presents it.
                }
            });
    }

    disable() {
        this._enabled = false;
        this._endCharacterDrag();
        this._selectionDrag = null;
        this._releaseFocus(false);
        this._characterMenu?.destroy();
        this._characterMenu = null;
        this._characterMenuManager = null;
        this._characterMenuAnchor?.destroy();
        this._characterMenuAnchor = null;
        this._sizeMenuItem = null;
        this._vimMenuItem = null;
        this._langMenuItem = null;
        this._logMenuItem = null;
        this._quitMenuItem = null;
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
        for (const menu of this._commandMenus ?? [])
            menu.destroy();
        this._commandMenus = [];
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
        if (this._composerLayoutSource)
            GLib.Source.remove(this._composerLayoutSource);
        this._composerLayoutSource = 0;
        if (this._frameCycleSource)
            GLib.Source.remove(this._frameCycleSource);
        this._frameCycleSource = 0;
        this._motion?.destroy();
        this._motion = null;
        for (const actor of [this._panel, this._character, this._inputOverlay, this._answerLabel, this._answerTail]) {
            if (!actor)
                continue;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._panel = null;
        this._panelContent = null;
        this._panelClose = null;
        this._logScroll = null;
        this._logBottom = null;
        this._logHistory = null;
        this._logComposer = null;
        this._logEntry = null;
        this._logInputScroll = null;
        this._logCancel = null;
        this._logFooter = null;
        this._logModel = null;
        this._logVimMode = null;
        this._logStatus = null;
        this._character = null;
        this._image = null;
        this._body = null;
        this._expression = null;
        this._frame = null;
        this._positioned = false;
        this._dragOrigin = null;
        this._focusBeforeUI = null;
        this._inputOverlay = null;
        this._overlayEntry = null;
        this._overlayInputScroll = null;
        this._overlayCancel = null;
        this._composers = [];
        this._answerLabel = null;
        this._answerTail = null;
        this._answerPreview = null;
    }
}
