// Source PNGs are copied unchanged from wfchat. Bounds exclude nearly transparent
// background pixels and align the visible figure without modifying the artwork.
export const EXPRESSIONS = Object.freeze({
    neutral: {file: 'aiko-neutral.png', width: 1086, height: 1448, bounds: [65, 60, 1034, 1405]},
    happy: {file: 'aiko-happy.png', width: 1254, height: 1254, bounds: [187, 88, 1052, 1084]},
    shy: {file: 'aiko-shy.png', width: 1122, height: 1402, bounds: [95, 60, 1009, 1347]},
    sad: {file: 'aiko-sad.png', width: 1122, height: 1402, bounds: [87, 58, 1044, 1357]},
    surprised: {file: 'aiko-surprised.png', width: 1254, height: 1254, bounds: [132, 40, 1109, 1254]},
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
