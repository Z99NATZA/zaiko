// Test-only session D-Bus service. It never opens an application.
const {Gio, GLib} = imports.gi;
const loop = new GLib.MainLoop(null, false);
const logPath = ARGV[0];
let records = [];
const xml = `<node><interface name="org.zaiko.Desktop">
  <method name="Present"/>
  <method name="OpenApp">
    <arg name="app" type="s" direction="in"/>
    <arg name="success" type="b" direction="out"/>
    <arg name="message" type="s" direction="out"/>
  </method>
</interface></node>`;

function record(value) {
    records.push(value);
    GLib.file_set_contents(logPath, JSON.stringify(records));
}

const object = Gio.DBusExportedObject.wrapJSObject(xml, {
    Present() {
        record({method: 'Present'});
    },
    OpenAppAsync([app], invocation) {
        record({method: 'OpenApp', app});
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            invocation.return_value(new GLib.Variant('(bs)', [
                app === 'terminal' || app === 'vscode',
                'QA fixture: activation requested; no GUI was opened.',
            ]));
            return GLib.SOURCE_REMOVE;
        });
    },
});

Gio.bus_own_name(Gio.BusType.SESSION, 'org.zaiko.Desktop',
    Gio.BusNameOwnerFlags.NONE,
    connection => object.export(connection, '/org/zaiko/Desktop'),
    () => {},
    () => { loop.quit(); });
loop.run();
