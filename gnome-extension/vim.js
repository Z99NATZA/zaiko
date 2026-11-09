// Input editing adapted from zhyprbola/components/TaskVim.js and Todo.qml.
// Clutter positions count Unicode code points, rather than UTF-16 code units.
const kind = character => /\s/u.test(character) ? 0 : /[\p{L}\p{M}\p{N}_]/u.test(character) ? 1 : 2;
const mark = character => /\p{M}/u.test(character ?? '');
const normal = (characters, cursor) => Math.max(0,
    Math.min(cursor, characters.length - (characters.at(-1) === '\n' ? 0 : 1)));

export class InputVim {
    constructor() {
        this.reset();
    }

    reset(mode = 'normal') {
        this.mode = mode;
        this.pending = '';
        this.history = [];
        this.column = null;
    }

    // measure(position) optionally gives the on-screen x of a position.
    handle(value, position, key, measure = null) {
        const characters = Array.from(value);
        let cursor = position < 0 ? characters.length : position;
        const result = () => ({handled: true, text: characters.join(''), cursor});
        if (key === 'Escape') {
            if (this.mode !== 'normal' && cursor > 0 && characters[cursor - 1] !== '\n')
                cursor--;
            this.reset();
            cursor = normal(characters, cursor);
            return result();
        }
        if (this.mode === 'insert')
            return {handled: false};
        if (this.mode === 'replace') {
            if (key === 'BackSpace' && this.history.length) {
                const edit = this.history.pop();
                characters.splice(edit.position, 1, ...edit.removed);
                cursor = edit.position;
            } else if (Array.from(key).length === 1 && key.codePointAt(0) >= 32) {
                this.history.push({position: cursor, removed: characters.slice(cursor, cursor + 1)});
                characters.splice(cursor, 1, key);
                cursor++;
            } else {
                this.history = [];
                return {handled: false};
            }
            return result();
        }
        cursor = normal(characters, cursor);
        const column = this.column;
        this.column = null;
        if (this.pending) {
            const command = this.pending + key;
            this.pending = '';
            if (command === 'dd') {
                let start = cursor;
                let end = cursor;
                while (start > 0 && characters[start - 1] !== '\n')
                    start--;
                while (end < characters.length && characters[end] !== '\n')
                    end++;
                if (end < characters.length) {
                    // Include the following newline so adjacent lines stay separate.
                    characters.splice(start, end - start + 1);
                    cursor = start;
                } else {
                    // The last line has no terminator; remove its preceding newline.
                    const from = Math.max(0, start - 1);
                    characters.splice(from, end - from);
                    cursor = from;
                    while (cursor > 0 && characters[cursor - 1] !== '\n')
                        cursor--;
                }
            } else if (command === 'ci') {
                this.pending = 'ci';
            } else if (command === 'ciw') {
                let start = cursor;
                let end = Math.min(characters.length, cursor + 1);
                const wordKind = kind(characters[cursor] ?? '');
                while (start > 0 && kind(characters[start - 1]) === wordKind)
                    start--;
                while (end < characters.length && kind(characters[end]) === wordKind)
                    end++;
                characters.splice(start, end - start);
                cursor = start;
                this.reset('insert');
            } else if (command.startsWith('r') && Array.from(key).length === 1 &&
                key.codePointAt(0) >= 32 && characters.length) {
                characters[cursor] = key;
            }
            return result();
        }
        if (key === 'j' || key === 'k') {
            let start = cursor;
            while (start > 0 && characters[start - 1] !== '\n')
                start--;
            // Combining marks share a cell with the letter before them, so the
            // cursor never stops on one. Without a layout, count visible cells.
            const x = measure ?? (position => {
                let line = position;
                while (line > 0 && characters[line - 1] !== '\n')
                    line--;
                return characters.slice(line, position).filter(c => !mark(c)).length;
            });
            // Like Vim, remember the wanted column across short lines.
            this.column = column ?? x(cursor);
            let target;
            if (key === 'j') {
                target = start;
                while (target < characters.length && characters[target] !== '\n')
                    target++;
                if (target === characters.length)
                    return result();
                target++;
            } else {
                if (start === 0)
                    return result();
                target = start - 1;
                while (target > 0 && characters[target - 1] !== '\n')
                    target--;
            }
            let end = target;
            while (end < characters.length && characters[end] !== '\n')
                end++;
            cursor = target;
            let distance = Infinity;
            for (let position = target; position < Math.max(target + 1, end); position++) {
                if (position > target && mark(characters[position]))
                    continue;
                const offset = Math.abs(x(position) - this.column);
                if (offset < distance) {
                    distance = offset;
                    cursor = position;
                }
            }
        } else if (key === 'o' || key === 'O') {
            if (key === 'o') {
                while (cursor < characters.length && characters[cursor] !== '\n')
                    cursor++;
                characters.splice(cursor, 0, '\n');
                cursor++;
            } else {
                while (cursor > 0 && characters[cursor - 1] !== '\n')
                    cursor--;
                characters.splice(cursor, 0, '\n');
            }
            this.reset('insert');
        } else if (['h', 'Left', 'BackSpace'].includes(key)) {
            cursor = Math.max(0, cursor - 1);
        } else if (['l', 'Right', ' '].includes(key)) {
            cursor = normal(characters, cursor + 1);
        } else if (['0', 'Home'].includes(key)) {
            cursor = 0;
        } else if (['$', 'End'].includes(key)) {
            cursor = normal(characters, characters.length);
        } else if (key === 'w') {
            const wordKind = kind(characters[cursor] ?? '');
            while (cursor < characters.length && kind(characters[cursor]) === wordKind)
                cursor++;
            while (cursor < characters.length && kind(characters[cursor]) === 0)
                cursor++;
            cursor = normal(characters, cursor);
        } else if (key === 'b') {
            cursor = Math.max(0, cursor - 1);
            while (cursor > 0 && kind(characters[cursor]) === 0)
                cursor--;
            const wordKind = kind(characters[cursor] ?? '');
            while (cursor > 0 && kind(characters[cursor - 1]) === wordKind)
                cursor--;
        } else if (key === 'x') {
            // Delete the character under the cursor with its combining marks,
            // never the line break; at the line end, step back like Vim.
            if (cursor < characters.length && characters[cursor] !== '\n') {
                let end = cursor + 1;
                while (end < characters.length && mark(characters[end]))
                    end++;
                characters.splice(cursor, end - cursor);
                if ((cursor === characters.length || characters[cursor] === '\n') &&
                    cursor > 0 && characters[cursor - 1] !== '\n') {
                    cursor--;
                    while (cursor > 0 && mark(characters[cursor]))
                        cursor--;
                }
            }
        } else if (['i', 'a', 'A', 'C', 'R'].includes(key)) {
            this.reset(key === 'R' ? 'replace' : 'insert');
            if (key === 'a')
                cursor = Math.min(characters.length, cursor + 1);
            else if (key === 'A')
                cursor = characters.length;
            else if (key === 'C')
                characters.splice(cursor);
        } else if (['d', 'c', 'r'].includes(key)) {
            this.pending = key;
        }
        return result();
    }
}
