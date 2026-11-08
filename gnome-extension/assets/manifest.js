// Frames are cut from a chibi sticker sheet by scripts/slice_sheet.py. Every PNG
// shares one canvas with the body centred and resting on the bottom edge, so all
// frames draw at the same scale and anchor.
export const FRAME = Object.freeze({width: 381, height: 290});

// Each mood picks one of its frames at random when the mood changes.
export const EXPRESSIONS = Object.freeze({
    neutral: ['idle.png', 'coffee.png', 'peek.png', 'sleepy.png'],
    thinking: ['question.png', 'ponder.png'],
    working: ['working.png'],
    happy: ['cheer.png', 'wink.png', 'cool.png', 'love.png', 'shy.png'],
    error: ['cry.png', 'panic.png', 'shocked.png', 'pout.png'],
});

export function pickFrame(mood, previous = null, random = Math.random) {
    const frames = EXPRESSIONS[mood] ?? EXPRESSIONS.neutral;
    const choices = frames.length > 1 ? frames.filter(frame => frame !== previous) : frames;
    return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

export function imageGeometry(width, height) {
    const scale = Math.min((width - 8) / FRAME.width, (height - 4) / FRAME.height);
    return {
        width: FRAME.width * scale,
        height: FRAME.height * scale,
        x: (width - FRAME.width * scale) / 2,
        y: height - FRAME.height * scale,
    };
}

// Character sizes 1-5 cycle from the character menu; 3 is the default.
export const CHARACTER_SIZES = Object.freeze([1, 2, 3, 4, 5]);
export const DEFAULT_CHARACTER_SIZE = 3;
const SIZE_WIDTHS = Object.freeze({1: 208, 2: 260, 3: 312, 4: 390, 5: 468});

export function normalizeCharacterSize(value) {
    const size = Number(String(value ?? '').trim());
    return CHARACTER_SIZES.includes(size) ? size : DEFAULT_CHARACTER_SIZE;
}

export function nextCharacterSize(size) {
    const index = CHARACTER_SIZES.indexOf(normalizeCharacterSize(size));
    return CHARACTER_SIZES[(index + 1) % CHARACTER_SIZES.length];
}

// The character box fits a frame with the margins imageGeometry keeps.
export function characterBox(size) {
    const width = SIZE_WIDTHS[normalizeCharacterSize(size)];
    return {width, height: Math.round((width - 8) * FRAME.height / FRAME.width) + 4};
}
