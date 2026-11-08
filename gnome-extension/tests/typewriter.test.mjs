import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TICK_MS, Typewriter, firstGraphemes, graphemes} from '../typewriter.js';

function run(text) {
    const typewriter = new Typewriter(text);
    const steps = [typewriter.text];
    while (!typewriter.advance())
        steps.push(typewriter.text);
    steps.push(typewriter.text);
    return steps;
}

test('a reply types out in growing prefixes and ends with the full text', () => {
    const steps = run('Sure, opening the terminal.');
    assert.equal(steps[0], '');
    assert.equal(steps.at(-1), 'Sure, opening the terminal.');
    for (let i = 1; i < steps.length; i++)
        assert.ok(steps[i].startsWith(steps[i - 1]) && steps[i].length >= steps[i - 1].length);
});

test('Thai vowels and tone marks never appear without their letter', () => {
    const text = 'ได้เลยค่ะ กำลังเปิดเทอร์มินัลให้นะ 🙂';
    const parts = graphemes(text);
    for (const step of run(text))
        assert.ok(parts.some((_, count) => parts.slice(0, count).join('') === step) || step === text, step);
});

test('short replies type at about 50 characters a second; long ones finish within 2.5 s', () => {
    const short = run('x'.repeat(50)).length - 1;
    assert.ok(Math.abs(short * TICK_MS - 1000) <= TICK_MS * 2, `${short} ticks`);
    const long = run('y'.repeat(2000)).length - 1;
    assert.ok(long * TICK_MS <= 2500 + TICK_MS, `${long} ticks`);
});

test('firstGraphemes counts whole characters', () => {
    assert.equal(firstGraphemes('[Aiko] ค่ะ', 8), '[Aiko] ค่');
    assert.equal(firstGraphemes('abc', 10), 'abc');
    assert.equal(firstGraphemes('abc', -1), '');
});
