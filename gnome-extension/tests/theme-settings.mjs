// Real Gio filesystem/monitor integration, isolated from the user's config.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ThemeSettings} from '../themeSettings.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function pause(milliseconds) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function eventually(predicate, description) {
    for (let attempt = 0; attempt < 120; attempt++) {
        if (predicate())
            return;
        await pause(20);
    }
    throw new Error(`Timed out: ${description}`);
}

function write(path, text) {
    Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text),
        null, false, Gio.FileCreateFlags.PRIVATE, null);
}

function removeTree(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null)))
            removeTree(file.get_child(info.get_name()));
        children.close(null);
    }
    file.delete(null);
}

const root = GLib.dir_make_tmp('zaiko-theme-test-XXXXXX');
const externalDirectory = `${root}/zhyprbola`;
const externalPath = `${externalDirectory}/theme`;
const ownPath = `${root}/zaiko/ui.json`;
let notifications = 0;
let controller;
try {
    controller = new ThemeSettings(() => notifications++, root);
    controller.start();
    assert(controller.appearance.theme.id === 'current', 'Default Purple theme');
    controller.setTheme('forest');
    controller.setSync(true);
    assert(!GLib.file_test(externalDirectory, GLib.FileTest.EXISTS), 'Sync must not create zhyprbola files');
    assert(controller.appearance.theme.id === 'forest' && !controller.appearance.synced, 'Missing source fallback');

    GLib.mkdir_with_parents(externalDirectory, 0o700);
    write(externalPath, 'white-sky\n');
    await eventually(() => controller.appearance.theme.id === 'white-sky', 'source installed after sync enabled');
    controller.setTheme('red');
    assert(controller.settings.theme === 'forest', 'Manual selection cannot overwrite saved theme during sync');
    write(externalPath, 'mauve');
    await eventually(() => controller.appearance.theme.id === 'mauve', 'atomic source replacement');

    controller.setSync(false);
    assert(controller.appearance.theme.id === 'forest', 'Turning sync off restores independent theme');
    write(externalPath, 'red');
    await pause(180);
    assert(controller.appearance.theme.id === 'forest', 'Disabled sync ignores source changes');
    controller.destroy();
    controller = new ThemeSettings(() => notifications++, root);
    controller.start();
    assert(controller.settings.theme === 'forest' && !controller.settings.syncZhyprbola, 'Settings survive restart');
    controller.setSync(true);
    assert(controller.appearance.theme.id === 'red', 'Enabling sync reads the current source');

    Gio.File.new_for_path(externalDirectory).move(Gio.File.new_for_path(`${root}/old-source`),
        Gio.FileCopyFlags.NONE, null, null);
    await eventually(() => !controller.appearance.synced, 'source directory removal');
    GLib.mkdir_with_parents(externalDirectory, 0o700);
    write(externalPath, 'silver-dawn');
    await eventually(() => controller.appearance.theme.id === 'silver-dawn', 'source directory recreation');
    write(externalPath, 'unknown');
    await eventually(() => !controller.appearance.synced, 'invalid source fallback');
    assert(controller.appearance.theme.id === 'forest', 'Unknown theme keeps local fallback');

    write(ownPath, '{"theme":"white","syncZhyprbola":false}');
    await eventually(() => controller.appearance.theme.id === 'white', 'external settings edit');
    write(ownPath, '{');
    await eventually(() => controller.appearance.theme.id === 'current', 'malformed settings recovery');
    controller.setTheme('red');
    assert(controller.error === null && controller.appearance.theme.id === 'red', 'Saving repairs corrupt settings');
    assert(new TextDecoder().decode(GLib.file_get_contents(externalPath)[1]) === 'unknown', 'Source remains untouched');

    // A failed save must be visible, and must not claim that the theme changed.
    Gio.File.new_for_path(ownPath).delete(null);
    GLib.mkdir_with_parents(ownPath, 0o700);
    controller.setTheme('forest');
    assert(controller.error !== null && controller.appearance.theme.id === 'current', 'Save failure is reported');

    await pause(20);
    controller.destroy();
    const count = notifications;
    write(externalPath, 'red');
    await pause(180);
    assert(notifications === count, 'Destroy cancels queued callbacks and monitors');
    print('PASS appearance persistence, opt-in sync, live file/directory replacement, fallback and cleanup');
} finally {
    controller?.destroy();
    removeTree(Gio.File.new_for_path(root));
}
