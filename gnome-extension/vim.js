// Input editing adapted from zhyprbola/components/TaskVim.js and Todo.qml.
// Clutter positions count Unicode code points, rather than UTF-16 code units.
const kind = character => /\s/u.test(character) ? 0 : /[\p{L}\p{M}\p{N}_]/u.test(character) ? 1 : 2;
const mark = character => /\p{M}/u.test(character ?? '');
const normal = (characters, cursor) => Math.max(0,
    Math.min(cursor, characters.length - (characters.at(-1) === '\n' ? 0 : 1)));

// The logical line [start, end) around a position; end is its newline or the end.
function line(characters, position) {
    let start = position;
    let end = position;
    while (start > 0 && characters[start - 1] !== '\n')
        start--;
    while (end < characters.length && characters[end] !== '\n')
        end++;
    return [start, end];
}

// The displayed row [from, to) around a position. With a layout, a wrapped
// line has several rows; without one, each logical line is a single row.
function row(characters, position, measure) {
    const [start, end] = line(characters, position);
    if (!measure)
        return [start, end];
    const y = measure(position).y;
    let from = position;
    let to = position;
    while (from > start && measure(from - 1).y === y)
        from--;
    while (to < end && measure(to).y === y)
        to++;
    return [from, to];
}

// The inner word (or run of spaces or punctuation) under the cursor.
function word(characters, cursor) {
    let start = cursor;
    let end = Math.min(characters.length, cursor + 1);
    const wordKind = kind(characters[cursor] ?? '');
    while (start > 0 && kind(characters[start - 1]) === wordKind)
        start--;
    while (end < characters.length && kind(characters[end]) === wordKind)
        end++;
    return [start, end];
}

const firstNonBlank = (characters, position) => {
    while (position < characters.length && /[ \t]/.test(characters[position]))
        position++;
    return normal(characters, position);
};

// Deletes the rows [from, to) and returns the new cursor. Whole logical lines
// go with one newline so the other lines stay separate, like Vim's dd; part
// of a wrapped line loses only those rows and the rest of it reflows.
function deleteRows(characters, from, to) {
    const [start] = line(characters, from);
    const [, end] = line(characters, to);
    if (from > start || to < end) {
        characters.splice(from, to - from);
        let cursor = from;
        const [lineStart, lineEnd] = line(characters, from);
        // After the last row, rest on the end of the row above.
        if (cursor === lineEnd && cursor > lineStart) {
            cursor--;
            while (cursor > lineStart && mark(characters[cursor]))
                cursor--;
        }
        return cursor;
    }
    if (end < characters.length) {
        characters.splice(start, end - start + 1);
        return start;
    }
    // The last line has no terminator; remove its preceding newline.
    const before = Math.max(0, start - 1);
    characters.splice(before, end - before);
    return line(characters, before)[0];
}

function changeCase(characters, from, to, upper) {
    const text = characters.slice(from, to).join('');
    characters.splice(from, to - from, ...Array.from(upper ? text.toUpperCase() : text.toLowerCase()));
}

const UNDO_LIMIT = 10;
export const SENT_LIMIT = 10;

// Adds a sent draft as the newest entry, dropping an older copy of it and
// anything past the limit, so the list holds the latest distinct drafts.
// Slash commands (a first word starting with /, as the core reads them) are
// not messages and stay out.
export function rememberSent(sent, text) {
    if (text.trimStart().startsWith('/'))
        return;
    const index = sent.indexOf(text);
    if (index >= 0)
        sent.splice(index, 1);
    sent.push(text);
    if (sent.length > SENT_LIMIT)
        sent.splice(0, sent.length - SENT_LIMIT);
}

export class InputVim {
    // sent lists earlier drafts, oldest first; inputs may share one list.
    constructor(sent = []) {
        this.sent = sent;
        this.forgetRecall();
        this.reset();
        // Undo steps are {text, cursor} snapshots; saved is the text as of the
        // last step, so edits made outside Vim commands are noticed later.
        this.undos = [];
        this.redos = [];
        this.saved = null;
    }

    // recalled is the index in sent shown in place of draft, or null for the
    // draft itself. Editing a recalled entry makes it the new draft.
    forgetRecall() {
        this.recalled = null;
        this.draft = '';
    }

    // At the first/last row, k/j step to an older/newer sent draft and, past
    // the newest, back to the draft. The cursor lands where moving on in the
    // same direction continues: the last line's start for k, the start for j.
    _recall(characters, cursor, key) {
        const older = key === 'k';
        const next = this.recalled === null ? (older ? this.sent.length - 1 : -1)
            : this.recalled + (older ? -1 : 1);
        if (next < 0 || (this.recalled === null && !older))
            return {characters, cursor, recalled: false};
        if (this.recalled === null)
            this.draft = characters.join('');
        this.recalled = next < this.sent.length ? next : null;
        const text = Array.from(this.recalled === null ? this.draft : this.sent[this.recalled]);
        const [start] = line(text, text.length);
        return {characters: text, cursor: older ? normal(text, start) : 0, recalled: true};
    }

    // Visual mode needs its anchor, so it never survives a reset.
    reset(mode = 'normal') {
        this.mode = mode === 'visual' ? 'normal' : mode;
        this.pending = '';
        this.history = [];
        this.column = null;
        this.anchor = null;
        this.head = null;
    }

    // Records any change since the last step (typing in insert mode, Ctrl+J,
    // sending) as one undo step, so a whole insert undoes at once like Vim.
    track(value, position) {
        if (this.saved && value !== this.saved.text) {
            this.undos.push(this.saved);
            if (this.undos.length > UNDO_LIMIT)
                this.undos.shift();
            this.redos = [];
        } else if (this.saved) {
            this.saved.cursor = position;
            return;
        }
        this.saved = {text: value, cursor: position};
    }

    // u and Ctrl+R move one step between the undo and redo stacks.
    _step(value, position, from, to) {
        const step = from.pop();
        if (step) {
            to.push({text: value, cursor: position});
            if (to.length > UNDO_LIMIT)
                to.shift();
            this.saved = {...step};
            this.reset();
        }
        const {text, cursor} = step ?? {text: value, cursor: position};
        const characters = Array.from(text);
        return {handled: true, text, cursor: normal(characters, cursor < 0 ? characters.length : cursor)};
    }

    // measure(position) optionally gives {x, y} in the rendered text layout.
    // In visual line mode, the result also has selection: [bound, cursor].
    // key is a character or a key name such as Escape or C-r (Ctrl+R).
    handle(value, position, key, measure = null) {
        const mode = this.mode === 'visual' && this.anchor === null ? 'normal' : this.mode;
        // Insert and replace mode keys are typing; their changes become a step
        // when the mode ends.
        if (!['insert', 'replace'].includes(mode) || key === 'Escape')
            this.track(value, position);
        if (mode === 'normal' && !this.pending && (key === 'u' || key === 'C-r'))
            return key === 'u' ? this._step(value, position, this.undos, this.redos)
                : this._step(value, position, this.redos, this.undos);
        const recalled = this.recalled;
        const result = this._command(value, position, key, measure);
        if (this.recalled === recalled && result.handled && result.text !== value)
            this.forgetRecall();
        // A command that enters insert or replace mode joins the typing after
        // it in a single step, which track() records on Escape.
        if (result.handled && ['normal', 'visual'].includes(this.mode))
            this.track(result.text, result.cursor);
        return result;
    }

    _command(value, position, key, measure) {
        let characters = Array.from(value);
        let cursor = position < 0 ? characters.length : position;
        if (this.mode === 'visual' && this.anchor === null)
            this.mode = 'normal';
        const visual = this.mode === 'visual';
        if (visual)
            cursor = this.head;
        // The selection covers whole displayed rows from the anchor to the cursor.
        const selected = () => {
            const [from] = row(characters, Math.min(this.anchor, this.head), measure);
            const [, to] = row(characters, Math.max(this.anchor, this.head), measure);
            return [from, to];
        };
        const result = () => {
            if (this.mode !== 'visual')
                return {handled: true, text: characters.join(''), cursor};
            this.head = cursor;
            let [from, to] = selected();
            // Show an empty row by highlighting its newline.
            if (from === to && to < characters.length)
                to++;
            return {handled: true, text: characters.join(''), cursor,
                selection: cursor < this.anchor ? [to, from] : [from, to]};
        };
        if (key === 'Escape') {
            if (this.mode !== 'normal' && !visual && cursor > 0 && characters[cursor - 1] !== '\n')
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
            if (command === 'gg') {
                cursor = firstNonBlank(characters, 0);
            } else if (visual) {
                // Visual mode only waits for gg.
            } else if (command === 'dd') {
                const [from, to] = row(characters, cursor, measure);
                cursor = deleteRows(characters, from, to);
            } else if (['ci', 'gu', 'gU', 'gui', 'gUi'].includes(command)) {
                this.pending = command;
            } else if (command === 'ciw') {
                const [start, end] = word(characters, cursor);
                characters.splice(start, end - start);
                cursor = start;
                this.reset('insert');
            } else if (command === 'guu' || command === 'gUU') {
                const [from, to] = row(characters, cursor, measure);
                changeCase(characters, from, to, command === 'gUU');
                cursor = normal(characters, cursor);
            } else if (command === 'guiw' || command === 'gUiw') {
                const [start, end] = word(characters, cursor);
                changeCase(characters, start, end, command === 'gUiw');
                cursor = start;
            } else if (command.startsWith('r') && Array.from(key).length === 1 &&
                key.codePointAt(0) >= 32 && characters.length) {
                characters[cursor] = key;
            }
            return result();
        }
        if (key === 'j' || key === 'k') {
            // Without a layout, use logical lines and count visible cells.
            const cells = [{x: 0, y: 0}];
            if (!measure) {
                for (const character of characters) {
                    const {x, y} = cells.at(-1);
                    cells.push(character === '\n' ? {x: 0, y: y + 1}
                        : {x: x + (mark(character) ? 0 : 1), y});
                }
            }
            const coords = measure ?? (position => cells[position]);
            const current = coords(cursor);
            // Like Vim, remember the wanted column across short lines.
            this.column = column ?? current.x;
            const rows = new Map();
            for (let position = 0; position <= normal(characters, characters.length); position++) {
                // Skip combining marks and nonempty lines' newline characters.
                // Empty lines (including a final blank line) remain reachable.
                if (mark(characters[position]) || (characters[position] === '\n' &&
                    position > 0 && characters[position - 1] !== '\n'))
                    continue;
                const {x, y} = coords(position);
                if (!rows.has(y))
                    rows.set(y, []);
                rows.get(y).push({position, x});
            }
            const heights = [...rows.keys()].sort((a, b) => a - b);
            const index = heights.indexOf(current.y);
            const target = rows.get(heights[index + (key === 'j' ? 1 : -1)]);
            if (index >= 0 && !target && !visual) {
                const recall = this._recall(characters, cursor, key);
                if (recall.recalled)
                    this.column = null;
                ({characters, cursor} = recall);
                return result();
            }
            if (index < 0 || !target)
                return result();
            let distance = Infinity;
            for (const {position, x} of target) {
                const offset = Math.abs(x - this.column);
                if (offset < distance) {
                    distance = offset;
                    cursor = position;
                }
            }
        } else if (key === 'G') {
            // Go to the last displayed row, so a wrapped last line still reaches the bottom.
            const [from] = row(characters, normal(characters, characters.length), measure);
            cursor = firstNonBlank(characters, from);
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
        } else if (key === 'g') {
            this.pending = key;
        } else if (visual) {
            const [from, to] = selected();
            if (['d', 'x', 'D', 'X'].includes(key)) {
                cursor = deleteRows(characters, from, to);
                this.reset();
            } else if (['c', 'C', 's', 'S'].includes(key)) {
                // Like Vim, changed lines leave one empty line to type on.
                characters.splice(from, to - from);
                cursor = from;
                this.reset('insert');
            } else if (key === 'u' || key === 'U') {
                changeCase(characters, from, to, key === 'U');
                this.reset();
                cursor = normal(characters, from);
            } else if (key === 'o') {
                [this.anchor, cursor] = [cursor, this.anchor];
            } else if (key === 'V') {
                this.reset();
            }
        } else if (key === 'V') {
            this.reset();
            this.mode = 'visual';
            this.anchor = cursor;
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
                cursor = line(characters, cursor)[1];
            else if (key === 'C')
                characters.splice(cursor);
        } else if (['d', 'c', 'r'].includes(key)) {
            this.pending = key;
        }
        return result();
    }
}
