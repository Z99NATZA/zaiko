// Input editing adapted from zhyprbola/components/TaskVim.js and Todo.qml.
// Clutter positions count Unicode code points, rather than UTF-16 code units.
const kind = character => /\s/u.test(character) ? 0 : /[\p{L}\p{M}\p{N}_]/u.test(character) ? 1 : 2;
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
    }

    handle(value, position, key) {
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
        if (key === 'o' || key === 'O') {
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
