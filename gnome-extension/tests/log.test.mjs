import assert from 'node:assert/strict';
import {test} from 'node:test';
import {transcriptLine} from '../protocol.js';

test('transcript prefixes stay inline and preserve literal content', () => {
    const content = '<span color="red">ไทย & emoji 😊</span>\nsecond line';
    for (const [role, prefix] of [['user', '[Me]'], ['assistant', '[Aiko]'], ['tool', '[Action]']]) {
        const result = transcriptLine({role, content});
        assert.equal(result.prefix, prefix);
        assert.equal(result.text, `${prefix} ${content}`);
    }
});


test('speaker colors are fixed, distinct, and confined to participant prefixes', () => {
    const me = transcriptLine({role: 'user', content: 'hello'});
    const aiko = transcriptLine({role: 'assistant', content: 'hello'});
    assert.match(me.color, /^#[0-9a-f]{6}$/i);
    assert.match(aiko.color, /^#[0-9a-f]{6}$/i);
    assert.notEqual(me.color, aiko.color);
    assert.equal(transcriptLine({role: 'tool', content: 'result'}).color, null);
});
