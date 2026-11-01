import assert from 'node:assert/strict';
import {test} from 'node:test';
import {panelPosition, compactPosition, latestAssistant} from '../protocol.js';

test('on-demand panel stays near the character and fits the roomy side', () => {
    const panel = {width: 360, height: 400};
    const area = {x: 1920, y: 32, width: 1280, height: 900};
    const position = panelPosition({x: 1940, y: 400, width: 200, height: 260}, panel, area);
    assert.equal(position.x, 2152, 'use the right side of a character at the left edge');
    assert.equal(position.y + panel.height, 660, 'align the panel bottom with the character');
});

test('compact input overlays the character bottom while answer sits above the head', () => {
    const character = {x: 800, y: 500, width: 200, height: 260};
    const answer = {width: 320, height: 100};
    const input = {width: 280, height: 48};
    const positions = compactPosition(character, answer, input,
        {x: 0, y: 32, width: 1280, height: 900});
    assert.deepEqual(positions.input, {x: 760, y: 712});
    assert.deepEqual(positions.answer, {x: 740, y: 392});
    assert.equal(positions.input.y + input.height, character.y + character.height);
    assert.equal(positions.answer.y + answer.height, character.y - 8);
});

test('compact surfaces stay inside offset work areas at their edges', () => {
    const area = {x: 1920, y: 40, width: 500, height: 700};
    for (const [x, y] of [[1900, 20], [2400, 800]]) {
        const positions = compactPosition({x, y, width: 200, height: 260},
            {width: 320, height: 120}, {width: 280, height: 48}, area);
        for (const [key, size] of [['answer', {width: 320, height: 120}], ['input', {width: 280, height: 48}]]) {
            assert.ok(positions[key].x >= area.x + 8);
            assert.ok(positions[key].x + size.width <= area.x + area.width - 8);
            assert.ok(positions[key].y >= area.y + 8);
            assert.ok(positions[key].y + size.height <= area.y + area.height - 8);
        }
    }
});

test('answer preview chooses the latest assistant rather than user or app output', () => {
    assert.equal(latestAssistant([]), '');
    assert.equal(latestAssistant([{role: 'user', content: 'hello'}]), '');
    const messages = [
        {role: 'assistant', content: 'first'},
        {role: 'user', content: 'new question'},
        {role: 'assistant', content: 'คำตอบล่าสุด'},
        {role: 'tool', content: 'activation requested'},
        {role: 'user', content: 'next'},
    ];
    assert.equal(latestAssistant(messages), 'คำตอบล่าสุด');
});
