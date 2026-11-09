import test from 'node:test';
import assert from 'node:assert/strict';

import {commandMatches, SLASH_COMMANDS} from '../commands.js';

const models = ['gpt-6.1-sol', 'gpt-6.1-mini', 'deepseek-chat'];

test('/model with a space lists model names only, filtered by substring', () => {
    assert.deepEqual(commandMatches('/model ', SLASH_COMMANDS, models).map(match => match.name), models);
    assert.deepEqual(commandMatches('/model MINI', SLASH_COMMANDS, models),
        [{name: 'gpt-6.1-mini', description: '', model: true}]);
    assert.deepEqual(commandMatches('/model gpt x', SLASH_COMMANDS, models), []);
});

test('typing /model without a space still offers the command row', () => {
    assert.deepEqual(commandMatches('/mo', SLASH_COMMANDS, models).map(match => match.name), ['/model']);
    assert.deepEqual(commandMatches('/model', SLASH_COMMANDS, models).map(match => match.name), ['/model']);
});
