import assert from 'node:assert/strict';
import {test} from 'node:test';
import {APP_IDS, panelPosition, clampPosition, expressionFor, isBusy, parseEvent, parseSnapshot} from '../protocol.js';
import {EXPRESSIONS, imageGeometry} from '../assets/manifest.js';

test('snapshot preserves Thai conversation and ignores unrelated fields', () => {
    const snapshot = parseSnapshot(JSON.stringify({
        messages: [{role: 'user', content: 'เปิด terminal ให้หน่อย'}],
        state: 'thinking', request_id: 'request-1', error: null,
    }));
    assert.equal(snapshot.messages[0].content, 'เปิด terminal ให้หน่อย');
    assert.equal(snapshot.request_id, 'request-1');
    assert.equal(isBusy(snapshot), true);
    assert.throws(() => parseSnapshot('{"messages":[],"state":"unknown"}'));
    assert.throws(() => parseSnapshot('{"messages":[{}],"state":"idle"}'));
});

test('app aliases match the desktop contract and reject inherited properties', () => {
    assert.deepEqual(Object.keys(APP_IDS).sort(), ['terminal', 'vscode']);
    assert.equal(Object.hasOwn(APP_IDS, 'note'), false);
    assert.equal(Object.hasOwn(APP_IDS, 'constructor'), false);
    assert.equal(APP_IDS.terminal[0], 'io.github.z99natza.zter.desktop');
});

test('character and on-demand panel stay inside a work area with an offset', () => {
    const area = {x: 1920, y: 36, width: 1280, height: 1044};
    assert.deepEqual(clampPosition(9999, -999, 200, 260, area), {x: 2992, y: 44});
    const position = panelPosition({x: 1940, y: 800, width: 200, height: 260}, {width: 360, height: 440}, area);
    assert.ok(position.x >= area.x && position.x + 360 <= area.x + area.width);
    assert.ok(position.y >= area.y && position.y + 440 <= area.y + area.height);
});

test('events accept present and reject malformed or unknown updates', () => {
    assert.equal(parseEvent('{"type":"present"}').type, 'present');
    assert.throws(() => parseEvent('{"type":"launch_shell"}'));
    assert.throws(() => parseEvent('not JSON'));
});

test('all expression geometry shares the same bottom anchor without editing PNGs', () => {
    for (const expression of Object.values(EXPRESSIONS)) {
        const geometry = imageGeometry(expression, 200, 260);
        const scale = geometry.width / expression.width;
        const [left, top, right, bottom] = expression.bounds;
        assert.ok(geometry.x + left * scale >= 3.99);
        assert.ok(geometry.x + right * scale <= 196.01);
        assert.ok(geometry.y + top * scale >= 3.99);
        assert.ok(Math.abs(geometry.y + bottom * scale - 256) < 0.001);
    }
    assert.equal(expressionFor({state: 'error', messages: []}), 'sad');
    assert.equal(expressionFor({state: 'working', messages: []}), 'surprised');
});
