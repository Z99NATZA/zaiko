import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InputVim} from '../vim.js';

function editor(text, cursor = 0) {
    const vim = new InputVim();
    return {
        vim, text, cursor,
        key(key) {
            const result = vim.handle(this.text, this.cursor, key);
            if (result.handled) {
                this.text = result.text;
                this.cursor = result.cursor;
            } else if (Array.from(key).length === 1) {
                const characters = Array.from(this.text);
                characters.splice(this.cursor++, 0, key);
                this.text = characters.join('');
            }
            return result;
        },
        keys(keys) {
            for (const key of keys)
                this.key(key);
        },
    };
}

test('normal motions follow words, punctuation and Unicode code point positions', () => {
    const input = editor('งาน_ไทย abc-def 🙂');
    input.key('w'); assert.equal(input.cursor, 8);
    input.key('w'); assert.equal(input.cursor, 11);
    input.key('w'); assert.equal(input.cursor, 12);
    input.key('b'); assert.equal(input.cursor, 11);
    input.key('b'); assert.equal(input.cursor, 8);
    input.key('$'); assert.equal(input.cursor, 16);
    input.key('h'); assert.equal(input.cursor, 15);
    input.key('l'); assert.equal(input.cursor, 16);
    input.key('0'); assert.equal(input.cursor, 0);
    assert.equal(input.text, 'งาน_ไทย abc-def 🙂');
});

test('insert and append preserve drafts, and Escape moves back to the last edited character', () => {
    const input = editor('alpha beta');
    input.keys('iNEW ');
    assert.equal(input.text, 'NEW alpha beta');
    input.key('Escape');
    assert.equal(input.vim.mode, 'normal');
    assert.equal(input.cursor, 3);
    input.keys('0aX');
    input.key('Escape');
    assert.equal(input.text, 'NXEW alpha beta');
    input.keys('A 🙂');
    input.key('Escape');
    assert.equal(input.text, 'NXEW alpha beta 🙂');
    assert.equal(input.cursor, Array.from(input.text).length - 1);
});

test('ciw and C edit word boundaries without affecting neighboring text', () => {
    const input = editor('alpha beta tail');
    input.keys('wciwgamma');
    input.key('Escape');
    assert.equal(input.text, 'alpha gamma tail');
    input.keys('0wCend');
    input.key('Escape');
    assert.equal(input.text, 'alpha end');
    const thai = editor('งาน_ไทย abc-def 🙂');
    thai.keys('ciwtask');
    thai.key('Escape');
    assert.equal(thai.text, 'task abc-def 🙂');
});

test('single replace and continuous replace restore overwritten characters with Backspace', () => {
    const input = editor('alpha beta tail');
    input.keys('rX');
    assert.equal(input.text, 'Xlpha beta tail');
    assert.equal(input.cursor, 0);
    input.keys('RZQ');
    assert.equal(input.text, 'ZQpha beta tail');
    input.key('BackSpace');
    assert.equal(input.text, 'Zlpha beta tail');
    input.key('Escape');
    input.keys('$R🙂!');
    assert.equal(input.text, 'Zlpha beta tai🙂!');
    input.key('BackSpace');
    assert.equal(input.text, 'Zlpha beta tai🙂');
    input.key('BackSpace');
    assert.equal(input.text, 'Zlpha beta tail');
});

test('pending commands cancel on Escape and dd clears only the draft', () => {
    const input = editor('draft 🙂');
    input.key('d');
    input.key('Escape');
    assert.equal(input.text, 'draft 🙂');
    input.keys('dd');
    assert.equal(input.text, '');
    assert.equal(input.cursor, 0);
    input.keys('ifresh');
    assert.equal(input.text, 'fresh');
    input.key('Escape');
    input.vim.reset('insert');
    input.keys('!');
    assert.equal(input.text, 'fres!h');
});
