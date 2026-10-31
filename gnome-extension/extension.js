import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {
    APP_IDS, CORE_BUS, CORE_PATH, DESKTOP_BUS, DESKTOP_PATH, DESKTOP_XML,
    chatPosition, clampPosition, expressionFor, isBusy, parseEvent, parseSnapshot,
} from './protocol.js';
import {EXPRESSIONS, imageGeometry} from './assets/manifest.js';

const CHARACTER_WIDTH = 200;
const CHARACTER_HEIGHT = 260;
const EMPTY_SNAPSHOT = {messages: [], state: 'idle', request_id: null, error: null};

export default class ZaikoExtension extends Extension {
    enable() {
        this._enabled = true;
        this._epoch = 0;
        this._coreOwner = null;
        this._snapshot = {...EMPTY_SNAPSHOT};
        this._chatOpen = false;
        this._sending = false;
        this._cancelling = false;
        this._snapshotRunning = false;
        this._snapshotDirty = false;
        this._signals = [];
        this._eventSubscription = 0;
        this._scrollSource = 0;
        this._uiError = null;
        this._snapshotError = null;
        this._historySignature = null;
        this._sessionCancellable = null;
        this._overviewShowing = Main.overview.visible;

        try {
            this._buildActors();
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

    _buildActors() {
        this._character = new St.Widget({
            style_class: 'zaiko-character',
            width: CHARACTER_WIDTH,
            height: CHARACTER_HEIGHT,
            reactive: true,
            clip_to_allocation: true,
            accessible_name: 'Zaiko — click to chat, drag to move',
            visible: false,
        });
        this._image = new St.Widget({reactive: false});
        this._character.add_child(this._image);
        this._setExpression('neutral');
        // GNOME 50 gesture arbitration cancels the click when the pan recognizes.
        // This avoids a stage-wide event handler or a modal keyboard grab.
        const click = new Clutter.ClickGesture();
        click.set_required_button(Clutter.BUTTON_PRIMARY);
        click.connect('recognize', () => this._toggleChat());
        this._character.add_action(click);
        const pan = new Clutter.PanGesture({
            required_button: Clutter.BUTTON_PRIMARY,
            min_n_points: 1,
            max_n_points: 1,
            begin_threshold: 8,
        });
        pan.connect('recognize', () => {
            this._dragOrigin = {x: this._character.x, y: this._character.y};
        });
        pan.connect('pan-update', gesture => {
            if (!this._dragOrigin)
                return;
            const delta = gesture.get_accumulated_delta_abs();
            this._positionCharacter(this._dragOrigin.x + delta.get_x(),
                this._dragOrigin.y + delta.get_y());
        });
        pan.connect('end', () => { this._dragOrigin = null; });
        pan.connect('cancel', () => { this._dragOrigin = null; });
        this._character.add_action(pan);

        this._chat = new St.BoxLayout({
            vertical: true, style_class: 'zaiko-chat', width: 360, height: 440,
            reactive: true, visible: false,
        });
        const header = new St.BoxLayout({style_class: 'zaiko-header'});
        header.add_child(new St.Label({
            text: 'Zaiko', style_class: 'zaiko-title', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._quit = this._button('Quit', () => this._quitCore(), 'zaiko-quiet');
        header.add_child(this._quit);
        header.add_child(this._button('×', () => this._hideChat(), 'zaiko-quiet', 'Hide chat'));
        this._chat.add_child(header);
        this._status = new St.Label({text: 'Ready', style_class: 'zaiko-status'});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._status.clutter_text.line_wrap = true;
        this._chat.add_child(this._status);
        this._scroll = new St.ScrollView({
            x_expand: true, y_expand: true, overlay_scrollbars: true,
        });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._history = new St.BoxLayout({vertical: true, style_class: 'zaiko-history', x_expand: true});
        this._scroll.set_child(this._history);
        this._chat.add_child(this._scroll);
        const composer = new St.BoxLayout({style_class: 'zaiko-composer'});
        this._entry = new St.Entry({
            style_class: 'zaiko-entry', hint_text: 'Message Zaiko…',
            can_focus: true, x_expand: true,
        });
        ShellEntry.addContextMenu(this._entry);
        this._entry.clutter_text.connect('activate', () => {
            if (!this._busy())
                this._submit();
        });
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._hideChat();
            return Clutter.EVENT_STOP;
        });
        composer.add_child(this._entry);
        this._send = this._button('Send', () => this._busy() ? this._cancel() : this._submit(), 'zaiko-primary');
        composer.add_child(this._send);
        this._chat.add_child(composer);
        this._chat.add_child(new St.Label({
            text: 'Click Aiko to hide chat · drag her to move', style_class: 'zaiko-hint',
        }));
        // Visibility is owned here, rather than trackFullscreen, which would
        // otherwise re-show a hidden actor when the core is absent.
        for (const actor of [this._character, this._chat])
            Main.layoutManager.addChrome(actor, {affectsStruts: false, trackFullscreen: false});
        this._renderSnapshot();
    }

    _button(label, callback, extraClass = '', accessibleName = label) {
        const button = new St.Button({
            label, style_class: `zaiko-button ${extraClass}`,
            can_focus: true, accessible_name: accessibleName,
        });
        button.connect('clicked', callback);
        return button;
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
        const position = clampPosition(x, y, CHARACTER_WIDTH, CHARACTER_HEIGHT, area);
        this._character.set_position(position.x, position.y);
        this._positionChat(area);
    }

    _positionChat(area) {
        const position = chatPosition({
            x: this._character.x, y: this._character.y,
            width: CHARACTER_WIDTH, height: CHARACTER_HEIGHT,
        }, {width: this._chat.width, height: this._chat.height}, area);
        this._chat.set_position(position.x, position.y);
    }

    _layout() {
        const area = this._workArea();
        if (!area)
            return;
        this._chat.set_size(Math.min(360, Math.max(240, area.width - 16)),
            Math.min(440, Math.max(240, area.height - 16)));
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
        if (!show)
            this._releaseFocus(false);
        this._character.visible = show;
        this._chat.visible = show && this._chatOpen;
    }

    _toggleChat() {
        if (this._chatOpen)
            this._hideChat();
        else
            this._present();
    }

    _present() {
        if (!this._enabled)
            return;
        const focus = global.stage.get_key_focus();
        if (!focus || !this._chat.contains(focus))
            this._focusBeforeChat = global.display.focus_window;
        this._chatOpen = true;
        this._updateVisibility();
        if (this._chat.visible)
            this._entry.grab_key_focus();
    }

    _releaseFocus(restore) {
        const focus = global.stage.get_key_focus();
        const ownedFocus = focus && (this._chat?.contains(focus) ||
            this._entry?.menu?.actor.contains(focus));
        this._entry?.menu?.close();
        if (!ownedFocus)
            return;
        global.stage.set_key_focus(null);
        if (restore && this._focusBeforeChat?.get_compositor_private())
            Main.activateWindow(this._focusBeforeChat);
    }

    _hideChat() {
        this._releaseFocus(true);
        this._chatOpen = false;
        this._chat.hide();
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
    }

    _coreVanished() {
        if (!this._enabled)
            return;
        this._clearCore();
        this._chatOpen = false;
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
        if (!this._chat)
            return;
        const busy = this._busy();
        const error = this._uiError || this._snapshotError || this._snapshot.error;
        const status = {idle: 'Ready', thinking: 'Thinking…', working: 'Opening app…', error: 'Something went wrong'};
        this._status.text = error || (this._sending ? 'Sending…' : status[this._snapshot.state]);
        this._status.set_style_class_name(`zaiko-status${error ? ' zaiko-error' : ''}`);
        this._send.label = this._cancelling ? 'Stopping…' : busy ? 'Cancel' : 'Send';
        this._send.reactive = Boolean(this._coreOwner && !this._cancelling);
        this._send.can_focus = this._send.reactive;
        this._entry.clutter_text.editable = Boolean(this._coreOwner && !busy);
        this._quit.reactive = Boolean(this._coreOwner);
        this._quit.can_focus = this._quit.reactive;
        this._setExpression(expressionFor(this._snapshot));
        const signature = JSON.stringify(this._snapshot.messages);
        if (signature === this._historySignature)
            return;
        this._historySignature = signature;
        this._history.destroy_all_children();
        if (!this._snapshot.messages.length) {
            const placeholder = this._wrappedLabel('Say hello, or ask me to open zter or VS Code.', 'zaiko-placeholder');
            this._history.add_child(placeholder);
        }
        for (const message of this._snapshot.messages) {
            const box = new St.BoxLayout({
                vertical: true, x_expand: true,
                style_class: `zaiko-message${message.role === 'user' ? ' zaiko-message-user' : ''}`,
            });
            box.add_child(new St.Label({
                text: message.role === 'user' ? 'You' : message.role === 'tool' ? 'Action' : 'Zaiko',
                style_class: 'zaiko-message-role',
            }));
            box.add_child(this._wrappedLabel(message.content, 'zaiko-message-content'));
            this._history.add_child(box);
        }
        if (this._scrollSource)
            GLib.Source.remove(this._scrollSource);
        this._scrollSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollSource = 0;
            if (this._enabled) {
                const adjustment = this._scroll.get_vadjustment();
                adjustment.value = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _wrappedLabel(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.selectable = true;
        return label;
    }

    async _submit() {
        const text = this._entry.get_text().trim();
        if (!text || this._busy() || !this._coreOwner)
            return;
        const epoch = this._epoch;
        const requestId = GLib.uuid_string_random();
        this._pendingRequestId = requestId;
        this._sending = true;
        this._uiError = null;
        this._entry.set_text('');
        this._renderSnapshot();
        try {
            await this._callCore('Submit', new GLib.Variant('(ss)', [requestId, text]));
        } catch (_error) {
            if (this._enabled && epoch === this._epoch) {
                this._uiError = 'Message could not be sent. Please try again.';
                if (!this._entry.get_text())
                    this._entry.set_text(text);
            }
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
        this._releaseFocus(false);
        this._clearCore();
        if (this._coreWatch)
            Gio.bus_unwatch_name(this._coreWatch);
        this._coreWatch = 0;
        this._desktopObject?.unexport();
        this._desktopObject = null;
        if (this._desktopName)
            Gio.bus_unown_name(this._desktopName);
        this._desktopName = 0;
        for (const [object, id] of this._signals ?? [])
            object.disconnect(id);
        this._signals = [];
        if (this._scrollSource)
            GLib.Source.remove(this._scrollSource);
        this._scrollSource = 0;
        for (const actor of [this._chat, this._character]) {
            if (!actor)
                continue;
            Main.layoutManager.removeChrome(actor);
            actor.destroy();
        }
        this._chat = null;
        this._character = null;
        this._image = null;
        this._expression = null;
        this._positioned = false;
        this._dragOrigin = null;
        this._focusBeforeChat = null;
    }
}
