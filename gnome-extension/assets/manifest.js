// Kept for the layout geometry contract; Aiko itself is rendered from a live
// 3D triangle mesh by character3d.js and does not load portrait assets.
const VIEW_BOUNDS = [0, 0, 200, 260];

export const EXPRESSIONS = Object.freeze({
    neutral: {width: 200, height: 260, bounds: VIEW_BOUNDS},
    happy: {width: 200, height: 260, bounds: VIEW_BOUNDS},
    shy: {width: 200, height: 260, bounds: VIEW_BOUNDS},
    sad: {width: 200, height: 260, bounds: VIEW_BOUNDS},
    surprised: {width: 200, height: 260, bounds: VIEW_BOUNDS},
});

export function imageGeometry(expression, width, height) {
    const [left, top, right, bottom] = expression.bounds;
    const scale = Math.min((width - 8) / (right - left), (height - 8) / (bottom - top));
    return {
        width: expression.width * scale,
        height: expression.height * scale,
        x: (width - (right - left) * scale) / 2 - left * scale,
        y: height - 4 - bottom * scale,
    };
}
