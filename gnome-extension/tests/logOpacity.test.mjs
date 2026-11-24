import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
    DEFAULT_LOG_OPACITY, logOpacityFromSlider, logOpacityToSlider, logSurfaceStyle, normalizeLogOpacity,
} from '../logOpacity.js';

test('log opacity defaults to the documented 90% and clamps to 50-100', () => {
    assert.equal(DEFAULT_LOG_OPACITY, 90);
    assert.equal(normalizeLogOpacity(null), 90);
    assert.equal(normalizeLogOpacity('abc'), 90);
    assert.equal(normalizeLogOpacity(' 70\n'), 70);
    assert.equal(normalizeLogOpacity('10'), 50);
    assert.equal(normalizeLogOpacity('300'), 100);
});

test('log opacity keeps whole percents, so a drag can move it one point at a time', () => {
    assert.equal(normalizeLogOpacity('72'), 72);
    assert.equal(normalizeLogOpacity('78'), 78);
});

test('dragging maps 0-1 onto 50-100 one whole percent at a time', () => {
    assert.equal(logOpacityFromSlider(0), 50);
    assert.equal(logOpacityFromSlider(1), 100);
    assert.equal(logOpacityFromSlider(0.5), 75);
    assert.equal(logOpacityFromSlider(0.502), 75);
    assert.equal(logOpacityFromSlider(0.51), 76);
    assert.equal(logOpacityFromSlider(2), 100);
    assert.equal(logOpacityToSlider(50), 0);
    assert.equal(logOpacityToSlider(100), 1);
    assert.equal(logOpacityFromSlider(logOpacityToSlider(72)), 72);
});

test('log surface style keeps the One Half Dark color and changes only alpha', () => {
    assert.equal(logSurfaceStyle(90), 'background-color: rgba(40, 44, 52, 0.90);');
    assert.equal(logSurfaceStyle(50), 'background-color: rgba(40, 44, 52, 0.50);');
});
