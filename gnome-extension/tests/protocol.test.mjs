import assert from 'node:assert/strict';
import {test} from 'node:test';
import {APP_IDS, panelPosition, clampPosition, expressionFor, isBusy, parseEvent, parseSnapshot} from '../protocol.js';
import {existsSync} from 'node:fs';
import {CHARACTER_SIZES, EXPRESSIONS, FRAME, characterBox, frameCycleDelay, imageGeometry, nextCharacterSize,
    normalizeCharacterSize, pickFrame} from '../assets/manifest.js';

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

test('every mood has frames on disk and moods follow the companion state', () => {
    for (const frames of Object.values(EXPRESSIONS)) {
        assert.ok(frames.length > 0);
        for (const frame of frames)
            assert.ok(existsSync(new URL(`../assets/aiko/${frame}`, import.meta.url)), frame);
    }
    assert.equal(expressionFor({state: 'error', messages: []}), 'error');
    assert.equal(expressionFor({state: 'thinking', messages: []}), 'thinking');
    assert.equal(expressionFor({state: 'working', messages: []}), 'working');
    assert.equal(expressionFor({state: 'idle', messages: [{role: 'assistant', content: 'hi'}]}), 'happy');
    assert.equal(expressionFor({state: 'idle', messages: []}), 'neutral');
});

test('a new pick avoids repeating the previous frame when the mood has others', () => {
    for (const [mood, frames] of Object.entries(EXPRESSIONS)) {
        for (const value of [0, 0.5, 0.999999]) {
            const frame = pickFrame(mood, frames[0], () => value);
            assert.ok(frames.includes(frame));
            if (frames.length > 1)
                assert.notEqual(frame, frames[0]);
        }
    }
    assert.ok(EXPRESSIONS.neutral.includes(pickFrame('unknown')));
});

test('frames keep their aspect and rest on the bottom edge at every character size', () => {
    for (const size of CHARACTER_SIZES) {
        const box = characterBox(size);
        const geometry = imageGeometry(box.width, box.height);
        assert.ok(Math.abs(geometry.width / geometry.height - FRAME.width / FRAME.height) < 1e-9);
        assert.ok(geometry.x >= 3.99 && geometry.x + geometry.width <= box.width - 3.99);
        assert.ok(geometry.y >= 3.99);
        assert.ok(Math.abs(geometry.y + geometry.height - box.height) < 1e-9);
    }
    for (let size = 1; size < CHARACTER_SIZES.length; size++)
        assert.ok(characterBox(size).width < characterBox(size + 1).width);
});

test('frames rotate quickly while thinking, slowly otherwise, and never with one frame', () => {
    assert.deepEqual([0, 0.5, 0.999].map(value => frameCycleDelay('thinking', () => value)), [4, 5, 6]);
    for (const mood of ['neutral', 'happy', 'error'])
        assert.deepEqual([0, 0.5, 1].map(value => frameCycleDelay(mood, () => value)), [20, 30, 40]);
    assert.equal(frameCycleDelay('working', () => 0.5), 0);
});

test('character size cycles 1 to 5 and falls back to 3', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(nextCharacterSize), [2, 3, 4, 5, 1]);
    assert.equal(normalizeCharacterSize('5\n'), 5);
    for (const value of [null, undefined, '', '0', '6', '2.5', 'big'])
        assert.equal(normalizeCharacterSize(value), 3);
    assert.equal(nextCharacterSize('junk'), 4);
    assert.deepEqual(characterBox(3), {width: 312, height: 235});
});
