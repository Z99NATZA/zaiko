// Run with gjs -m after adding the installed GNOME Shell typelib/library paths.
// This inspects APIs and XML only; it does not start Shell or construct UI actors.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {APP_IDS, DESKTOP_XML, parseSnapshot} from '../protocol.js';

function assert(condition, description) {
    if (!condition)
        throw new Error(description);
}

for (const [object, method] of [
    [Clutter.Stage.prototype, 'grab'],
    [Clutter.Grab.prototype, 'dismiss'],
    [Clutter.Grab.prototype, 'is_revoked'],
    [Clutter.Event.prototype, 'get_source_device'],
    [Clutter.ClickGesture.prototype, 'set_required_button'],
    [St.ScrollView.prototype, 'set_child'],
    [St.ScrollView.prototype, 'get_vadjustment'],
    [St.Entry.prototype, 'get_text'],
    [Shell.AppSystem.prototype, 'lookup_app'],
    [Shell.App.prototype, 'get_app_info'],
    [Shell.App.prototype, 'launch_action'],
    [GioUnix.DesktopAppInfo.prototype, 'list_actions'],
])
    assert(typeof object[method] === 'function', `Required GNOME API: ${method}`);

const node = Gio.DBusNodeInfo.new_for_xml(DESKTOP_XML);
const iface = node.interfaces[0];
assert(iface.name === 'org.zaiko.Desktop', 'Desktop interface name');
const method = iface.methods.find(item => item.name === 'OpenApp');
assert(method.in_args.map(arg => arg.signature).join('') === 's', 'OpenApp input signature');
assert(method.out_args.map(arg => arg.signature).join('') === 'bs', 'OpenApp output signature');
assert(Object.hasOwn(APP_IDS, 'terminal') && !Object.hasOwn(APP_IDS, 'note'), 'Supported app aliases');
assert(parseSnapshot('{"messages":[],"state":"idle"}').state === 'idle', 'GJS JSON contract');
assert(new GLib.Variant('(ss)', ['request-id', 'สวัสดี']).deep_unpack()[1] === 'สวัสดี', 'Thai D-Bus text');
print('GNOME API and desktop D-Bus contract checks passed (no Shell session started).');
