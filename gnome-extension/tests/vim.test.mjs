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

test('A appends at the end of the cursor line, not the whole draft', () => {
    for (const [text, cursor, expected] of [
        ['one\ntwo\nthree', 1, 'one!\ntwo\nthree'],
        ['one\ntwo\nthree', 5, 'one\ntwo!\nthree'],
        ['one\ntwo\nthree', 9, 'one\ntwo\nthree!'],
        ['one\n\nthree', 4, 'one\n!\nthree'],
        ['ไทย\nabc', 0, 'ไทย!\nabc'],
    ]) {
        const input = editor(text, cursor);
        input.keys('A!');
        assert.equal(input.text, expected, JSON.stringify({text, cursor}));
    }
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

test('dd on a wrapped line deletes only the displayed row under the cursor', () => {
    // Rows of five cells: 'alpha beta gamma' wraps as 'alpha', ' beta', ' gamm', 'a'.
    const measure = text => {
        const points = [];
        let row = 0, x = 0;
        for (const character of [...Array.from(text), '']) {
            points.push({x: x * 10, y: row * 20});
            if (character === '\n' || ++x === 5) {
                row++;
                x = 0;
            }
        }
        return position => points[position];
    };
    for (const [value, cursor, expected, position] of [
        ['abcdefghijkl', 2, 'fghijkl', 0],
        ['abcdefghijkl', 7, 'abcdekl', 5],
        ['abcdefghijkl', 11, 'abcdefghij', 9],
        ['abcdefgh\nxy', 6, 'abcde\nxy', 4],
        ['abcdefgh\nxy', 10, 'abcdefgh', 0],
        ['ab\nabcdefg', 4, 'ab\nfg', 3],
        ['abกี่de', 6, 'abกี่', 2],
    ]) {
        const vim = new InputVim();
        vim.handle(value, cursor, 'd', measure(value));
        const result = vim.handle(value, cursor, 'd', measure(value));
        assert.equal(result.text, expected, JSON.stringify({value, cursor}));
        assert.equal(result.cursor, position, JSON.stringify({value, cursor}));
        assert.equal(vim.mode, 'normal');
    }
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

test('j and k move between lines and keep the wanted column', () => {
    const input = editor('abcdef\nxy\n\nกขคงจ', 4);
    input.key('j'); assert.equal(input.cursor, 8);
    input.key('j'); assert.equal(input.cursor, 10);
    input.key('j'); assert.equal(input.cursor, 15);
    input.key('j'); assert.equal(input.cursor, 15);
    input.key('k'); assert.equal(input.cursor, 10);
    input.key('k'); assert.equal(input.cursor, 8);
    input.key('k'); assert.equal(input.cursor, 4);
    input.key('k'); assert.equal(input.cursor, 4);
    input.key('h'); input.key('j'); assert.equal(input.cursor, 8);
    assert.equal(input.text, 'abcdef\nxy\n\nกขคงจ');
});

test('j and k line up Thai text by visible cells, never landing on a combining mark', () => {
    // "ที่นี่" has 6 code points but 2 visible cells; "สวัสดี" has 6 code points, 4 cells.
    const input = editor('ที่นี่\nสวัสดี', 3);
    input.key('j'); assert.equal(input.cursor, 8);
    input.key('$'); input.key('k'); assert.equal(input.cursor, 3);
    input.key('j'); assert.equal(input.cursor, 11);
    const at = (text, cursor, key, measure) => new InputVim().handle(text, cursor, key, measure).cursor;
    assert.equal(at('ab\nxy', 1, 'j', position => position < 3
        ? {x: position * 10, y: 0} : {x: (position - 3) * 4, y: 20}), 4);
});

test('j and k follow rendered rows without newlines and stop at the first/last row', () => {
    const vim = new InputVim();
    const text = 'abcdefghijkl';
    const measure = position => ({x: position % 5 * 10, y: Math.floor(position / 5) * 20});
    let cursor = 3;
    for (const [key, expected] of [['k', 3], ['j', 8], ['j', 11], ['j', 11],
        ['k', 8], ['k', 3], ['k', 3]]) {
        const result = vim.handle(text, cursor, key, measure);
        assert.equal(result.cursor, expected);
        assert.equal(result.text, text);
        cursor = result.cursor;
    }
});

test('rendered motions cross wraps, hard breaks and blank lines while remembering x', () => {
    const vim = new InputVim();
    const text = 'abcdef\n\nxyz\n';
    const points = [
        [0, 0], [10, 0], [20, 0], [0, 20], [10, 20], [20, 20], [30, 20],
        [0, 40], [0, 60], [10, 60], [20, 60], [30, 60], [0, 80],
    ];
    const measure = position => ({x: points[position][0], y: points[position][1]});
    let cursor = 2;
    for (const [key, expected] of [['j', 5], ['j', 7], ['j', 10], ['j', 12],
        ['j', 12], ['k', 10], ['k', 7], ['k', 5], ['k', 2]]) {
        cursor = vim.handle(text, cursor, key, measure).cursor;
        assert.equal(cursor, expected);
    }
    // A horizontal move replaces the remembered column for the next motion.
    cursor = vim.handle(text, cursor, 'h', measure).cursor;
    assert.equal(vim.handle(text, cursor, 'j', measure).cursor, 4);
});

test('wrapped Thai rows skip combining marks and keep Unicode code point positions', () => {
    const vim = new InputVim();
    const text = '🙂กี่ขคุ่ง';
    const points = [[0, 0], [12, 0], [12, 0], [12, 0], [0, 20],
        [12, 20], [12, 20], [12, 20], [24, 20]];
    const measure = position => ({x: points[position][0], y: points[position][1]});
    assert.equal(vim.handle(text, 1, 'j', measure).cursor, 5);
    assert.equal(vim.handle(text, 5, 'k', measure).cursor, 1);
});

test('x deletes the character under the cursor and never joins lines', () => {
    const input = editor('abc');
    input.key('x');
    assert.equal(input.text, 'bc');
    assert.equal(input.cursor, 0);
    // At the line end the cursor steps back onto the new last character.
    input.keys('$x');
    assert.equal(input.text, 'b');
    assert.equal(input.cursor, 0);
    input.keys('xx');
    assert.equal(input.text, '');
    assert.equal(input.cursor, 0);

    const lines = editor('ab\n\ncd', 1);
    lines.key('x');
    assert.equal(lines.text, 'a\n\ncd');
    assert.equal(lines.cursor, 0);
    // An empty line has nothing to delete.
    lines.keys('jx');
    assert.equal(lines.text, 'a\n\ncd');

    // A Thai letter goes together with its combining vowel and tone marks.
    const thai = editor('กี่ข', 0);
    thai.key('x');
    assert.equal(thai.text, 'ข');
    const end = editor('ขกี่', 1);
    end.key('x');
    assert.equal(end.text, 'ข');
    assert.equal(end.cursor, 0);
});

test('gg and G jump to the first non-blank character of the first and last lines', () => {
    const input = editor('  one\ntwo\n  three', 7);
    input.key('G'); assert.equal(input.cursor, 12);
    input.keys('gg'); assert.equal(input.cursor, 2);
    input.key('g'); input.key('Escape');
    assert.equal(input.vim.pending, '');
    const blank = editor('a\nb\n', 0);
    blank.key('G'); assert.equal(blank.cursor, 4);
    blank.keys('gg'); assert.equal(blank.cursor, 0);
    assert.equal(blank.text, 'a\nb\n');
    // With a layout, G reaches the last displayed row of a wrapped last line.
    const measure = position => ({x: position % 5 * 10, y: Math.floor(position / 5) * 20});
    const vim = new InputVim();
    assert.equal(vim.handle('one\nabcdefghijkl', 0, 'G', measure).cursor, 15);
    assert.deepEqual(vim.handle('abcdefghijkl', 0, 'V', measure).selection, [0, 5]);
    assert.deepEqual(vim.handle('abcdefghijkl', 0, 'G', measure).selection, [0, 12]);
});

test('guiw, gUiw, guu and gUU change case of the word or row and stay in normal mode', () => {
    for (const [value, cursor, keys, expected, position] of [
        ['Hello WORLD ไทย', 8, 'guiw', 'Hello world ไทย', 6],
        ['hello world', 2, 'gUiw', 'HELLO world', 0],
        ['one\nTwo\nthree', 5, 'gUU', 'one\nTWO\nthree', 5],
        ['ONE\nTWO', 1, 'guu', 'one\nTWO', 1],
        ['ab-cd', 2, 'gUiw', 'ab-cd', 2],
    ]) {
        const input = editor(value, cursor);
        input.keys(keys);
        assert.equal(input.text, expected, JSON.stringify({value, keys}));
        assert.equal(input.cursor, position, JSON.stringify({value, keys}));
        assert.equal(input.vim.mode, 'normal');
        assert.equal(input.vim.pending, '');
    }
    // With a layout, guu and gUU change only the displayed row of a wrapped line.
    const measure = position => ({x: position % 5 * 10, y: Math.floor(position / 5) * 20});
    const vim = new InputVim();
    vim.handle('abcdefghij', 6, 'g', measure);
    vim.handle('abcdefghij', 6, 'U', measure);
    assert.deepEqual(vim.handle('abcdefghij', 6, 'U', measure), {handled: true, text: 'abcdeFGHIJ', cursor: 6});
});

test('V selects whole lines, follows motions and applies d, c, u, U and o', () => {
    const visual = (value, cursor, keys, measure = null) => {
        const vim = new InputVim();
        let state = {text: value, cursor};
        for (const key of keys) {
            state = vim.handle(state.text, state.cursor, key, measure);
            assert.equal(state.handled, true);
        }
        return {vim, ...state};
    };
    const text = 'one\ntwo\nthree\nfour';
    let state = visual(text, 5, ['V']);
    assert.equal(state.vim.mode, 'visual');
    assert.deepEqual(state.selection, [4, 7]);
    assert.deepEqual(visual(text, 5, ['V', 'j']).selection, [4, 13]);
    assert.deepEqual(visual(text, 5, ['V', 'k']).selection, [7, 0]);
    assert.deepEqual(visual(text, 5, ['V', 'G']).selection, [4, 18]);
    assert.deepEqual(visual(text, 9, ['V', 'g', 'g']).selection, [13, 0]);
    // o moves the cursor to the other end of the selection.
    state = visual(text, 5, ['V', 'j', 'o']);
    assert.deepEqual(state.selection, [13, 4]);
    assert.equal(state.cursor, 5);
    // Other keys do nothing and keep the selection.
    state = visual(text, 5, ['V', 'i', 'a', 'p']);
    assert.equal(state.vim.mode, 'visual');
    assert.equal(state.text, text);

    for (const [keys, expected, position, mode] of [
        [['V', 'j', 'd'], 'one\nfour', 4, 'normal'],
        [['V', 'G', 'x'], 'one', 0, 'normal'],
        [['V', 'k', 'U'], 'ONE\nTWO\nthree\nfour', 0, 'normal'],
        [['V', 'G', 'U'], 'one\nTWO\nTHREE\nFOUR', 4, 'normal'],
        [['V', 'j', 'c'], 'one\n\nfour', 4, 'insert'],
        [['V', 'j', 'Escape'], text, 9, 'normal'],
        [['V', 'j', 'V'], text, 9, 'normal'],
    ]) {
        state = visual(text, 5, keys);
        assert.equal(state.text, expected, JSON.stringify(keys));
        assert.equal(state.cursor, position, JSON.stringify(keys));
        assert.equal(state.vim.mode, mode, JSON.stringify(keys));
        assert.equal(state.selection, undefined);
    }
    // An empty row highlights its newline so the selection stays visible.
    assert.deepEqual(visual('a\n\nb', 2, ['V']).selection, [2, 3]);
    // With a layout, V selects displayed rows of a wrapped line.
    const measure = position => ({x: position % 5 * 10, y: Math.floor(position / 5) * 20});
    assert.deepEqual(visual('abcdefghijkl', 6, ['V'], measure).selection, [5, 10]);
    state = visual('abcdefghijkl', 6, ['V', 'j', 'd'], measure);
    assert.equal(state.text, 'abcde');
    assert.equal(state.cursor, 4);
});

test('u and Ctrl+R undo and redo commands, restoring the cursor', () => {
    const input = editor('one\ntwo', 5);
    input.keys('dd');
    assert.equal(input.text, 'one');
    input.key('u');
    assert.equal(input.text, 'one\ntwo');
    assert.equal(input.cursor, 5);
    input.key('C-r');
    assert.equal(input.text, 'one');
    input.key('C-r');
    assert.equal(input.text, 'one');
    input.key('u');
    input.key('u');
    assert.equal(input.text, 'one\ntwo');
    assert.equal(input.vim.mode, 'normal');
    // Pending commands and visual mode keep u as a case command.
    for (const [keys, changed] of [['guu', 'abc'], ['Vu', 'abc'], ['ru', 'uBC']]) {
        const cased = editor('ABC', 0);
        cased.keys(keys);
        assert.equal(cased.text, changed, keys);
        cased.key('u');
        assert.equal(cased.text, 'ABC', keys);
    }
});

test('an insert or replace session, with the command that began it, is one undo step', () => {
    const input = editor('ab', 0);
    input.keys('i');
    input.key('Escape');
    input.key('u');
    assert.equal(input.text, 'ab', 'Entering and leaving insert mode without typing adds no step');
    input.keys('Acde');
    input.key('Escape');
    input.keys('0x');
    assert.equal(input.text, 'bcde');
    input.key('u');
    assert.equal(input.text, 'abcde');
    input.key('u');
    assert.equal(input.text, 'ab');
    input.key('C-r');
    input.key('C-r');
    assert.equal(input.text, 'bcde');
    for (const [start, keys, typed] of [['one', 'otwo', 'one\ntwo'], ['one', 'ciwnew', 'new'],
        ['abcd', 'Rxy', 'xycd']]) {
        const session = editor(start, 0);
        session.keys(keys);
        session.key('Escape');
        assert.equal(session.text, typed, keys);
        session.key('u');
        assert.equal(session.text, start, keys);
        assert.equal(session.cursor, 0, keys);
    }
});

test('undo keeps the 10 latest steps and a new change clears redo', () => {
    const input = editor('abcdefghijklmnop', 0);
    for (let step = 0; step < 12; step++)
        input.key('x');
    assert.equal(input.text, 'mnop');
    for (let step = 0; step < 12; step++)
        input.key('u');
    assert.equal(input.text, 'cdefghijklmnop');
    input.key('x');
    input.key('C-r');
    assert.equal(input.text, 'defghijklmnop');
    // A change made outside Vim (such as sending the draft) is its own step.
    const vim = new InputVim();
    vim.handle('draft', 0, 'l');
    assert.deepEqual(vim.handle('', 0, 'u'), {handled: true, text: 'draft', cursor: 1});
});
