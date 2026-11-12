import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createTranslator, normalizeLanguage, LANGUAGES} from '../i18n.js';
import {translatedCommands, commandMatches} from '../commands.js';
import {transcriptLine, formatElapsed} from '../protocol.js';

const catalogs = Object.fromEntries(LANGUAGES.map(language => [language,
    JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url), 'utf8'))]));

test('Thai and English JSON catalogs have matching keys, strings and placeholders', () => {
    assert.deepEqual(Object.keys(catalogs.th).sort(), Object.keys(catalogs.en).sort());
    for (const key of Object.keys(catalogs.en)) {
        for (const language of LANGUAGES)
            assert.equal(typeof catalogs[language][key], 'string');
        assert.deepEqual(catalogs.th[key].match(/\{\w+\}/g), catalogs.en[key].match(/\{\w+\}/g));
    }
});

test('translations interpolate literal values and fall back to English or the key', () => {
    const th = createTranslator(catalogs, 'th');
    assert.equal(th('menu.language'), 'ภาษา');
    assert.equal(th('status.thinking', {elapsed: '$& <tag>'}), 'กำลังคิด... ($& <tag>)');
    assert.equal(th('status.thinking'), 'กำลังคิด... ({elapsed})');
    assert.equal(createTranslator({en: catalogs.en, th: {}}, 'th')('menu.quit'), 'Quit');
    assert.equal(th('unknown.key'), 'unknown.key');
    assert.equal(th('toString'), 'toString');
    assert.equal(normalizeLanguage('fr'), 'en');
    assert.equal(normalizeLanguage(null), 'en');
    assert.equal(createTranslator(catalogs, 'fr')('menu.quit'), 'Quit');
});

test('language changes descriptions, elapsed units and speaker labels without changing commands or content', () => {
    const en = createTranslator(catalogs, 'en');
    const th = createTranslator(catalogs, 'th');
    const english = translatedCommands(en);
    const thai = translatedCommands(th);
    assert.equal(english[0].name, '/status');
    assert.equal(thai[0].name, '/status');
    assert.notEqual(english[0].description, thai[0].description);
    assert.deepEqual(commandMatches('/sta', thai), [thai[0]]);
    assert.deepEqual(commandMatches('/mo', thai), [thai[1]]);
    assert.equal(thai[1].name, '/model');
    assert.notEqual(english[1].description, thai[1].description);
    assert.deepEqual(commandMatches('/p', thai), [thai[2]]);
    assert.equal(thai[2].name, '/permissions');
    assert.notEqual(english[2].description, thai[2].description);
    assert.deepEqual(commandMatches('/permissions ', thai).map(mode => mode.label),
        ['Ask for approval', 'Full Access']);
    assert.deepEqual(commandMatches('/c', thai).map(command => command.name), ['/clear', '/cls']);
    assert.equal(thai[3].description, thai[4].description);
    assert.notEqual(english[3].description, thai[3].description);
    assert.deepEqual(commandMatches('/v', thai), [thai[5]]);
    assert.equal(thai[5].name, '/vim');
    assert.notEqual(english[5].description, thai[5].description);
    assert.deepEqual(commandMatches('/ex', thai), [thai[6]]);
    assert.equal(thai[6].name, '/exit');
    assert.notEqual(english[6].description, thai[6].description);
    assert.equal(formatElapsed(7290, {hour: th('time.hour'), minute: th('time.minute'), second: th('time.second')}),
        '2ชม. 1นาที 30วินาที');
    const message = {role: 'user', content: '<tag> 🙂 ที่'};
    const line = transcriptLine(message, {me: th('speaker.me'), action: th('speaker.action')});
    assert.equal(line.text, '[ฉัน] <tag> 🙂 ที่');
    assert.equal(line.color, '#98c379');
    assert.equal(message.content, '<tag> 🙂 ที่');
});
