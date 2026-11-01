import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_APPEARANCE, parseAppearance, resolveAppearance} from '../themes.js';

test('appearance config tolerates missing, corrupt and unsupported values', () => {
    for (const text of [null, '', '{', 'null', '[]', '{"theme":"constructor","syncZhyprbola":"false"}'])
        assert.deepEqual(parseAppearance(text), DEFAULT_APPEARANCE);
    assert.deepEqual(parseAppearance('{"theme":"forest","syncZhyprbola":true,"unrelated":5}'),
        {theme: 'forest', syncZhyprbola: true});
});

test('sync is opt-in and never replaces the saved independent theme', () => {
    const settings = {theme: 'forest', syncZhyprbola: false};
    assert.equal(resolveAppearance(settings, 'white-sky\n').theme.id, 'forest');
    settings.syncZhyprbola = true;
    const appearance = resolveAppearance(settings, 'white-sky\n');
    assert.equal(appearance.theme.id, 'white-sky');
    assert.equal(appearance.synced, true);
    assert.equal(settings.theme, 'forest');
    settings.syncZhyprbola = false;
    assert.equal(resolveAppearance(settings, 'white-sky').theme.id, 'forest');
});

test('missing/unknown external themes fall back locally and legacy Sakura works', () => {
    const settings = {theme: 'red', syncZhyprbola: true};
    for (const text of [null, '', 'unsupported', 'constructor', 'forest; touch /tmp/file']) {
        const appearance = resolveAppearance(settings, text);
        assert.equal(appearance.theme.id, 'red');
        assert.equal(appearance.synced, false);
    }
    assert.equal(resolveAppearance(settings, 'rose-galaxy\n').theme.id, 'mauve');
});
