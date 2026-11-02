import assert from 'node:assert/strict';
import {test} from 'node:test';
import {transcriptLine} from '../protocol.js';
import {THEMES, logPrefixColor} from '../themes.js';

test('transcript prefixes stay inline and preserve literal content', () => {
    const content = '<span color="red">ไทย & emoji 😊</span>\nsecond line';
    for (const [role, prefix] of [['user', '[Me]'], ['assistant', '[Aiko]'], ['tool', '[Action]']]) {
        const result = transcriptLine({role, content});
        assert.equal(result.prefix, prefix);
        assert.equal(result.text, `${prefix} ${content}`);
    }
});

function luminance(hex) {
    const rgb = [1, 3, 5].map(offset => {
        const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test('participant colors are distinct and readable in every Log palette', () => {
    for (const theme of THEMES) {
        const me = logPrefixColor(theme, 'user');
        const aiko = logPrefixColor(theme, 'assistant');
        assert.notEqual(me.toLowerCase(), aiko.toLowerCase());
        for (const color of [me, aiko]) {
            assert.match(color, /^#[0-9a-f]{6}$/i);
            assert.ok((luminance(theme.control) + 0.05) / (luminance(color) + 0.05) >= 4.5,
                `${theme.id} prefix must remain readable on Log`);
        }
        assert.equal(logPrefixColor(theme, 'tool'), null);
    }
});
