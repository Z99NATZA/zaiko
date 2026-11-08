// Reveals a reply a few characters at a time. It steps by grapheme, so a Thai
// vowel or tone mark never appears apart from the letter it belongs to.
export const TICK_MS = 30;
const RATE = 50; // characters per second for short replies
const MAX_MS = 2500; // long replies speed up to finish within this time

export function graphemes(text) {
    return Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text), item => item.segment);
}

export class Typewriter {
    constructor(text) {
        this._parts = graphemes(text);
        this._shown = 0;
        this._step = Math.max(RATE * TICK_MS / 1000, this._parts.length * TICK_MS / MAX_MS);
    }

    // Number of whole characters visible now.
    get count() {
        return Math.floor(this._shown);
    }

    get text() {
        return this._parts.slice(0, this.count).join('');
    }

    get done() {
        return this.count >= this._parts.length;
    }

    advance() {
        this._shown = Math.min(this._parts.length, this._shown + this._step);
        return this.done;
    }
}

// The first characters of `text`, counted by grapheme.
export function firstGraphemes(text, count) {
    return graphemes(text).slice(0, Math.max(0, count)).join('');
}
