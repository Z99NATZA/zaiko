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

test('pending commands cancel on Escape and dd clears a single-line draft', () => {
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

test('dd deletes only the current logical line and keeps the remaining lines intact', () => {
    for (const [value, cursor, expected, position] of [
        ['hello\nworld', 10, 'hello', 0],
        ['hello\nworld', 2, 'world', 0],
        ['one\ntwo\nthree', 5, 'one\nthree', 4],
        ['one\ntwo\nthree', 10, 'one\ntwo', 4],
        ['one\n\nthree', 4, 'one\nthree', 4],
        ['\nworld', 0, 'world', 0],
        ['hello\n', 6, 'hello', 0],
        ['hello\nworld\n', 7, 'hello\n', 6],
        ['a\n\n\nb', 2, 'a\n\nb', 2],
        ['🙂ที่\nไทย', 6, '🙂ที่', 0],
        ['🙂ที่\nไทย', 2, 'ไทย', 0],
        ['hello', 3, '', 0],
        ['', 0, '', 0],
        ['\n', 0, '', 0],
        ['\n', 1, '', 0],
    ]) {
        const input = editor(value, cursor);
        input.keys('dd');
        assert.equal(input.text, expected, JSON.stringify({value, cursor}));
        assert.equal(input.cursor, position);
        assert.equal(input.vim.mode, 'normal');
        assert.equal(input.vim.pending, '');
    }
    const input = editor('one\ntwo\nthree', 5);
    input.keys('dddddd');
    assert.equal(input.text, '');
    assert.equal(input.cursor, 0);
});

test('o and O open logical lines above/below a Unicode draft and enter insert mode', () => {
    for (const [text, cursor, key, expected, position] of [
        ['alpha\nbeta\ngamma', 8, 'o', 'alpha\nbeta\n\ngamma', 11],
        ['alpha\nbeta\ngamma', 8, 'O', 'alpha\n\nbeta\ngamma', 6],
        ['alpha', 2, 'o', 'alpha\n', 6],
        ['alpha', 2, 'O', '\nalpha', 0],
        ['', 0, 'o', '\n', 1],
        ['', 0, 'O', '\n', 0],
        ['a\n\nb', 2, 'o', 'a\n\n\nb', 3],
        ['a\n\nb', 2, 'O', 'a\n\n\nb', 2],
        ['🙂ที่\nไทย', 2, 'o', '🙂ที่\n\nไทย', 5],
        ['🙂ที่\nไทย', 6, 'O', '🙂ที่\n\nไทย', 5],
    ]) {
        const input = editor(text, cursor);
        input.key(key);
        assert.equal(input.text, expected);
        assert.equal(input.cursor, position);
        assert.equal(input.vim.mode, 'insert');
        input.key('x');
        const inserted = Array.from(expected);
        inserted.splice(position, 0, 'x');
        assert.equal(input.text, inserted.join(''));
    }
});

test('Escape keeps the cursor on a newly opened blank line, including the last line', () => {
    const input = editor('first');
    input.key('o');
    input.key('Escape');
    assert.equal(input.cursor, 6);
    input.key('o');
    assert.equal(input.text, 'first\n\n');
    assert.equal(input.cursor, 7);
    input.key('Escape');
    input.key('O');
    assert.equal(input.text, 'first\n\n\n');
    assert.equal(input.cursor, 7);
    input.key('Escape');
    assert.equal(input.cursor, 7);
});
